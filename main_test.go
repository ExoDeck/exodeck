package main

import (
	"encoding/base64"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

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

func TestEmbeddedHelpGrid(t *testing.T) {
	var foundHelpGrid bool
	err := fs.WalkDir(DocsFS, "docs", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if strings.EqualFold(filepath.Ext(d.Name()), ".md") {
			t.Errorf("unexpected legacy markdown file in embedded docs: %s", p)
		}
		if p == "docs/help.grid" {
			foundHelpGrid = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("WalkDir(DocsFS, docs): %v", err)
	}
	if !foundHelpGrid {
		t.Fatalf("expected docs/help.grid in embedded DocsFS")
	}

	raw, err := fs.ReadFile(DocsFS, "docs/help.grid")
	if err != nil {
		t.Fatalf("fs.ReadFile(DocsFS, docs/help.grid): %v", err)
	}

	var page models.Page
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatalf("json.Unmarshal(help.grid): %v", err)
	}
	if page.PageName != "Help" {
		t.Errorf("page.PageName = %q, want %q", page.PageName, "Help")
	}
	if len(page.Groups) != 4 {
		t.Fatalf("len(page.Groups) = %d, want 4", len(page.Groups))
	}
	if page.Groups[0].Title != "Welcome" || page.Groups[0].Type == nil || *page.Groups[0].Type != "sticky" {
		t.Errorf("expected first group to be sticky note titled Welcome, got %+v", page.Groups[0])
	}

	noteItems := 0
	for _, grp := range page.Groups[1:] {
		for _, item := range grp.Items {
			if item.Text == nil || strings.TrimSpace(*item.Text) == "" {
				t.Errorf("group %q item %q has empty text", grp.Title, item.Title)
				continue
			}
			decoded, err := base64.StdEncoding.DecodeString(*item.Text)
			if err != nil {
				t.Errorf("group %q item %q invalid base64: %v", grp.Title, item.Title, err)
				continue
			}
			if !utf8.Valid(decoded) || len(strings.TrimSpace(string(decoded))) == 0 {
				t.Errorf("group %q item %q decoded text is empty or invalid UTF-8", grp.Title, item.Title)
			}
			if strings.Contains(string(decoded), ".md)") {
				t.Errorf("group %q item %q contains dangling .md) link", grp.Title, item.Title)
			}
			noteItems++
		}
	}
	if noteItems != 9 {
		t.Errorf("total help note items = %d, want 9", noteItems)
	}
}
