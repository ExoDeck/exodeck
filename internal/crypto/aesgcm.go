package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

const aesGCMVersionPrefix = "v1:"

// ErrInvalidToken is returned when a ciphertext token is malformed.
var ErrInvalidToken = errors.New("invalid ciphertext token")

// ErrDecryptionFailed is returned when authentication tag verification fails.
var ErrDecryptionFailed = errors.New("decryption failed: incorrect key or corrupted data")

// IsAESGCMToken returns true if the token starts with the v1: prefix.
func IsAESGCMToken(token string) bool {
	return strings.HasPrefix(token, aesGCMVersionPrefix)
}

// EncryptAESGCM encrypts plaintext using AES-256-GCM with a random 12-byte nonce.
// Returns a token in the format "v1:<base64_nonce>:<base64_ciphertext_and_tag>".
func EncryptAESGCM(plaintext string, key []byte) (string, error) {
	if len(key) != 32 {
		return "", fmt.Errorf("invalid key size: got %d bytes, expected 32", len(key))
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("creating cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("creating GCM: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("generating nonce: %w", err)
	}

	sealed := gcm.Seal(nil, nonce, []byte(plaintext), nil)
	nonceB64 := base64.RawURLEncoding.EncodeToString(nonce)
	cipherB64 := base64.RawURLEncoding.EncodeToString(sealed)

	return aesGCMVersionPrefix + nonceB64 + ":" + cipherB64, nil
}

// DecryptAESGCM decrypts an AES-256-GCM token formatted as "v1:<nonce>:<ciphertext>".
func DecryptAESGCM(token string, key []byte) (string, error) {
	if len(key) != 32 {
		return "", fmt.Errorf("invalid key size: got %d bytes, expected 32", len(key))
	}

	if !strings.HasPrefix(token, aesGCMVersionPrefix) {
		return "", ErrInvalidToken
	}

	body := strings.TrimPrefix(token, aesGCMVersionPrefix)
	parts := strings.SplitN(body, ":", 2)
	if len(parts) != 2 {
		return "", ErrInvalidToken
	}

	nonce, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", fmt.Errorf("%w: invalid nonce encoding", ErrInvalidToken)
	}

	sealed, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("%w: invalid ciphertext encoding", ErrInvalidToken)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("creating cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("creating GCM: %w", err)
	}

	if len(nonce) != gcm.NonceSize() {
		return "", fmt.Errorf("%w: invalid nonce length", ErrInvalidToken)
	}

	plaintext, err := gcm.Open(nil, nonce, sealed, nil)
	if err != nil {
		return "", ErrDecryptionFailed
	}

	return string(plaintext), nil
}
