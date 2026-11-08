package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ExoDeck/exodeck/internal/models"
)

func TestPrintBanner(t *testing.T) {
	printBanner("1.2.3")
}

func TestResolveConfigDir(t *testing.T) {
	// Explicit path should be cleaned and returned as-is
	customDir := filepath.Join("custom", "config", "path")
	resolved, err := ResolveConfigDir(customDir)
	if err != nil {
		t.Fatalf("ResolveConfigDir(customDir): %v", err)
	}
	if resolved != filepath.Clean(customDir) {
		t.Errorf("ResolveConfigDir got %q, want %q", resolved, filepath.Clean(customDir))
	}

	// Empty string should default to ~/.exodeck
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	defaultDir, err := ResolveConfigDir("")
	if err != nil {
		t.Fatalf("ResolveConfigDir(\"\"): %v", err)
	}
	wantDefault := filepath.Join(home, ".exodeck")
	if defaultDir != wantDefault {
		t.Errorf("ResolveConfigDir(\"\") got %q, want %q", defaultDir, wantDefault)
	}
}

func TestSetupLogger(t *testing.T) {
	configDir := t.TempDir()

	// Console logger with various levels
	levels := []string{"debug", "info", "warn", "error", "unknown"}
	for _, lvl := range levels {
		f := setupLogger(models.ConfigModel{LogLevel: lvl}, configDir)
		if f != nil {
			t.Errorf("expected nil file for console logger")
		}
	}

	// Absolute log file path
	absLogPath := filepath.Join(configDir, "abs_test.log")
	f := setupLogger(models.ConfigModel{LogLevel: "debug", LogFile: absLogPath}, configDir)
	if f == nil {
		t.Fatalf("expected non-nil file for absolute log file")
	}
	_ = f.Close()

	// Relative log file path (should resolve inside configDir)
	relLogFile := filepath.Join("logs", "rel_test.log")
	fRel := setupLogger(models.ConfigModel{LogLevel: "info", LogFile: relLogFile}, configDir)
	if fRel == nil {
		t.Fatalf("expected non-nil file for relative log file")
	}
	_ = fRel.Close()

	expectedPath := filepath.Join(configDir, relLogFile)
	if _, err := os.Stat(expectedPath); err != nil {
		t.Errorf("expected relative log file at %s: %v", expectedPath, err)
	}
}
