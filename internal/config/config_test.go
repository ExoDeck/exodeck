package config_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/ExoDeck/exodeck/internal/config"
	"github.com/ExoDeck/exodeck/internal/models"
)

func TestDefaultsHaveExpectedValues(t *testing.T) {
	d := config.Defaults()
	if d.Port != 8000 {
		t.Errorf("default port = %d, want 8000", d.Port)
	}
	if d.Theme != "dark" {
		t.Errorf("default theme = %q, want dark", d.Theme)
	}
	if d.GroupboxMaxWidth != 420 {
		t.Errorf("default groupbox_max_width = %d, want 420", d.GroupboxMaxWidth)
	}
	if d.EnableGitSync {
		t.Error("default enable_git_sync should be false")
	}
	if ws, ok := d.Workspaces.([]interface{}); !ok || len(ws) != 0 {
		t.Errorf("default workspaces should be empty slice, got %+v", d.Workspaces)
	}
}

func TestLoadReturnsDefaultsWhenNoFile(t *testing.T) {
	dir := t.TempDir()
	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := config.Defaults()
	if cfg.Port != want.Port || cfg.Theme != want.Theme {
		t.Errorf("got %+v, want defaults %+v", cfg, want)
	}
}

func TestLoadMergesFileOverDefaults(t *testing.T) {
	dir := t.TempDir()
	raw := map[string]interface{}{
		"port":               9000,
		"theme":              "light",
		"groupbox_max_width": 550,
		"font_size_ui":       16,
		"font_size_note":     18,
		"font_size_links":    15,
		"enable_git_sync":    true,
		"workspaces":         []interface{}{"ws1", "ws2"},
		"log_level":          "debug",
		"log_file":           "startgrd.log",
	}
	data, _ := json.Marshal(raw)
	_ = os.WriteFile(filepath.Join(dir, "config.json"), data, 0o644)

	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Port != 9000 || cfg.Theme != "light" || cfg.GroupboxMaxWidth != 550 || cfg.FontSizeUI != 16 ||
		cfg.FontSizeNote != 18 || cfg.FontSizeLinks != 15 || !cfg.EnableGitSync || cfg.LogLevel != "debug" ||
		cfg.LogFile != "startgrd.log" || cfg.Workspaces == nil {
		t.Errorf("fields not merged properly: %+v", cfg)
	}
}

func TestLoadCorruptConfig(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "config.json"), []byte("{corrupt-json"), 0o644)
	_, err := config.Load(dir)
	if err == nil {
		t.Error("expected error loading corrupt config")
	}
}

func TestSaveRoundtrip(t *testing.T) {
	dir := t.TempDir()
	cfg := models.ConfigModel{
		Theme:            "light",
		GroupboxMaxWidth: 500,
		FontSizeUI:       18,
		FontSizeNote:     20,
		FontSizeLinks:    16,
		Port:             9876,
		EnableGitSync:    true,
	}
	if err := config.Save(dir, cfg); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := config.Load(dir)
	if err != nil {
		t.Fatalf("Load after Save: %v", err)
	}
	if loaded.Port != 9876 || loaded.Theme != "light" || !loaded.EnableGitSync {
		t.Errorf("roundtrip mismatch: %+v", loaded)
	}
}

func TestEnsureDefaultsCreatesFilesOnFirstRun(t *testing.T) {
	dir := t.TempDir()

	if err := config.EnsureDefaults(dir); err != nil {
		t.Fatalf("EnsureDefaults: %v", err)
	}

	// config.json must exist
	if _, err := os.Stat(filepath.Join(dir, "config.json")); err != nil {
		t.Error("config.json was not created")
	}
}

func TestEnsureDefaultsIsIdempotent(t *testing.T) {
	dir := t.TempDir()

	_ = config.EnsureDefaults(dir)

	// Write a custom config so we can detect if EnsureDefaults overwrites it
	custom := map[string]interface{}{"port": 7777}
	data, _ := json.Marshal(custom)
	_ = os.WriteFile(filepath.Join(dir, "config.json"), data, 0o644)

	_ = config.EnsureDefaults(dir) // second call — must be no-op

	cfg, _ := config.Load(dir)
	if cfg.Port != 7777 {
		t.Errorf("EnsureDefaults overwrote existing config (port = %d, want 7777)", cfg.Port)
	}
}
