package handlers

import (
	"encoding/base64"
	"errors"
	"net/http"
	"path/filepath"

	"github.com/go-chi/chi/v5"

	"github.com/ExoDeck/exodeck/internal/config"
	"github.com/ExoDeck/exodeck/internal/crypto"
	"github.com/ExoDeck/exodeck/internal/storage"
	"github.com/ExoDeck/exodeck/internal/vault"
)

func (s *Server) getVaultStatus(w http.ResponseWriter, r *http.Request) {
	wsName := chi.URLParam(r, "name")
	_, wsPath, status, errMsg := s.Store.ResolveWorkspace(wsName)
	if status != 0 {
		jsonError(w, status, errMsg)
		return
	}

	configured := vault.HasVault(wsPath)
	unlocked := false
	expiresIn := 0
	if configured && s.Vault != nil {
		unlocked = s.Vault.IsUnlocked(wsName)
		if unlocked {
			expiresIn = int(s.Vault.ExpiresIn(wsName).Seconds())
		}
	}

	fernetKey := s.Store.GetWorkspaceFernetKey(wsName)

	jsonOK(w, map[string]interface{}{
		"configured":         configured,
		"unlocked":           unlocked,
		"has_legacy_key":     fernetKey != "",
		"expires_in_seconds": expiresIn,
	})
}

func (s *Server) setupVault(w http.ResponseWriter, r *http.Request) {
	wsName := chi.URLParam(r, "name")
	_, wsPath, status, errMsg := s.Store.ResolveWorkspace(wsName)
	if status != 0 {
		jsonError(w, status, errMsg)
		return
	}

	var body struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Password == "" {
		jsonError(w, http.StatusBadRequest, "master password is required")
		return
	}

	if vault.HasVault(wsPath) {
		jsonError(w, http.StatusConflict, "vault is already configured for this workspace")
		return
	}

	meta, err := vault.SetupVault(wsPath, body.Password)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to setup vault: "+err.Error())
		return
	}

	fernetKey := s.Store.GetWorkspaceFernetKey(wsName)
	if fernetKey != "" {
		newSalt, _ := base64.StdEncoding.DecodeString(meta.Salt)
		newKey := crypto.DeriveKey(body.Password, newSalt, meta.Params)
		pages, pStatus, _ := s.Store.ListPages(wsName)
		if pStatus == 0 {
			for _, p := range pages {
				if p.PageType == "grid" {
					pageData, readStatus, _ := s.Store.ReadPage(p.Slug, wsName)
					if readStatus == 0 {
						decryptPage(&pageData, nil, fernetKey)
						encryptPage(&pageData, newKey, "")
						_, _ = s.Store.WritePage(p.Slug, pageData, wsName)
					}
				}
			}
		}
		s.removeFernetKeyFromConfig(wsName)
	}

	if s.Vault != nil {
		_ = s.Vault.Unlock(wsName, wsPath, body.Password)
	}

	jsonOK(w, map[string]interface{}{
		"success":    true,
		"configured": true,
		"unlocked":   true,
	})
}

func (s *Server) unlockVault(w http.ResponseWriter, r *http.Request) {
	wsName := chi.URLParam(r, "name")
	_, wsPath, status, errMsg := s.Store.ResolveWorkspace(wsName)
	if status != 0 {
		jsonError(w, status, errMsg)
		return
	}

	var body struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Password == "" {
		jsonError(w, http.StatusBadRequest, "master password is required")
		return
	}

	if s.Vault == nil {
		jsonError(w, http.StatusInternalServerError, "vault manager not initialized")
		return
	}

	err := s.Vault.Unlock(wsName, wsPath, body.Password)
	if errors.Is(err, vault.ErrInvalidPassword) {
		jsonError(w, http.StatusUnauthorized, "invalid master password")
		return
	}
	if errors.Is(err, vault.ErrVaultNotConfigured) {
		jsonError(w, http.StatusNotFound, "vault not configured for workspace")
		return
	}
	if err != nil {
		jsonError(w, http.StatusBadRequest, "unlock failed: "+err.Error())
		return
	}

	jsonOK(w, map[string]interface{}{
		"success":            true,
		"unlocked":           true,
		"expires_in_seconds": int(s.Vault.ExpiresIn(wsName).Seconds()),
	})
}

func (s *Server) lockVault(w http.ResponseWriter, r *http.Request) {
	wsName := chi.URLParam(r, "name")
	if s.Vault != nil {
		s.Vault.Lock(wsName)
	}

	jsonOK(w, map[string]interface{}{
		"success":  true,
		"unlocked": false,
	})
}

func (s *Server) changeVaultPassword(w http.ResponseWriter, r *http.Request) {
	wsName := chi.URLParam(r, "name")
	_, wsPath, status, errMsg := s.Store.ResolveWorkspace(wsName)
	if status != 0 {
		jsonError(w, status, errMsg)
		return
	}

	var body struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.OldPassword == "" || body.NewPassword == "" {
		jsonError(w, http.StatusBadRequest, "both old_password and new_password are required")
		return
	}

	meta, err := vault.LoadVaultMeta(wsPath)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "failed loading vault: "+err.Error())
		return
	}

	oldSalt, err := base64.StdEncoding.DecodeString(meta.Salt)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed decoding salt")
		return
	}

	oldKey := crypto.DeriveKey(body.OldPassword, oldSalt, meta.Params)
	canary, err := crypto.DecryptAESGCM(meta.Verifier, oldKey)
	if err != nil || (canary != "EXODECK_VAULT_OK" && canary != "STARTGRD_VAULT_OK") {
		jsonError(w, http.StatusUnauthorized, "incorrect old master password")
		return
	}

	// Generate new key and verifier
	newSalt, err := crypto.GenerateSalt(32)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "generating salt: "+err.Error())
		return
	}
	newParams := crypto.DefaultArgon2Params()
	newKey := crypto.DeriveKey(body.NewPassword, newSalt, newParams)
	newVerifier, err := crypto.EncryptAESGCM("EXODECK_VAULT_OK", newKey)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "encrypting verifier: "+err.Error())
		return
	}

	// Re-encrypt all pages in workspace
	pages, pStatus, _ := s.Store.ListPages(wsName)
	if pStatus == 0 {
		for _, p := range pages {
			if p.PageType == "grid" {
				pageData, readStatus, _ := s.Store.ReadPage(p.Slug, wsName)
				if readStatus == 0 {
					decryptPage(&pageData, oldKey, "")
					encryptPage(&pageData, newKey, "")
					_, _ = s.Store.WritePage(p.Slug, pageData, wsName)
				}
			}
		}
	}

	meta.Salt = base64.StdEncoding.EncodeToString(newSalt)
	meta.Params = newParams
	meta.Verifier = newVerifier
	if err := vault.SaveVaultMeta(wsPath, meta); err != nil {
		jsonError(w, http.StatusInternalServerError, "saving vault metadata: "+err.Error())
		return
	}

	if s.Vault != nil {
		s.Vault.SetKey(wsName, newKey)
	}

	jsonOK(w, map[string]interface{}{
		"success": true,
	})
}

func (s *Server) migrateFernet(w http.ResponseWriter, r *http.Request) {
	wsName := chi.URLParam(r, "name")
	_, wsPath, status, errMsg := s.Store.ResolveWorkspace(wsName)
	if status != 0 {
		jsonError(w, status, errMsg)
		return
	}

	var body struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Password == "" {
		jsonError(w, http.StatusBadRequest, "master password is required")
		return
	}

	fernetKey := s.Store.GetWorkspaceFernetKey(wsName)
	if fernetKey == "" {
		jsonError(w, http.StatusBadRequest, "workspace does not have a legacy Fernet key to migrate")
		return
	}

	meta, err := vault.SetupVault(wsPath, body.Password)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to setup vault: "+err.Error())
		return
	}

	newSalt, _ := base64.StdEncoding.DecodeString(meta.Salt)
	newKey := crypto.DeriveKey(body.Password, newSalt, meta.Params)

	// Re-encrypt all pages
	pages, pStatus, _ := s.Store.ListPages(wsName)
	migratedCount := 0
	if pStatus == 0 {
		for _, p := range pages {
			if p.PageType == "grid" {
				pageData, readStatus, _ := s.Store.ReadPage(p.Slug, wsName)
				if readStatus == 0 {
					decryptPage(&pageData, nil, fernetKey)
					encryptPage(&pageData, newKey, "")
					_, _ = s.Store.WritePage(p.Slug, pageData, wsName)
					migratedCount++
				}
			}
		}
	}

	// Remove fernet_key from config.json
	s.removeFernetKeyFromConfig(wsName)

	if s.Vault != nil {
		s.Vault.SetKey(wsName, newKey)
	}

	jsonOK(w, map[string]interface{}{
		"success":        true,
		"unlocked":       true,
		"pages_migrated": migratedCount,
	})
}

func (s *Server) removeFernetKeyFromConfig(wsName string) {
	cfg, err := config.Load(s.ConfigDir)
	if err != nil {
		return
	}
	modified := false
	if wsList, ok := cfg.Workspaces.([]interface{}); ok {
		for i, rawItem := range wsList {
			if itemMap, ok := rawItem.(map[string]interface{}); ok {
				if itemMap["name"] == wsName {
					delete(itemMap, "fernet_key")
					wsList[i] = itemMap
					modified = true
				}
			}
		}
		cfg.Workspaces = wsList
	} else if wsMap, ok := cfg.Workspaces.(map[string]interface{}); ok {
		if itemRaw, exists := wsMap[wsName]; exists {
			if itemMap, ok := itemRaw.(map[string]interface{}); ok {
				delete(itemMap, "fernet_key")
				wsMap[wsName] = itemMap
				modified = true
			}
		}
		cfg.Workspaces = wsMap
	}
	if modified {
		_ = config.Save(s.ConfigDir, cfg)
		defaultDataDir := filepath.Join(s.ConfigDir, "data")
		locs, order, _ := storage.ParseWorkspaces(cfg.Workspaces, defaultDataDir, s.ConfigDir)
		s.Store.SetWorkspaces(locs, order)
	}
}
