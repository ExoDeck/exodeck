package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ExoDeck/exodeck/internal/config"
	"github.com/ExoDeck/exodeck/internal/handlers"
	"github.com/ExoDeck/exodeck/internal/models"
	"github.com/ExoDeck/exodeck/internal/storage"
)

// ResolveConfigDir determines the working directory for configuration, data, and cache.
// If explicit is non-empty (e.g. from -cl / --config-location), it is cleaned and returned.
// Otherwise, it returns ~/.exodeck ($HOME/.exodeck on Unix/macOS, %USERPROFILE%\.exodeck on Windows).
func ResolveConfigDir(explicit string) (string, error) {
	if explicit != "" {
		return filepath.Clean(explicit), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("determining user home directory: %w", err)
	}
	return filepath.Join(home, ".exodeck"), nil
}

func main() {
	var configLocation string
	flag.StringVar(&configLocation, "cl", "", "Directory for config.json, cache, and data/ (defaults to ~/.exodeck or $HOME/.exodeck)")
	flag.StringVar(&configLocation, "config-location", "", "Directory for config.json, cache, and data/ (defaults to ~/.exodeck or $HOME/.exodeck)")
	flag.Parse()

	var err error
	configLocation, err = ResolveConfigDir(configLocation)
	if err != nil {
		log.Fatalf("could not determine configuration directory: %v", err)
	}

	if err := os.MkdirAll(configLocation, 0755); err != nil {
		log.Fatalf("creating configuration directory: %v", err)
	}

	defaultDataDir := filepath.Join(configLocation, "data")
	if err := os.MkdirAll(defaultDataDir, 0755); err != nil {
		log.Fatalf("creating default data directory: %v", err)
	}

	// First-run: create config.json if absent
	if err := config.EnsureDefaults(configLocation); err != nil {
		log.Fatalf("initialising defaults: %v", err)
	}

	// Load configuration
	cfg, err := config.Load(configLocation)
	if err != nil {
		log.Fatalf("loading config: %v", err)
	}

	// Setup logging
	logFile := setupLogger(cfg, configLocation)
	if logFile != nil {
		defer func() {
			_ = logFile.Close()
		}()
	}

	// Initialise storage
	locs, order, err := storage.ParseWorkspaces(cfg.Workspaces, defaultDataDir, configLocation)
	if err != nil {
		log.Fatalf("parsing workspaces: %v", err)
	}
	if len(order) == 0 {
		locs["Default"] = storage.WorkspaceConfig{Path: defaultDataDir}
		order = append(order, "Default")
	}

	store := storage.New(DocsFS, configLocation)
	store.SetWorkspaces(locs, order)

	// Build HTTP server
	srv := &handlers.Server{
		Store:      store,
		ConfigDir:  configLocation,
		FrontendFS: FrontendFS,
	}

	router := handlers.NewRouter(srv)
	addr := fmt.Sprintf(":%d", cfg.Port)

	printBanner(Version)
	log.Printf("ExoDeck listening on http://localhost%s", addr)

	httpSrv := &http.Server{Addr: addr, Handler: router}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	serverErr := make(chan error, 1)
	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	select {
	case err := <-serverErr:
		errStr := err.Error()
		if strings.Contains(errStr, "bind") || strings.Contains(errStr, "address already in use") || strings.Contains(errStr, "Only one usage of each socket address") {
			log.Fatalf("Port %d is already in use. Another instance of ExoDeck may already be running, or another program is using this port: %v", cfg.Port, err)
		}
		log.Fatalf("server error: %v", err)
	case sig := <-stop:
		log.Printf("Received signal %v, shutting down ExoDeck gracefully...", sig)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpSrv.Shutdown(shutdownCtx); err != nil {
			log.Printf("server shutdown error: %v", err)
		}
		log.Println("ExoDeck stopped.")
	}
}

func printBanner(version string) {
	fmt.Print(`
  ______           _____            _    
 |  ____|         |  __ \          | |   
 | |__  __  _____ | |  | | ___  ___| | __
 |  __| \ \/ / _ \| |  | |/ _ \/ __| |/ /
 | |____ >  < (_) | |__| |  __/ (__|   < 
 |______/_/\_\___/|_____/ \___|\___|_|\_\

`)
	fmt.Printf("  version %s\n\n", version)
}

func setupLogger(cfg models.ConfigModel, configDir string) *os.File {
	var level slog.Level
	switch strings.ToLower(cfg.LogLevel) {
	case "debug":
		level = slog.LevelDebug
	case "info":
		level = slog.LevelInfo
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{
		Level: level,
	}

	var handler slog.Handler
	var logFile *os.File
	var writer io.Writer = os.Stdout

	if cfg.LogFile != "" {
		logPath := cfg.LogFile
		if !filepath.IsAbs(logPath) {
			logPath = filepath.Join(configDir, logPath)
		}
		if err := os.MkdirAll(filepath.Dir(logPath), 0755); err != nil {
			log.Fatalf("error creating log directory: %v", err)
		}
		f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			log.Fatalf("error opening log file %s: %v", logPath, err)
		}
		logFile = f
		writer = io.MultiWriter(os.Stdout, f)
	}

	// Use TextHandler for console/mixed output, or JSONHandler if preferred. We'll use TextHandler for both.
	handler = slog.NewTextHandler(writer, opts)

	logger := slog.New(handler)
	slog.SetDefault(logger)
	slog.Debug("Logger initialized", "level", cfg.LogLevel)
	return logFile
}
