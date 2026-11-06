package main

import (
	"path/filepath"
	"testing"

	"github.com/ExoDeck/exodeck/internal/models"
)

func TestPrintBanner(t *testing.T) {
	printBanner("1.2.3")
}

func TestSetupLogger(t *testing.T) {
	// Console logger with various levels
	levels := []string{"debug", "info", "warn", "error", "unknown"}
	for _, lvl := range levels {
		f := setupLogger(models.ConfigModel{LogLevel: lvl})
		if f != nil {
			t.Errorf("expected nil file for console logger")
		}
	}

	// File logger
	dir := t.TempDir()
	logPath := filepath.Join(dir, "test.log")
	f := setupLogger(models.ConfigModel{LogLevel: "debug", LogFile: logPath})
	if f == nil {
		t.Fatalf("expected non-nil file for file logger")
	}
	_ = f.Close()
}
