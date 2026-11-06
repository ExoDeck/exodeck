package crypto_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/ExoDeck/exodeck/internal/crypto"
)

// Generate a valid Fernet key for tests:
const testKey = "cRPBMKMEPHyNh-hWFKn6G4b3mM_x3PW5yqPbxwU3Ue4="

func TestEncryptDecryptRoundtrip(t *testing.T) {
	crypto.ResetCache()
	plain := "hello, world!"
	token, err := crypto.Encrypt(plain, testKey)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if token == plain {
		t.Error("token should differ from plaintext")
	}
	got := crypto.Decrypt(token, testKey)
	if got != plain {
		t.Errorf("Decrypt: got %q, want %q", got, plain)
	}
}

func TestDecryptInvalidTokenReturnsEmpty(t *testing.T) {
	crypto.ResetCache()
	result := crypto.Decrypt("not-a-valid-token", testKey)
	if result != "" {
		t.Errorf("expected empty string for invalid token, got %q", result)
	}
}

func TestEncryptInvalidKeyReturnsError(t *testing.T) {
	crypto.ResetCache()
	_, err := crypto.Encrypt("plain", "not-a-valid-key")
	if err == nil {
		t.Error("expected error for invalid key")
	}
}

func TestDecryptWrongKeyReturnsEmpty(t *testing.T) {
	crypto.ResetCache()
	const otherKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	token, err := crypto.Encrypt("secret", testKey)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	result := crypto.Decrypt(token, otherKey)
	if result != "" {
		t.Errorf("expected empty string with wrong key, got %q", result)
	}
}

func TestArgon2idKeyDerivation(t *testing.T) {
	salt, err := crypto.GenerateSalt(32)
	if err != nil {
		t.Fatalf("GenerateSalt: %v", err)
	}
	if len(salt) != 32 {
		t.Fatalf("expected 32-byte salt, got %d", len(salt))
	}

	params := crypto.DefaultArgon2Params()
	key1 := crypto.DeriveKey("MasterPassword123!", salt, params)
	if len(key1) != 32 {
		t.Fatalf("expected 32-byte key, got %d", len(key1))
	}

	// Deterministic: same password + salt produces identical key
	key2 := crypto.DeriveKey("MasterPassword123!", salt, params)
	if !bytes.Equal(key1, key2) {
		t.Errorf("keys should match for same password and salt")
	}

	// Different password produces different key
	key3 := crypto.DeriveKey("DifferentPassword!", salt, params)
	if bytes.Equal(key1, key3) {
		t.Errorf("keys should differ for different passwords")
	}
}

func TestAES256GCMRoundtrip(t *testing.T) {
	salt, _ := crypto.GenerateSalt(32)
	key := crypto.DeriveKey("MySecretMasterPassword", salt, crypto.DefaultArgon2Params())

	plaintext := "SuperSecret123!@#"
	token, err := crypto.EncryptAESGCM(plaintext, key)
	if err != nil {
		t.Fatalf("EncryptAESGCM: %v", err)
	}

	if !crypto.IsAESGCMToken(token) {
		t.Errorf("token should have v1: prefix, got %q", token)
	}

	decrypted, err := crypto.DecryptAESGCM(token, key)
	if err != nil {
		t.Fatalf("DecryptAESGCM: %v", err)
	}
	if decrypted != plaintext {
		t.Errorf("got %q, want %q", decrypted, plaintext)
	}
}

func TestAES256GCMTamperingFails(t *testing.T) {
	salt, _ := crypto.GenerateSalt(32)
	key := crypto.DeriveKey("MySecretMasterPassword", salt, crypto.DefaultArgon2Params())

	token, _ := crypto.EncryptAESGCM("secret", key)
	// Tamper with the token
	tampered := token[:len(token)-2] + "AA"
	_, err := crypto.DecryptAESGCM(tampered, key)
	if err == nil {
		t.Errorf("expected error decrypting tampered token")
	}

	// Wrong key fails
	wrongKey := crypto.DeriveKey("WrongPassword", salt, crypto.DefaultArgon2Params())
	_, err = crypto.DecryptAESGCM(token, wrongKey)
	if err == nil {
		t.Errorf("expected error decrypting with wrong key")
	}
}

func TestUnifiedEncryptDecrypt(t *testing.T) {
	salt, _ := crypto.GenerateSalt(32)
	aesKey := crypto.DeriveKey("Password123", salt, crypto.DefaultArgon2Params())

	// 1. AES-GCM
	plain := "SecretData"
	token, err := crypto.EncryptValue(plain, aesKey, "")
	if err != nil {
		t.Fatalf("EncryptValue AES-GCM: %v", err)
	}
	dec, err := crypto.DecryptValue(token, aesKey, "")
	if err != nil {
		t.Fatalf("DecryptValue AES-GCM: %v", err)
	}
	if dec != plain {
		t.Errorf("got %q, want %q", dec, plain)
	}

	// 2. Legacy Fernet token fallback
	fernetToken, _ := crypto.Encrypt(plain, testKey)
	decLegacy, err := crypto.DecryptValue(fernetToken, nil, testKey)
	if err != nil {
		t.Fatalf("DecryptValue Fernet fallback: %v", err)
	}
	if decLegacy != plain {
		t.Errorf("got %q, want %q", decLegacy, plain)
	}

	// 3. Empty token
	emptyDec, err := crypto.DecryptValue("", aesKey, "")
	if err != nil || emptyDec != "" {
		t.Errorf("expected empty string and nil error for empty token, got %q, %v", emptyDec, err)
	}

	// 4. AES-GCM without valid 32-byte key
	_, err = crypto.DecryptValue(token, nil, "")
	if err == nil {
		t.Error("expected error decrypting AES token without 32-byte key")
	}

	// 5. Unsupported token format
	_, err = crypto.DecryptValue("some-random-token", nil, "")
	if err == nil {
		t.Error("expected error for unsupported token format")
	}

	// 6. Legacy Fernet with wrong key
	const wrongFernetKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	_, err = crypto.DecryptValue(fernetToken, nil, wrongFernetKey)
	if err == nil {
		t.Error("expected error for legacy Fernet with wrong key")
	}

	// 7. EncryptValue with only legacy Fernet key
	legacyEnc, err := crypto.EncryptValue(plain, nil, testKey)
	if err != nil {
		t.Fatalf("EncryptValue legacy: %v", err)
	}
	if !strings.HasPrefix(legacyEnc, "gAAAAA") {
		t.Errorf("expected Fernet token prefix, got %q", legacyEnc)
	}

	// 8. EncryptValue with no keys
	_, err = crypto.EncryptValue(plain, nil, "")
	if err == nil {
		t.Error("expected error when no keys provided to EncryptValue")
	}
}

func TestAESGCMErrors(t *testing.T) {
	// Invalid key length in EncryptAESGCM
	_, err := crypto.EncryptAESGCM("hello", []byte("too-short"))
	if err == nil {
		t.Error("expected error with short key in EncryptAESGCM")
	}

	// Invalid key length in DecryptAESGCM
	_, err = crypto.DecryptAESGCM("v1:abc:def", []byte("too-short"))
	if err == nil {
		t.Error("expected error with short key in DecryptAESGCM")
	}

	validKey := make([]byte, 32)

	// Missing prefix
	_, err = crypto.DecryptAESGCM("invalid-token", validKey)
	if err != crypto.ErrInvalidToken {
		t.Errorf("expected ErrInvalidToken, got %v", err)
	}

	// Missing second part
	_, err = crypto.DecryptAESGCM("v1:onlyonepart", validKey)
	if err != crypto.ErrInvalidToken {
		t.Errorf("expected ErrInvalidToken, got %v", err)
	}

	// Invalid base64 in nonce
	_, err = crypto.DecryptAESGCM("v1:!!invalid-b64!!:c29tZXRoaW5n", validKey)
	if err == nil {
		t.Error("expected error for invalid base64 in nonce")
	}

	// Invalid base64 in ciphertext
	_, err = crypto.DecryptAESGCM("v1:c29tZXRoaW5n:!!invalid-b64!!", validKey)
	if err == nil {
		t.Error("expected error for invalid base64 in ciphertext")
	}

	// Invalid nonce size (e.g. 4 bytes instead of 12)
	shortNonceToken := "v1:AAAA:c29tZXRoaW5n"
	_, err = crypto.DecryptAESGCM(shortNonceToken, validKey)
	if err == nil {
		t.Error("expected error for short nonce size")
	}
}
