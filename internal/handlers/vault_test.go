package handlers_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/ExoDeck/exodeck/internal/handlers"
	"github.com/ExoDeck/exodeck/internal/models"
	"github.com/ExoDeck/exodeck/internal/storage"
	"github.com/ExoDeck/exodeck/internal/vault"
)

func newTestVaultServer(t *testing.T, dataDir string) (*storage.Store, *vault.Manager, *httptest.Server) {
	t.Helper()
	store := storage.New(fstest.MapFS{}, dataDir)
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: dataDir},
	}, []string{"default"})

	v := vault.New(15 * time.Minute)
	srv := &handlers.Server{
		Store:      store,
		Vault:      v,
		ConfigDir:  dataDir,
		FrontendFS: stubFrontendFS,
	}
	ts := httptest.NewServer(handlers.NewRouter(srv))
	t.Cleanup(ts.Close)
	return store, v, ts
}

func mapToPage(m map[string]interface{}) models.Page {
	data, _ := json.Marshal(m)
	var p models.Page
	_ = json.Unmarshal(data, &p)
	return p
}

func TestVaultStatusSetupLockUnlock(t *testing.T) {
	dataDir := t.TempDir()
	_, _, ts := newTestVaultServer(t, dataDir)

	// 1. Initial status -> not configured
	status, body := get(t, ts, "/api/v1/workspaces/default/vault/status")
	if status != http.StatusOK {
		t.Fatalf("status returned %d: %v", status, body)
	}
	if body["configured"] != false || body["unlocked"] != false {
		t.Errorf("expected not configured and not unlocked, got: %v", body)
	}

	// 2. Setup vault
	status, body = post(t, ts, "/api/v1/workspaces/default/vault/setup", map[string]string{
		"password": "MasterPassword123!",
	})
	if status != http.StatusOK {
		t.Fatalf("setup returned %d: %v", status, body)
	}

	// 3. Status is now configured and unlocked
	status, body = get(t, ts, "/api/v1/workspaces/default/vault/status")
	if status != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", status)
	}
	if body["configured"] != true || body["unlocked"] != true {
		t.Errorf("expected configured and unlocked, got: %v", body)
	}

	// 4. Lock vault
	status, _ = post(t, ts, "/api/v1/workspaces/default/vault/lock", nil)
	if status != http.StatusOK {
		t.Fatalf("lock returned %d", status)
	}

	status, body = get(t, ts, "/api/v1/workspaces/default/vault/status")
	if status != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", status)
	}
	if body["unlocked"] != false {
		t.Errorf("expected locked, got: %v", body)
	}

	// 5. Unlock with wrong password fails
	status, _ = post(t, ts, "/api/v1/workspaces/default/vault/unlock", map[string]string{
		"password": "WrongPassword",
	})
	if status != http.StatusUnauthorized {
		t.Errorf("expected 401 for wrong password, got %d", status)
	}

	// 6. Unlock with correct password succeeds
	status, _ = post(t, ts, "/api/v1/workspaces/default/vault/unlock", map[string]string{
		"password": "MasterPassword123!",
	})
	if status != http.StatusOK {
		t.Errorf("expected 200 for correct password, got %d", status)
	}

	// 7. Verify bootstrap reflects unlocked vault and expiresIn
	status, body = get(t, ts, "/api/v1/bootstrap")
	if status != http.StatusOK {
		t.Fatalf("bootstrap returned %d", status)
	}
	vaultMap, ok := body["vault_status"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected vault_status map in bootstrap")
	}
	defaultVault, ok := vaultMap["default"].(map[string]interface{})
	if !ok || defaultVault["unlocked"] != true {
		t.Errorf("expected default workspace vault to be unlocked in bootstrap: %v", defaultVault)
	}
}

func TestVaultItemEncryptionAndMaskingWhenLocked(t *testing.T) {
	dataDir := t.TempDir()
	store, _, ts := newTestVaultServer(t, dataDir)

	// Create initial page
	store.WritePage("secrets", models.Page{
		PageName: "Secrets",
		Groups: []models.Group{
			{Title: "Logins", Items: []models.Item{}},
		},
	}, "default")

	// Setup vault with master password
	post(t, ts, "/api/v1/workspaces/default/vault/setup", map[string]string{
		"password": "MasterPassword123!",
	})

	// Add password item
	pwPlain := "TopSecretPassword"
	userPlain := "myuser"
	status, body := post(t, ts, "/api/v1/pages/secrets/groups/0/items?location=default", models.Item{
		Title:    "Admin",
		Password: &pwPlain,
		Username: &userPlain,
	})
	if status != http.StatusCreated {
		t.Fatalf("add item returned %d: %v", status, body)
	}

	// Verify on-disk file has encrypted values starting with "v1:"
	raw, _ := os.ReadFile(filepath.Join(dataDir, "secrets.grid"))
	rawStr := string(raw)
	if strings.Contains(rawStr, pwPlain) {
		t.Errorf("plaintext password found on disk")
	}
	if strings.Contains(rawStr, userPlain) {
		t.Errorf("plaintext username found on disk")
	}
	if !strings.Contains(rawStr, "v1:") {
		t.Errorf("expected v1: AES-GCM ciphertext on disk")
	}

	// Read page while unlocked -> values are decrypted
	status, body = get(t, ts, "/api/v1/pages/secrets?location=default")
	if status != http.StatusOK {
		t.Fatalf("getPage returned %d", status)
	}
	page := mapToPage(body)
	if len(page.Groups[0].Items) != 1 {
		t.Fatalf("expected 1 item")
	}
	item := page.Groups[0].Items[0]
	if item.Password == nil || *item.Password != pwPlain {
		t.Errorf("expected decrypted password %q, got %v", pwPlain, item.Password)
	}
	if item.Username == nil || *item.Username != userPlain {
		t.Errorf("expected decrypted username %q, got %v", userPlain, item.Username)
	}
	if item.Locked != nil && *item.Locked {
		t.Errorf("item should not be locked when vault is unlocked")
	}

	// Lock vault
	post(t, ts, "/api/v1/workspaces/default/vault/lock", nil)

	// Read page while locked -> items are masked and marked locked
	status, body = get(t, ts, "/api/v1/pages/secrets?location=default")
	if status != http.StatusOK {
		t.Fatalf("getPage returned %d", status)
	}
	page = mapToPage(body)
	lockedItem := page.Groups[0].Items[0]
	if lockedItem.Locked == nil || !*lockedItem.Locked {
		t.Errorf("expected item.Locked = true")
	}
	if lockedItem.Password == nil || *lockedItem.Password != "•••••••" {
		t.Errorf("expected masked password, got %v", lockedItem.Password)
	}

	// Writing sensitive item while locked returns 423 Locked
	status, _ = post(t, ts, "/api/v1/pages/secrets/groups/0/items?location=default", models.Item{
		Title:    "AnotherSecret",
		Password: &pwPlain,
	})
	if status != http.StatusLocked {
		t.Errorf("expected 423 Locked when saving password into locked vault, got %d", status)
	}
}

func TestMigrateFernetToVault(t *testing.T) {
	dataDir := t.TempDir()
	const oldFernetKey = "cRPBMKMEPHyNh-hWFKn6G4b3mM_x3PW5yqPbxwU3Ue4="

	store := storage.New(fstest.MapFS{}, dataDir)
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"legacy": {Path: dataDir, FernetKey: oldFernetKey},
	}, []string{"legacy"})

	v := vault.New(15 * time.Minute)
	srv := &handlers.Server{
		Store:      store,
		Vault:      v,
		ConfigDir:  dataDir,
		FrontendFS: stubFrontendFS,
	}
	ts := httptest.NewServer(handlers.NewRouter(srv))
	t.Cleanup(ts.Close)

	// Create page with Fernet-encrypted password
	pwPlain := "LegacySecretPassword"
	store.WritePage("legacy-page", models.Page{
		PageName: "Legacy Page",
		Groups: []models.Group{
			{Title: "Group 1", Items: []models.Item{}},
		},
	}, "legacy")

	post(t, ts, "/api/v1/pages/legacy-page/groups/0/items?location=legacy", models.Item{
		Title:    "LegacyLogin",
		Password: &pwPlain,
	})

	// Check on disk has Fernet token (starts with gAAAAA)
	raw, _ := os.ReadFile(filepath.Join(dataDir, "legacy-page.grid"))
	if !strings.Contains(string(raw), "gAAAAA") {
		t.Errorf("expected Fernet token on disk before migration")
	}

	// Call migrate-fernet endpoint
	status, body := post(t, ts, "/api/v1/workspaces/legacy/vault/migrate-fernet", map[string]string{
		"password": "NewMasterPassword123!",
	})
	if status != http.StatusOK {
		t.Fatalf("migrate-fernet returned %d: %v", status, body)
	}

	// Check on disk now has AES-GCM token (starts with v1:)
	rawAfter, _ := os.ReadFile(filepath.Join(dataDir, "legacy-page.grid"))
	if !strings.Contains(string(rawAfter), "v1:") {
		t.Errorf("expected v1: AES-GCM token on disk after migration")
	}

	// Verify we can read decrypted password now
	status, body = get(t, ts, "/api/v1/pages/legacy-page?location=legacy")
	if status != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", status)
	}
	page := mapToPage(body)
	if page.Groups[0].Items[0].Password == nil || *page.Groups[0].Items[0].Password != pwPlain {
		t.Errorf("expected decrypted password %q after migration, got %v", pwPlain, page.Groups[0].Items[0].Password)
	}
}

func TestChangeVaultPassword(t *testing.T) {
	dataDir := t.TempDir()
	store, _, ts := newTestVaultServer(t, dataDir)

	// Setup vault with InitialPassword123!
	post(t, ts, "/api/v1/workspaces/default/vault/setup", map[string]string{
		"password": "InitialPassword123!",
	})

	// Create a page with sensitive encrypted password
	pw := "SecretSecret"
	store.WritePage("pw-page", models.Page{
		PageName: "Passwords",
		Groups: []models.Group{
			{Title: "Logins", Items: []models.Item{}},
		},
	}, "")
	post(t, ts, "/api/v1/pages/pw-page/groups/0/items", models.Item{
		Title:    "Email",
		Password: &pw,
	})

	// Missing fields
	status, _ := post(t, ts, "/api/v1/workspaces/default/vault/change-password", map[string]string{
		"old_password": "",
		"new_password": "New",
	})
	if status != http.StatusBadRequest {
		t.Errorf("expected 400 for empty old_password, got %d", status)
	}

	// Wrong old password
	status, _ = post(t, ts, "/api/v1/workspaces/default/vault/change-password", map[string]string{
		"old_password": "WrongPassword!",
		"new_password": "BrandNewPassword123!",
	})
	if status != http.StatusUnauthorized {
		t.Errorf("expected 401 for wrong old password, got %d", status)
	}

	// Correct old password
	status, body := post(t, ts, "/api/v1/workspaces/default/vault/change-password", map[string]string{
		"old_password": "InitialPassword123!",
		"new_password": "BrandNewPassword123!",
	})
	if status != http.StatusOK {
		t.Fatalf("change-password failed: %d %v", status, body)
	}

	// Verify unlocked with new password
	lockStatus, _ := post(t, ts, "/api/v1/workspaces/default/vault/lock", nil)
	if lockStatus != http.StatusOK {
		t.Fatalf("lock failed: %d", lockStatus)
	}
	status, _ = post(t, ts, "/api/v1/workspaces/default/vault/unlock", map[string]string{
		"password": "BrandNewPassword123!",
	})
	if status != http.StatusOK {
		t.Fatalf("unlock with new password failed: %d", status)
	}

	// Verify password decrypted correctly
	status, body = get(t, ts, "/api/v1/pages/pw-page")
	if status != http.StatusOK {
		t.Fatalf("get page failed: %d", status)
	}
	page := mapToPage(body)
	if page.Groups[0].Items[0].Password == nil || *page.Groups[0].Items[0].Password != pw {
		t.Errorf("expected decrypted password %q, got %v", pw, page.Groups[0].Items[0].Password)
	}
}

func TestSetupVaultWithFernetKeyInConfig(t *testing.T) {
	dataDir := t.TempDir()
	configDir := t.TempDir()
	const oldFernetKey = "cRPBMKMEPHyNh-hWFKn6G4b3mM_x3PW5yqPbxwU3Ue4="

	cfgJSON := `{
		"workspaces": [
			{
				"name": "default",
				"path": "` + strings.ReplaceAll(dataDir, `\`, `/`) + `",
				"fernet_key": "` + oldFernetKey + `"
			}
		]
	}`
	_ = os.WriteFile(filepath.Join(configDir, "config.json"), []byte(cfgJSON), 0o644)

	store := storage.New(fstest.MapFS{}, configDir)
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: dataDir, FernetKey: oldFernetKey},
	}, []string{"default"})

	v := vault.New(15 * time.Minute)
	srv := &handlers.Server{
		Store:      store,
		Vault:      v,
		ConfigDir:  configDir,
		FrontendFS: stubFrontendFS,
	}
	ts := httptest.NewServer(handlers.NewRouter(srv))
	defer ts.Close()

	// Seed page with Fernet-encrypted password
	pw := "Secret123"
	store.WritePage("legacy", models.Page{
		PageName: "Legacy",
		Groups: []models.Group{
			{Title: "G", Items: []models.Item{}},
		},
	}, "default")
	post(t, ts, "/api/v1/pages/legacy/groups/0/items?location=default", models.Item{
		Title:    "Login",
		Password: &pw,
	})

	// Call setup vault -> triggers migration and removeFernetKeyFromConfig
	status, body := post(t, ts, "/api/v1/workspaces/default/vault/setup", map[string]string{
		"password": "MasterPassword123!",
	})
	if status != http.StatusOK {
		t.Fatalf("setup vault failed: %d %v", status, body)
	}

	// Verify password can be read decrypted
	status, body = get(t, ts, "/api/v1/pages/legacy?location=default")
	if status != http.StatusOK {
		t.Fatalf("get page: %d", status)
	}
	p := mapToPage(body)
	if p.Groups[0].Items[0].Password == nil || *p.Groups[0].Items[0].Password != pw {
		t.Errorf("expected decrypted password %q, got %v", pw, p.Groups[0].Items[0].Password)
	}

	// Verify config.json on disk no longer contains fernet_key
	cfgBytes, _ := os.ReadFile(filepath.Join(configDir, "config.json"))
	if strings.Contains(string(cfgBytes), "fernet_key") {
		t.Errorf("expected fernet_key to be removed from config.json")
	}
}

func TestVaultErrorCases(t *testing.T) {
	dataDir := t.TempDir()
	_, _, ts := newTestVaultServer(t, dataDir)

	// 1. setupVault on unknown workspace -> 400
	status, _ := post(t, ts, "/api/v1/workspaces/unknown/vault/setup", map[string]string{"password": "pass"})
	if status != http.StatusBadRequest {
		t.Errorf("setup on unknown workspace: got %d, want 400", status)
	}

	// 2. setupVault with empty password -> 400
	status, _ = post(t, ts, "/api/v1/workspaces/default/vault/setup", map[string]string{"password": ""})
	if status != http.StatusBadRequest {
		t.Errorf("setup with empty password: got %d, want 400", status)
	}

	// 3. setupVault successful
	status, _ = post(t, ts, "/api/v1/workspaces/default/vault/setup", map[string]string{"password": "Pass"})
	if status != http.StatusOK {
		t.Fatalf("setup: %d", status)
	}

	// 4. setupVault already exists -> 409
	status, _ = post(t, ts, "/api/v1/workspaces/default/vault/setup", map[string]string{"password": "Pass"})
	if status != http.StatusConflict {
		t.Errorf("setup already exists: got %d, want 409", status)
	}

	// 5. unlockVault with empty password -> 400
	status, _ = post(t, ts, "/api/v1/workspaces/default/vault/unlock", map[string]string{"password": ""})
	if status != http.StatusBadRequest {
		t.Errorf("unlock with empty password: got %d, want 400", status)
	}

	// 6. unlockVault with nil manager -> 500
	store := storage.New(fstest.MapFS{}, dataDir)
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: dataDir},
	}, []string{"default"})
	nilVaultSrv := &handlers.Server{
		Store:      store,
		Vault:      nil,
		ConfigDir:  dataDir,
		FrontendFS: stubFrontendFS,
	}
	router := handlers.NewRouter(nilVaultSrv)
	nilVaultSrv.Vault = nil // reset to nil after NewRouter has run
	tsNil := httptest.NewServer(router)
	defer tsNil.Close()

	status, _ = post(t, tsNil, "/api/v1/workspaces/default/vault/unlock", map[string]string{"password": "pass"})
	if status != http.StatusInternalServerError {
		t.Errorf("unlock with nil vault: got %d, want 500", status)
	}

	// 7. changeVaultPassword unknown workspace -> 400
	status, _ = post(t, ts, "/api/v1/workspaces/unknown/vault/change-password", map[string]string{
		"old_password": "a", "new_password": "b",
	})
	if status != http.StatusBadRequest {
		t.Errorf("change-password unknown workspace: got %d, want 400", status)
	}
}
