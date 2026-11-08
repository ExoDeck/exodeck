package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ExoDeck/exodeck/internal/models"
)

const configFileName = "config.json"

// Defaults returns a ConfigModel populated with application defaults.
func Defaults() models.ConfigModel {
	return models.ConfigModel{
		Theme:            "dark",
		GroupboxMaxWidth: 420,
		FontSizeUI:       14,
		FontSizeNote:     16,
		FontSizeLinks:    14,
		Port:             8000,
		Workspaces:       []interface{}{},
		EnableGitSync:    false,
		LogLevel:         "info",
		LogFile:          "",
	}
}

// Load reads config.json from dir, merging file values over defaults.
// If config.json does not exist the defaults are returned without error.
func Load(dir string) (models.ConfigModel, error) {
	cfg := Defaults()
	path := filepath.Join(dir, configFileName)

	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return cfg, fmt.Errorf("reading config: %w", err)
	}

	// Unmarshal into a raw map so we only override keys that are present in the file.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return cfg, fmt.Errorf("parsing config: %w", err)
	}

	if v, ok := raw["theme"]; ok {
		_ = json.Unmarshal(v, &cfg.Theme)
	}
	if v, ok := raw["groupbox_max_width"]; ok {
		_ = json.Unmarshal(v, &cfg.GroupboxMaxWidth)
	}
	if v, ok := raw["font_size_ui"]; ok {
		_ = json.Unmarshal(v, &cfg.FontSizeUI)
	}
	if v, ok := raw["font_size_note"]; ok {
		_ = json.Unmarshal(v, &cfg.FontSizeNote)
	}
	if v, ok := raw["font_size_links"]; ok {
		_ = json.Unmarshal(v, &cfg.FontSizeLinks)
	}
	if v, ok := raw["port"]; ok {
		_ = json.Unmarshal(v, &cfg.Port)
	}
	if v, ok := raw["enable_git_sync"]; ok {
		_ = json.Unmarshal(v, &cfg.EnableGitSync)
	}
	if v, ok := raw["workspaces"]; ok {
		var dl any
		if err := json.Unmarshal(v, &dl); err == nil {
			cfg.Workspaces = dl
		}
	}
	if v, ok := raw["log_level"]; ok {
		_ = json.Unmarshal(v, &cfg.LogLevel)
	}
	if v, ok := raw["log_file"]; ok {
		_ = json.Unmarshal(v, &cfg.LogFile)
	}

	return cfg, nil
}

// Save writes cfg as JSON to dir/config.json, creating the directory if needed.
func Save(dir string, cfg models.ConfigModel) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating config dir: %w", err)
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshalling config: %w", err)
	}
	path := filepath.Join(dir, configFileName)
	return os.WriteFile(path, data, 0o644)
}

// EnsureDefaults writes config.json the first time the
// binary runs (i.e. when config.json is absent). It is idempotent.
func EnsureDefaults(dir string) error {
	path := filepath.Join(dir, configFileName)
	if _, err := os.Stat(path); err == nil {
		// config.json already exists — nothing to do
		return nil
	}

	// Write default config
	if err := Save(dir, Defaults()); err != nil {
		return err
	}

	return nil
}
