package vault

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/ExoDeck/exodeck/internal/crypto"
)

const (
	vaultFileName       = ".exodeck_vault.json"
	legacyVaultFileName = ".startgrd_vault.json"
	canaryString        = "EXODECK_VAULT_OK"
	legacyCanaryString  = "STARTGRD_VAULT_OK"
)

// ErrInvalidPassword is returned when master password verification fails.
var ErrInvalidPassword = errors.New("invalid master password")

// ErrVaultNotConfigured is returned when a vault has not been set up.
var ErrVaultNotConfigured = errors.New("vault not configured for workspace")

// ErrVaultLocked is returned when attempting to access a locked vault.
var ErrVaultLocked = errors.New("vault is locked")

// VaultMeta is persisted to .exodeck_vault.json in the workspace root.
type VaultMeta struct {
	Version   int                 `json:"version"`
	KDF       string              `json:"kdf"`
	Salt      string              `json:"salt"` // base64
	Params    crypto.Argon2Params `json:"params"`
	Verifier  string              `json:"verifier"` // AES-256-GCM token
	CreatedAt string              `json:"created_at,omitempty"`
}

type sessionKey struct {
	key        []byte
	lastActive time.Time
}

// Manager manages in-memory session keys and vault operations.
type Manager struct {
	mu               sync.RWMutex
	keys             map[string]*sessionKey
	autoLockDuration time.Duration
}

// New creates a new Manager with the given auto-lock idle timeout.
func New(autoLockDuration time.Duration) *Manager {
	if autoLockDuration <= 0 {
		autoLockDuration = 15 * time.Minute
	}
	return &Manager{
		keys:             make(map[string]*sessionKey),
		autoLockDuration: autoLockDuration,
	}
}

// VaultMetaPath returns the path to vault metadata for a workspace.
func VaultMetaPath(workspacePath string) string {
	primary := filepath.Join(workspacePath, vaultFileName)
	if _, err := os.Stat(primary); err == nil {
		return primary
	}
	legacy := filepath.Join(workspacePath, legacyVaultFileName)
	if _, err := os.Stat(legacy); err == nil {
		return legacy
	}
	return primary
}

// HasVault checks if a workspace has a vault configured.
func HasVault(workspacePath string) bool {
	info, err := os.Stat(VaultMetaPath(workspacePath))
	return err == nil && !info.IsDir()
}

// LoadVaultMeta reads vault metadata from workspacePath.
func LoadVaultMeta(workspacePath string) (*VaultMeta, error) {
	data, err := os.ReadFile(VaultMetaPath(workspacePath))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrVaultNotConfigured
		}
		return nil, fmt.Errorf("reading vault metadata: %w", err)
	}

	var meta VaultMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, fmt.Errorf("parsing vault metadata: %w", err)
	}
	return &meta, nil
}

// SaveVaultMeta writes .exodeck_vault.json to workspacePath.
func SaveVaultMeta(workspacePath string, meta *VaultMeta) error {
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("marshalling vault metadata: %w", err)
	}
	if err := os.MkdirAll(workspacePath, 0o755); err != nil {
		return fmt.Errorf("creating workspace dir: %w", err)
	}
	target := filepath.Join(workspacePath, vaultFileName)
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return err
	}
	legacy := filepath.Join(workspacePath, legacyVaultFileName)
	if _, err := os.Stat(legacy); err == nil && legacy != target {
		_ = os.Remove(legacy)
	}
	return nil
}

// SetupVault initializes a new vault in workspacePath with the given master password.
func SetupVault(workspacePath, password string) (*VaultMeta, error) {
	if password == "" {
		return nil, errors.New("master password cannot be empty")
	}

	salt, err := crypto.GenerateSalt(32)
	if err != nil {
		return nil, err
	}

	params := crypto.DefaultArgon2Params()
	key := crypto.DeriveKey(password, salt, params)

	verifier, err := crypto.EncryptAESGCM(canaryString, key)
	if err != nil {
		return nil, fmt.Errorf("encrypting canary verifier: %w", err)
	}

	meta := &VaultMeta{
		Version:   1,
		KDF:       "argon2id",
		Salt:      base64.StdEncoding.EncodeToString(salt),
		Params:    params,
		Verifier:  verifier,
		CreatedAt: time.Now().Format(time.RFC3339),
	}

	if err := SaveVaultMeta(workspacePath, meta); err != nil {
		return nil, err
	}

	return meta, nil
}

// Unlock verifies the master password and loads the derived key into RAM.
func (m *Manager) Unlock(workspaceName, workspacePath, password string) error {
	meta, err := LoadVaultMeta(workspacePath)
	if err != nil {
		return err
	}

	salt, err := base64.StdEncoding.DecodeString(meta.Salt)
	if err != nil {
		return fmt.Errorf("decoding salt: %w", err)
	}

	key := crypto.DeriveKey(password, salt, meta.Params)

	// Verify canary (accept current or legacy)
	decryptedCanary, err := crypto.DecryptAESGCM(meta.Verifier, key)
	if err != nil || (decryptedCanary != canaryString && decryptedCanary != legacyCanaryString) {
		return ErrInvalidPassword
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Clear existing key if any
	if existing, ok := m.keys[workspaceName]; ok {
		zeroBytes(existing.key)
	}

	m.keys[workspaceName] = &sessionKey{
		key:        key,
		lastActive: time.Now(),
	}

	return nil
}

// Lock clears and zeroes the master key for a workspace from memory.
func (m *Manager) Lock(workspaceName string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if sk, ok := m.keys[workspaceName]; ok {
		zeroBytes(sk.key)
		delete(m.keys, workspaceName)
	}
}

// LockAll locks all active vaults.
func (m *Manager) LockAll() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for k, sk := range m.keys {
		zeroBytes(sk.key)
		delete(m.keys, k)
	}
}

// IsUnlocked checks if a workspace vault is unlocked and not expired.
func (m *Manager) IsUnlocked(workspaceName string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	sk, ok := m.keys[workspaceName]
	if !ok {
		return false
	}

	if time.Since(sk.lastActive) > m.autoLockDuration {
		zeroBytes(sk.key)
		delete(m.keys, workspaceName)
		return false
	}

	return true
}

// Touch resets the inactivity timer for a workspace.
func (m *Manager) Touch(workspaceName string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if sk, ok := m.keys[workspaceName]; ok {
		sk.lastActive = time.Now()
	}
}

// GetKey retrieves a copy of the key if unlocked, resetting the inactivity timer.
func (m *Manager) GetKey(workspaceName string) ([]byte, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	sk, ok := m.keys[workspaceName]
	if !ok {
		return nil, false
	}

	if time.Since(sk.lastActive) > m.autoLockDuration {
		zeroBytes(sk.key)
		delete(m.keys, workspaceName)
		return nil, false
	}

	sk.lastActive = time.Now()
	out := make([]byte, len(sk.key))
	copy(out, sk.key)
	return out, true
}

// SetKey directly assigns an in-memory key for a workspace (e.g. after setup).
func (m *Manager) SetKey(workspaceName string, key []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.keys[workspaceName]; ok {
		zeroBytes(existing.key)
	}

	keyCopy := make([]byte, len(key))
	copy(keyCopy, key)
	m.keys[workspaceName] = &sessionKey{
		key:        keyCopy,
		lastActive: time.Now(),
	}
}

// ExpiresIn returns the duration remaining before auto-lock, or 0 if locked.
func (m *Manager) ExpiresIn(workspaceName string) time.Duration {
	m.mu.RLock()
	defer m.mu.RUnlock()

	sk, ok := m.keys[workspaceName]
	if !ok {
		return 0
	}

	elapsed := time.Since(sk.lastActive)
	if elapsed >= m.autoLockDuration {
		return 0
	}
	return m.autoLockDuration - elapsed
}

func zeroBytes(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
