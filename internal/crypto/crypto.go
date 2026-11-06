package crypto

import (
	"fmt"
	"strings"
	"sync"

	fernet "github.com/fernet/fernet-go"
)

// cache stores one decoded Fernet key per location name so we parse keys once.
var (
	mu    sync.Mutex
	cache = map[string]*fernet.Key{}
)

// ResetCache clears the key cache. Used in tests.
func ResetCache() {
	mu.Lock()
	defer mu.Unlock()
	cache = map[string]*fernet.Key{}
}

func getKey(fernetKey string) (*fernet.Key, error) {
	mu.Lock()
	defer mu.Unlock()

	if k, ok := cache[fernetKey]; ok {
		return k, nil
	}
	k, err := fernet.DecodeKey(fernetKey)
	if err != nil {
		return nil, fmt.Errorf("invalid fernet key: %w", err)
	}
	cache[fernetKey] = k
	return k, nil
}

// Encrypt encrypts plaintext with the given Fernet key and returns the token.
// Kept for legacy compatibility and migration.
func Encrypt(plaintext, fernetKey string) (string, error) {
	k, err := getKey(fernetKey)
	if err != nil {
		return "", err
	}
	tok, err := fernet.EncryptAndSign([]byte(plaintext), k)
	if err != nil {
		return "", fmt.Errorf("encrypting: %w", err)
	}
	return string(tok), nil
}

// Decrypt decrypts a Fernet token. Returns "" if the token is invalid or the
// key is wrong — it never returns an error in that case, matching Python behaviour.
// Kept for legacy compatibility.
func Decrypt(token, fernetKey string) string {
	k, err := getKey(fernetKey)
	if err != nil {
		return ""
	}
	msg := fernet.VerifyAndDecrypt([]byte(token), 0, []*fernet.Key{k})
	if msg == nil {
		return ""
	}
	return string(msg)
}

// DecryptValue decrypts a ciphertext token using AES-256-GCM if aesKey is non-empty and token starts with "v1:".
// If token is a legacy Fernet token and legacyFernetKey is provided, it falls back to Fernet decryption.
// Returns the decrypted string, or an error if decryption fails.
func DecryptValue(token string, aesKey []byte, legacyFernetKey string) (string, error) {
	if token == "" {
		return "", nil
	}
	if IsAESGCMToken(token) {
		if len(aesKey) != 32 {
			return "", fmt.Errorf("cannot decrypt AES-GCM token: vault is locked or key is missing")
		}
		return DecryptAESGCM(token, aesKey)
	}
	// Fallback to Fernet for legacy tokens
	if legacyFernetKey != "" && strings.HasPrefix(token, "gAAAAA") {
		plain := Decrypt(token, legacyFernetKey)
		if plain == "" {
			return "", fmt.Errorf("failed to decrypt legacy Fernet token")
		}
		return plain, nil
	}
	return "", fmt.Errorf("unrecognized or unsupported token format")
}

// EncryptValue encrypts plaintext. Prefers AES-256-GCM if aesKey (32 bytes) is provided.
// Falls back to legacy Fernet if only legacyFernetKey is provided.
func EncryptValue(plaintext string, aesKey []byte, legacyFernetKey string) (string, error) {
	if len(aesKey) == 32 {
		return EncryptAESGCM(plaintext, aesKey)
	}
	if legacyFernetKey != "" {
		return Encrypt(plaintext, legacyFernetKey)
	}
	return "", fmt.Errorf("no encryption key available")
}
