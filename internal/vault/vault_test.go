package vault_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ExoDeck/exodeck/internal/vault"
)

func TestVaultSetupAndUnlock(t *testing.T) {
	dir := t.TempDir()
	password := "SecretMaster123!"

	// 1. Setup
	meta, err := vault.SetupVault(dir, password)
	if err != nil {
		t.Fatalf("SetupVault: %v", err)
	}
	if meta.KDF != "argon2id" {
		t.Errorf("expected KDF argon2id, got %s", meta.KDF)
	}
	if !vault.HasVault(dir) {
		t.Errorf("expected vault file to exist")
	}

	// 2. Unlock with correct password
	mgr := vault.New(15 * time.Minute)
	if mgr.IsUnlocked("test-ws") {
		t.Errorf("expected locked initially")
	}

	err = mgr.Unlock("test-ws", dir, password)
	if err != nil {
		t.Fatalf("Unlock: %v", err)
	}
	if !mgr.IsUnlocked("test-ws") {
		t.Errorf("expected unlocked after valid unlock")
	}

	key, ok := mgr.GetKey("test-ws")
	if !ok || len(key) != 32 {
		t.Fatalf("expected 32-byte key, got ok=%v len=%d", ok, len(key))
	}

	// 3. Unlock with wrong password fails
	err = mgr.Unlock("test-ws-2", dir, "WrongPassword")
	if err != vault.ErrInvalidPassword {
		t.Errorf("expected ErrInvalidPassword, got %v", err)
	}
	if mgr.IsUnlocked("test-ws-2") {
		t.Errorf("expected locked after wrong password")
	}
}

func TestVaultLockAndAutoLock(t *testing.T) {
	dir := t.TempDir()
	password := "SecretMaster123!"
	_, _ = vault.SetupVault(dir, password)

	// Short auto-lock duration for testing
	mgr := vault.New(50 * time.Millisecond)
	_ = mgr.Unlock("test-ws", dir, password)

	if !mgr.IsUnlocked("test-ws") {
		t.Errorf("expected unlocked")
	}

	// Manual lock
	mgr.Lock("test-ws")
	if mgr.IsUnlocked("test-ws") {
		t.Errorf("expected locked after manual Lock")
	}

	// Test auto-lock timeout
	_ = mgr.Unlock("test-ws", dir, password)
	time.Sleep(70 * time.Millisecond)

	if mgr.IsUnlocked("test-ws") {
		t.Errorf("expected auto-locked after timeout")
	}
	_, ok := mgr.GetKey("test-ws")
	if ok {
		t.Errorf("expected GetKey to return false after auto-lock")
	}
}

func TestVaultNotConfigured(t *testing.T) {
	dir := filepath.Join(os.TempDir(), "nonexistent-vault-dir-12345")
	mgr := vault.New(15 * time.Minute)

	err := mgr.Unlock("ws", dir, "pass")
	if err != vault.ErrVaultNotConfigured {
		t.Errorf("expected ErrVaultNotConfigured, got %v", err)
	}
}

func TestVaultAdditionalMethods(t *testing.T) {
	dir := t.TempDir()

	// Setup with empty password fails
	_, err := vault.SetupVault(dir, "")
	if err == nil {
		t.Error("expected error for empty password")
	}

	// New with zero duration defaults to 15m
	mgr := vault.New(0)
	if mgr.IsUnlocked("ws") {
		t.Error("expected locked initially")
	}

	// SetKey and GetKey
	testKey := make([]byte, 32)
	testKey[0] = 0x42
	mgr.SetKey("ws", testKey)
	if !mgr.IsUnlocked("ws") {
		t.Error("expected unlocked after SetKey")
	}
	gotKey, ok := mgr.GetKey("ws")
	if !ok || len(gotKey) != 32 || gotKey[0] != 0x42 {
		t.Errorf("GetKey failed or returned wrong key")
	}

	// Re-assign key
	newKey := make([]byte, 32)
	newKey[0] = 0x99
	mgr.SetKey("ws", newKey)
	gotKey, _ = mgr.GetKey("ws")
	if gotKey[0] != 0x99 {
		t.Errorf("expected updated key")
	}

	// Touch and ExpiresIn
	mgr.Touch("ws")
	exp := mgr.ExpiresIn("ws")
	if exp <= 0 || exp > 15*time.Minute {
		t.Errorf("unexpected ExpiresIn duration: %v", exp)
	}
	if mgr.ExpiresIn("nonexistent") != 0 {
		t.Errorf("expected 0 ExpiresIn for nonexistent workspace")
	}

	// LockAll
	mgr.SetKey("ws2", testKey)
	mgr.LockAll()
	if mgr.IsUnlocked("ws") || mgr.IsUnlocked("ws2") {
		t.Error("expected all workspaces locked after LockAll")
	}

	// Path helpers
	p := vault.VaultMetaPath(dir)
	if filepath.Base(p) != ".exodeck_vault.json" {
		t.Errorf("unexpected VaultMetaPath: %s", p)
	}

	// Legacy fallback check
	legacyDir := t.TempDir()
	legacyFile := filepath.Join(legacyDir, ".startgrd_vault.json")
	if err := os.WriteFile(legacyFile, []byte(`{"version":1,"kdf":"argon2id","salt":"abc","params":{"memory":65536,"iterations":3,"parallelism":2,"key_length":32},"verifier":"v"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if filepath.Base(vault.VaultMetaPath(legacyDir)) != ".startgrd_vault.json" {
		t.Errorf("expected legacy VaultMetaPath fallback")
	}

	// Load corrupt metadata
	corruptFile := filepath.Join(dir, ".exodeck_vault.json")
	if err := os.WriteFile(corruptFile, []byte("{invalid-json"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = vault.LoadVaultMeta(dir)
	if err == nil {
		t.Error("expected error loading invalid json metadata")
	}

	// Unlock with corrupt salt
	badSaltMeta := `{"version":1,"kdf":"argon2id","salt":"!!!bad-base64!!!","verifier":"v1:a:b"}`
	_ = os.WriteFile(corruptFile, []byte(badSaltMeta), 0o644)
	err = mgr.Unlock("ws", dir, "pass")
	if err == nil {
		t.Error("expected error unlocking with invalid base64 salt")
	}

	// Re-unlocking an already unlocked workspace zeroes existing key properly
	validMeta, err := vault.SetupVault(dir, "ValidPassword123!")
	if err != nil {
		t.Fatal(err)
	}
	_ = validMeta
	if err := mgr.Unlock("ws", dir, "ValidPassword123!"); err != nil {
		t.Fatal(err)
	}
	if err := mgr.Unlock("ws", dir, "ValidPassword123!"); err != nil {
		t.Fatal(err)
	}
}
