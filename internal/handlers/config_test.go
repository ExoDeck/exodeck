package handlers_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// --------------------------------------------------------------------------
// Config API
// --------------------------------------------------------------------------

func TestGetConfigReturnsDefaultsWhenNoFile(t *testing.T) {
	ts, _, _, _ := newTestServerFull(t)

	code, body := get(t, ts, "/api/v1/config")
	if code != http.StatusOK {
		t.Fatalf("GET config: %d", code)
	}
	for _, key := range []string{"theme", "port", "groupbox_max_width", "font_size_ui", "vault_timeout_minutes", "enable_git_sync"} {
		if _, ok := body[key]; !ok {
			t.Errorf("config missing key %q", key)
		}
	}
	if body["vault_timeout_minutes"] != float64(15) {
		t.Errorf("vault_timeout_minutes = %v, want 15", body["vault_timeout_minutes"])
	}
}

func TestGetConfigReturnsPersistedValues(t *testing.T) {
	ts, _, _, configDir := newTestServerFull(t)

	// Write a partial config before GET
	partial := map[string]interface{}{"port": 9999, "theme": "light"}
	data, _ := json.Marshal(partial)
	_ = os.WriteFile(filepath.Join(configDir, "config.json"), data, 0o644)

	_, body := get(t, ts, "/api/v1/config")
	if body["port"] != float64(9999) {
		t.Errorf("port = %v, want 9999", body["port"])
	}
	if body["theme"] != "light" {
		t.Errorf("theme = %v, want light", body["theme"])
	}
	// Default key still present
	if body["groupbox_max_width"] == nil {
		t.Error("groupbox_max_width missing after partial config")
	}
	if body["vault_timeout_minutes"] != float64(15) {
		t.Errorf("vault_timeout_minutes = %v, want 15 when unset", body["vault_timeout_minutes"])
	}
}

func TestPutConfigPersistsAndReturnsUpdated(t *testing.T) {
	ts, _, _, configDir := newTestServerFull(t)

	update := map[string]interface{}{"theme": "light", "groupbox_max_width": 380}
	code, body := put(t, ts, "/api/v1/config", update)
	if code != http.StatusOK {
		t.Fatalf("PUT config: %d %v", code, body)
	}
	if body["theme"] != "light" {
		t.Errorf("theme = %v", body["theme"])
	}

	// Verify file was written
	if _, err := os.Stat(filepath.Join(configDir, "config.json")); err != nil {
		t.Error("config.json not written after PUT")
	}
}

func TestPutConfigInvalidPayloadReturns422(t *testing.T) {
	ts, _, _, _ := newTestServerFull(t)

	// groupbox_max_width must be int, send a string
	update := map[string]interface{}{"groupbox_max_width": "not-a-number"}
	code, _ := put(t, ts, "/api/v1/config", update)
	if code != 422 {
		t.Errorf("expected 422 for invalid payload, got %d", code)
	}
}

func TestPutConfigInvalidWorkspaces(t *testing.T) {
	ts, _, _, _ := newTestServerFull(t)

	// Workspaces slice with non-object entry
	update := map[string]interface{}{"workspaces": []interface{}{"not-an-object"}}
	code, _ := put(t, ts, "/api/v1/config", update)
	if code != 422 {
		t.Errorf("expected 422 for invalid workspaces, got %d", code)
	}
}

func TestPutConfigMalformedJSONReturns422(t *testing.T) {
	ts, _, _, _ := newTestServerFull(t)

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", strings.NewReader("{invalid-json"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 422 {
		t.Errorf("expected 422 for malformed json, got %d", resp.StatusCode)
	}
}

func TestGetAndPutConfigCorruptFileReturns500(t *testing.T) {
	ts, _, _, configDir := newTestServerFull(t)

	// Write corrupted config.json
	_ = os.WriteFile(filepath.Join(configDir, "config.json"), []byte("{corrupt-json"), 0o644)

	code, _ := get(t, ts, "/api/v1/config")
	if code != http.StatusInternalServerError {
		t.Errorf("expected 500 for GET with corrupt config.json, got %d", code)
	}

	codePut, _ := put(t, ts, "/api/v1/config", map[string]interface{}{"theme": "light"})
	if codePut != http.StatusInternalServerError {
		t.Errorf("expected 500 for PUT with corrupt config.json, got %d", codePut)
	}
}

func TestPutConfigUpdatesVaultTimeoutImmediately(t *testing.T) {
	ts, _, dataDir, _ := newTestServerFull(t)

	// Setup and unlock vault
	setupCode, _ := post(t, ts, "/api/v1/workspaces/default/vault/setup", map[string]string{"password": "MasterPassword123!"})
	if setupCode != http.StatusOK {
		t.Fatalf("vault setup: %d", setupCode)
	}

	workspaces := []map[string]interface{}{{"name": "default", "path": dataDir}}

	// Update vault_timeout_minutes to 45
	code, body := put(t, ts, "/api/v1/config", map[string]interface{}{
		"vault_timeout_minutes": 45,
		"workspaces":            workspaces,
	})
	if code != http.StatusOK {
		t.Fatalf("PUT config: %d %v", code, body)
	}
	if body["vault_timeout_minutes"] != float64(45) {
		t.Errorf("vault_timeout_minutes = %v, want 45", body["vault_timeout_minutes"])
	}

	statusCode, statusBody := get(t, ts, "/api/v1/workspaces/default/vault/status")
	if statusCode != http.StatusOK {
		t.Fatalf("GET vault status: %d %v", statusCode, statusBody)
	}
	expiresIn, _ := statusBody["expires_in_seconds"].(float64)
	if expiresIn <= 15*60 {
		t.Errorf("expected expires_in_seconds > 900 after setting timeout to 45m, got %v", expiresIn)
	}

	// Non-positive timeout falls back to 15
	code2, body2 := put(t, ts, "/api/v1/config", map[string]interface{}{
		"vault_timeout_minutes": 0,
		"workspaces":            workspaces,
	})
	if code2 != http.StatusOK {
		t.Fatalf("PUT config fallback: %d %v", code2, body2)
	}
	if body2["vault_timeout_minutes"] != float64(15) {
		t.Errorf("vault_timeout_minutes fallback = %v, want 15", body2["vault_timeout_minutes"])
	}
}
