package crypto

import (
	"crypto/rand"
	"fmt"

	"golang.org/x/crypto/argon2"
)

// Argon2Params defines parameters for Argon2id key derivation.
type Argon2Params struct {
	Time    uint32 `json:"time"`
	Memory  uint32 `json:"memory"`
	Threads uint8  `json:"threads"`
	KeyLen  uint32 `json:"key_len"`
}

// DefaultArgon2Params returns the standard OWASP/KeePass-recommended Argon2id parameters.
func DefaultArgon2Params() Argon2Params {
	return Argon2Params{
		Time:    3,
		Memory:  64 * 1024, // 64 MB
		Threads: 4,
		KeyLen:  32, // 256-bit key
	}
}

// GenerateSalt creates cryptographically secure random bytes of given length.
func GenerateSalt(length int) ([]byte, error) {
	if length <= 0 {
		length = 32
	}
	salt := make([]byte, length)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("generating salt: %w", err)
	}
	return salt, nil
}

// DeriveKey derives a key from password and salt using Argon2id.
func DeriveKey(password string, salt []byte, params Argon2Params) []byte {
	return argon2.IDKey([]byte(password), salt, params.Time, params.Memory, params.Threads, params.KeyLen)
}
