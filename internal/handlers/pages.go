package handlers

import (
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/ExoDeck/exodeck/internal/crypto"
	"github.com/ExoDeck/exodeck/internal/models"
	"github.com/ExoDeck/exodeck/internal/storage"
	"github.com/ExoDeck/exodeck/internal/vault"
	"github.com/xlzd/gotp"
)

const (
	hdrContentType            = "Content-Type"
	msgReadingBody            = "reading request body"
	msgTargetLocationRequired = "target_location is required"
	msgVaultLocked            = "vault is locked; please unlock with master password"
)

// --------------------------------------------------------------------------
// Bootstrap
// --------------------------------------------------------------------------

func (s *Server) bootstrap(w http.ResponseWriter, r *http.Request) {
	s.Store.InitCache()

	names := s.Store.VisibleWorkspaceNames()
	pagesByLocation := map[string][]models.PageMeta{}
	for _, name := range names {
		pages, httpStatus, errMsg := s.Store.ListPages(name)
		if httpStatus != 0 {
			jsonError(w, httpStatus, errMsg)
			return
		}
		pagesByLocation[name] = pages
	}

	// Add ExoDeck docs workspace pages
	if exoPages, _, _ := s.Store.ListPages("Help"); exoPages != nil {
		pagesByLocation["ExoDeck"] = exoPages
		pagesByLocation["docs"] = exoPages
		pagesByLocation["Help"] = exoPages
	}

	vaultStatusByLocation := map[string]interface{}{}
	for _, name := range names {
		_, wsPath, status, _ := s.Store.ResolveWorkspace(name)
		if status == 0 {
			configured := vault.HasVault(wsPath)
			unlocked := false
			expiresIn := 0
			if configured && s.Vault != nil {
				unlocked = s.Vault.IsUnlocked(name)
				if unlocked {
					expiresIn = int(s.Vault.ExpiresIn(name).Seconds())
				}
			}
			fernetKey := s.Store.GetWorkspaceFernetKey(name)
			vaultStatusByLocation[name] = map[string]interface{}{
				"configured":         configured,
				"unlocked":           unlocked,
				"has_legacy_key":     fernetKey != "",
				"expires_in_seconds": expiresIn,
			}
		}
	}

	jsonOK(w, map[string]interface{}{
		"locations":    names,
		"pages":        pagesByLocation,
		"vault_status": vaultStatusByLocation,
		"due_tasks":    s.Store.GetDueTasks(),
		"all_tasks":    s.Store.GetAllTasks(),
	})
}

// --------------------------------------------------------------------------
// Search + Locations
// --------------------------------------------------------------------------

func (s *Server) searchItems(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	results := s.Store.SearchItems(q)
	if results == nil {
		results = []models.SearchResult{}
	}
	jsonOK(w, results)
}

func (s *Server) getDueTasks(w http.ResponseWriter, r *http.Request) {
	jsonOK(w, s.Store.GetDueTasks())
}

func (s *Server) getAllTasks(w http.ResponseWriter, r *http.Request) {
	jsonOK(w, s.Store.GetAllTasks())
}

func (s *Server) listLocations(w http.ResponseWriter, r *http.Request) {
	jsonOK(w, s.Store.VisibleWorkspaceNames())
}

// --------------------------------------------------------------------------
// Pages CRUD
// --------------------------------------------------------------------------

func (s *Server) listPages(w http.ResponseWriter, r *http.Request) {
	location := r.URL.Query().Get("location")
	pages, httpStatus, errMsg := s.Store.ListPages(location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	if pages == nil {
		pages = []models.PageMeta{}
	}
	jsonOK(w, pages)
}

func (s *Server) resolveEncryption(location string) (name string, path string, key []byte, fernetKey string, isLocked bool, status int, errMsg string) {
	name, path, status, errMsg = s.Store.ResolveWorkspace(location)
	if status != 0 {
		return
	}
	fernetKey = s.Store.GetWorkspaceFernetKey(name)
	if vault.HasVault(path) {
		if s.Vault != nil {
			var ok bool
			key, ok = s.Vault.GetKey(name)
			if !ok {
				isLocked = true
			}
		} else {
			isLocked = true
		}
	}
	return
}

func (s *Server) getPage(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	page, httpStatus, errMsg := s.Store.ReadPage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	_, _, key, fernetKey, isLocked, status, errMsg := s.resolveEncryption(location)
	if status != 0 {
		jsonError(w, status, errMsg)
		return
	}

	if isLocked {
		maskPage(&page)
	} else {
		decryptPage(&page, key, fernetKey)
	}
	jsonOK(w, page)
}

func (s *Server) createPage(w http.ResponseWriter, r *http.Request) {
	location := r.URL.Query().Get("location")

	var page models.Page
	if !decodeJSON(w, r, &page) {
		return
	}

	slug := storage.Slugify(page.PageName)

	// Conflict check: refuse to silently overwrite an existing page.
	if _, httpStatus, _ := s.Store.ReadPage(slug, location); httpStatus == 0 {
		jsonError(w, http.StatusConflict, fmt.Sprintf("page '%s' already exists", slug))
		return
	}

	if httpStatus, errMsg := s.Store.WritePage(slug, page, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	w.WriteHeader(http.StatusCreated)
	jsonOK(w, map[string]string{"slug": slug})
}

func (s *Server) renamePage(slug, newSlug, location, locPath string, page models.Page) (int, string) {
	if httpStatus, errMsg := s.Store.WritePage(newSlug, page, location); httpStatus != 0 {
		return httpStatus, errMsg
	}

	if locPath != "" {
		oldMediaPath := filepath.Join(locPath, slug)
		newMediaPath := filepath.Join(locPath, newSlug)
		if stat, err := os.Stat(oldMediaPath); err == nil && stat.IsDir() {
			_ = os.Rename(oldMediaPath, newMediaPath)
		}
	}

	s.Store.DeletePage(slug, location)                              //nolint:errcheck — old slug deletion is best-effort
	_ = s.Store.UpdateLinksAfterPageRename(slug, newSlug, location) //nolint:errcheck — link updates are best-effort

	return 0, ""
}

func (s *Server) updatePage(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	// Ensure page exists
	if _, httpStatus, errMsg := s.Store.ReadPage(slug, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	var page models.Page
	if !decodeJSON(w, r, &page) {
		return
	}

	_, locPath, key, fernetKey, isLocked, status, errMsg := s.resolveEncryption(location)
	if status != 0 {
		jsonError(w, status, errMsg)
		return
	}

	if isLocked && pageHasSensitiveItems(page) {
		jsonError(w, http.StatusLocked, msgVaultLocked)
		return
	}

	encryptPage(&page, key, fernetKey)

	newSlug := storage.Slugify(page.PageName)
	if slug != newSlug {
		if httpStatus, errMsg := s.renamePage(slug, newSlug, location, locPath, page); httpStatus != 0 {
			jsonError(w, httpStatus, errMsg)
			return
		}
	} else {
		if httpStatus, errMsg := s.Store.WritePage(slug, page, location); httpStatus != 0 {
			jsonError(w, httpStatus, errMsg)
			return
		}
	}

	decryptPage(&page, key, fernetKey)
	jsonOK(w, page)
}

func (s *Server) deletePage(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	if httpStatus, errMsg := s.Store.DeletePage(slug, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --------------------------------------------------------------------------
// Groups CRUD
// --------------------------------------------------------------------------

func (s *Server) addGroup(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	var group models.Group
	if !decodeJSON(w, r, &group) {
		return
	}

	_, _, key, fernetKey, isLocked, status, errMsg := s.resolveEncryption(location)
	if status != 0 {
		jsonError(w, status, errMsg)
		return
	}
	if isLocked && groupHasSensitiveItems(group) {
		jsonError(w, http.StatusLocked, msgVaultLocked)
		return
	}

	encryptItems(group.Items, key, fernetKey)

	page, httpStatus, errMsg := s.Store.ReadPage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	page.Groups = append(page.Groups, group)
	if httpStatus, errMsg := s.Store.WritePage(slug, page, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	w.WriteHeader(http.StatusCreated)
	jsonOK(w, map[string]int{"group_index": len(page.Groups) - 1})
}

func (s *Server) updateGroup(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")
	groupIndex, ok := parseIndex(w, chi.URLParam(r, "groupIndex"))
	if !ok {
		return
	}

	var group models.Group
	if !decodeJSON(w, r, &group) {
		return
	}

	_, _, key, fernetKey, isLocked, status, errMsg := s.resolveEncryption(location)
	if status != 0 {
		jsonError(w, status, errMsg)
		return
	}
	if isLocked && groupHasSensitiveItems(group) {
		jsonError(w, http.StatusLocked, msgVaultLocked)
		return
	}

	encryptItems(group.Items, key, fernetKey)

	page, httpStatus, errMsg := s.Store.ReadPage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	if !validateIndex(w, groupIndex, len(page.Groups), "group") {
		return
	}
	page.Groups[groupIndex] = group
	if httpStatus, errMsg := s.Store.WritePage(slug, page, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	decryptItems(group.Items, key, fernetKey)
	jsonOK(w, group)
}

func (s *Server) deleteGroup(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")
	groupIndex, ok := parseIndex(w, chi.URLParam(r, "groupIndex"))
	if !ok {
		return
	}

	page, httpStatus, errMsg := s.Store.ReadPage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	if !validateIndex(w, groupIndex, len(page.Groups), "group") {
		return
	}
	page.Groups = append(page.Groups[:groupIndex], page.Groups[groupIndex+1:]...)
	if httpStatus, errMsg := s.Store.WritePage(slug, page, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) reencryptGroupForMove(w http.ResponseWriter, group *models.Group, srcLoc, dstLoc string) bool {
	if srcLoc == dstLoc {
		return true
	}
	_, _, srcKey, srcFernetKey, srcLocked, _, _ := s.resolveEncryption(srcLoc)
	_, _, dstKey, dstFernetKey, dstLocked, dstStatus, dstErrMsg := s.resolveEncryption(dstLoc)
	if dstStatus != 0 {
		jsonError(w, dstStatus, dstErrMsg)
		return false
	}
	if (srcLocked || dstLocked) && groupHasSensitiveItems(*group) {
		jsonError(w, http.StatusLocked, "workspace vault is locked")
		return false
	}
	for i := range group.Items {
		decryptItem(&group.Items[i], srcKey, srcFernetKey)
		encryptItem(&group.Items[i], dstKey, dstFernetKey)
	}
	return true
}

func (s *Server) moveGroup(w http.ResponseWriter, r *http.Request) {
	sourceSlug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")
	groupIndex, ok := parseIndex(w, chi.URLParam(r, "groupIndex"))
	if !ok {
		return
	}

	var body models.MoveGroupRequest
	if !decodeJSON(w, r, &body) {
		return
	}

	targetLocation := ""
	if body.TargetLocation != nil {
		targetLocation = *body.TargetLocation
	}

	sourcePage, httpStatus, errMsg := s.Store.ReadPage(sourceSlug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	if !validateIndex(w, groupIndex, len(sourcePage.Groups), "group") {
		return
	}

	targetPage, httpStatus, _ := s.Store.ReadPage(body.TargetSlug, targetLocation)
	if httpStatus != 0 {
		jsonError(w, 422, "target page not found or is a note")
		return
	}

	group := sourcePage.Groups[groupIndex]
	if !s.reencryptGroupForMove(w, &group, location, targetLocation) {
		return
	}

	sourcePage.Groups = append(sourcePage.Groups[:groupIndex], sourcePage.Groups[groupIndex+1:]...)
	if httpStatus, errMsg := s.Store.WritePage(sourceSlug, sourcePage, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	targetPage.Groups = append(targetPage.Groups, group)
	if httpStatus, errMsg := s.Store.WritePage(body.TargetSlug, targetPage, targetLocation); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	jsonOK(w, map[string]bool{"success": true})
}

// --------------------------------------------------------------------------
// Items CRUD
// --------------------------------------------------------------------------

func (s *Server) addItem(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")
	groupIndex, ok := parseIndex(w, chi.URLParam(r, "groupIndex"))
	if !ok {
		return
	}

	var item models.Item
	if !decodeJSON(w, r, &item) {
		return
	}
	if item.OTPSecret != nil {
		trimmed := strings.TrimSpace(*item.OTPSecret)
		if trimmed == "" {
			item.OTPSecret = nil
		} else {
			cleanSecret, err := validateAndCleanOTPSecret(trimmed)
			if err != nil {
				jsonError(w, http.StatusBadRequest, "invalid OTP secret: "+err.Error())
				return
			}
			item.OTPSecret = &cleanSecret
		}
	}

	_, _, key, fernetKey, isLocked, status, errMsg := s.resolveEncryption(location)
	if status != 0 {
		jsonError(w, status, errMsg)
		return
	}
	if isLocked && (item.Password != nil || item.OTPSecret != nil || item.EncText != nil) {
		jsonError(w, http.StatusLocked, msgVaultLocked)
		return
	}
	encryptItem(&item, key, fernetKey)

	now := time.Now().Format(time.RFC3339)
	item.CreatedAt = &now
	item.ModifiedAt = &now

	page, httpStatus, errMsg := s.Store.ReadPage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	if !validateIndex(w, groupIndex, len(page.Groups), "group") {
		return
	}
	page.Groups[groupIndex].Items = append(page.Groups[groupIndex].Items, item)
	if httpStatus, errMsg := s.Store.WritePage(slug, page, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	w.WriteHeader(http.StatusCreated)
	jsonOK(w, map[string]int{"item_index": len(page.Groups[groupIndex].Items) - 1})
}

func (s *Server) updateItem(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")
	groupIndex, ok := parseIndex(w, chi.URLParam(r, "groupIndex"))
	if !ok {
		return
	}
	itemIndex, ok := parseIndex(w, chi.URLParam(r, "itemIndex"))
	if !ok {
		return
	}

	var item models.Item
	if !decodeJSON(w, r, &item) {
		return
	}
	if item.OTPSecret != nil {
		trimmed := strings.TrimSpace(*item.OTPSecret)
		if trimmed == "" {
			item.OTPSecret = nil
		} else {
			cleanSecret, err := validateAndCleanOTPSecret(trimmed)
			if err != nil {
				jsonError(w, http.StatusBadRequest, "invalid OTP secret: "+err.Error())
				return
			}
			item.OTPSecret = &cleanSecret
		}
	}

	_, _, key, fernetKey, isLocked, status, errMsg := s.resolveEncryption(location)
	if status != 0 {
		jsonError(w, status, errMsg)
		return
	}
	if isLocked && (item.Password != nil || item.OTPSecret != nil || item.EncText != nil) {
		jsonError(w, http.StatusLocked, msgVaultLocked)
		return
	}
	encryptItem(&item, key, fernetKey)

	page, httpStatus, errMsg := s.Store.ReadPage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	if !validateIndex(w, groupIndex, len(page.Groups), "group") {
		return
	}
	if !validateIndex(w, itemIndex, len(page.Groups[groupIndex].Items), "item") {
		return
	}

	item.CreatedAt = page.Groups[groupIndex].Items[itemIndex].CreatedAt
	now := time.Now().Format(time.RFC3339)
	item.ModifiedAt = &now

	page.Groups[groupIndex].Items[itemIndex] = item
	if httpStatus, errMsg := s.Store.WritePage(slug, page, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	decryptItem(&item, key, fernetKey)
	jsonOK(w, item)
}

func (s *Server) deleteItem(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")
	groupIndex, ok := parseIndex(w, chi.URLParam(r, "groupIndex"))
	if !ok {
		return
	}
	itemIndex, ok := parseIndex(w, chi.URLParam(r, "itemIndex"))
	if !ok {
		return
	}

	page, httpStatus, errMsg := s.Store.ReadPage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	if !validateIndex(w, groupIndex, len(page.Groups), "group") {
		return
	}
	if !validateIndex(w, itemIndex, len(page.Groups[groupIndex].Items), "item") {
		return
	}
	items := page.Groups[groupIndex].Items
	page.Groups[groupIndex].Items = append(items[:itemIndex], items[itemIndex+1:]...)
	if httpStatus, errMsg := s.Store.WritePage(slug, page, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) moveItem(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")
	srcGroupIndex, ok := parseIndex(w, chi.URLParam(r, "groupIndex"))
	if !ok {
		return
	}
	itemIndex, ok := parseIndex(w, chi.URLParam(r, "itemIndex"))
	if !ok {
		return
	}

	var body models.MoveItemRequest
	if !decodeJSON(w, r, &body) {
		return
	}

	page, httpStatus, errMsg := s.Store.ReadPage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	if !validateIndex(w, srcGroupIndex, len(page.Groups), "group") {
		return
	}
	if !validateIndex(w, body.TargetGroupIndex, len(page.Groups), "target group") {
		return
	}
	if srcGroupIndex == body.TargetGroupIndex {
		jsonError(w, 422, "source and target groups are the same")
		return
	}
	if !validateIndex(w, itemIndex, len(page.Groups[srcGroupIndex].Items), "item") {
		return
	}

	item := page.Groups[srcGroupIndex].Items[itemIndex]
	page.Groups[srcGroupIndex].Items = append(
		page.Groups[srcGroupIndex].Items[:itemIndex],
		page.Groups[srcGroupIndex].Items[itemIndex+1:]...,
	)
	page.Groups[body.TargetGroupIndex].Items = append(page.Groups[body.TargetGroupIndex].Items, item)

	if httpStatus, errMsg := s.Store.WritePage(slug, page, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	jsonOK(w, map[string]bool{"success": true})
}

func (s *Server) getOTP(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")
	groupIndex, ok := parseIndex(w, chi.URLParam(r, "groupIndex"))
	if !ok {
		return
	}
	itemIndex, ok := parseIndex(w, chi.URLParam(r, "itemIndex"))
	if !ok {
		return
	}

	page, httpStatus, errMsg := s.Store.ReadPage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	if !validateIndex(w, groupIndex, len(page.Groups), "group") {
		return
	}
	if !validateIndex(w, itemIndex, len(page.Groups[groupIndex].Items), "item") {
		return
	}

	item := page.Groups[groupIndex].Items[itemIndex]
	if item.OTPSecret == nil || *item.OTPSecret == "" {
		jsonError(w, 400, "no OTP secret found for this item")
		return
	}

	_, _, key, fernetKey, isLocked, status, errMsg := s.resolveEncryption(location)
	if status != 0 {
		jsonError(w, status, errMsg)
		return
	}
	if isLocked {
		jsonError(w, http.StatusLocked, msgVaultLocked)
		return
	}

	plainSecret, err := crypto.DecryptValue(*item.OTPSecret, key, fernetKey)
	if err != nil || plainSecret == "" {
		jsonError(w, 400, "failed to decrypt OTP secret")
		return
	}

	secret, err := validateAndCleanOTPSecret(plainSecret)
	if err != nil {
		jsonError(w, 400, "invalid OTP secret: "+err.Error())
		return
	}

	missingPadding := len(secret) % 8
	padded := secret
	if missingPadding != 0 {
		padded = secret + strings.Repeat("=", 8-missingPadding)
	}

	totp := gotp.NewDefaultTOTP(padded)
	jsonOK(w, map[string]string{"otp": totp.Now()})
}

// validateAndCleanOTPSecret validates an OTP secret against RFC 4648 Base32 specifications
// and returns the sanitized uppercase, unpadded Base32 string.
func validateAndCleanOTPSecret(raw string) (string, error) {
	secret := strings.ToUpper(strings.ReplaceAll(raw, " ", ""))
	secret = strings.ReplaceAll(secret, "-", "")
	secret = strings.TrimRight(secret, "=")
	if secret == "" {
		return "", errors.New("empty secret")
	}
	for _, r := range secret {
		if (r < 'A' || r > 'Z') && (r < '2' || r > '7') {
			if r == '0' || r == '1' || r == '8' || r == '9' {
				return "", errors.New("Base32 only uses A-Z and 2-7 (digits 0, 1, 8, 9 are not valid)")
			}
			return "", fmt.Errorf("invalid character %q: only Base32 characters (A-Z and 2-7) are permitted", r)
		}
	}
	mod := len(secret) % 8
	if mod == 1 || mod == 3 || mod == 6 {
		return "", errors.New("invalid Base32 length: incomplete byte sequence")
	}
	if len(secret) < 8 {
		return "", errors.New("secret is too short (minimum 8 characters)")
	}
	missingPadding := len(secret) % 8
	padded := secret
	if missingPadding != 0 {
		padded = secret + strings.Repeat("=", 8-missingPadding)
	}
	if _, err := base32.StdEncoding.DecodeString(padded); err != nil {
		return "", fmt.Errorf("failed to decode Base32: %w", err)
	}
	return secret, nil
}

// --------------------------------------------------------------------------
// Note pages
// --------------------------------------------------------------------------

func (s *Server) createNote(w http.ResponseWriter, r *http.Request) {
	location := r.URL.Query().Get("location")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		jsonError(w, 400, msgReadingBody)
		return
	}
	content := string(body)

	newSlug, pageName, httpStatus, errMsg := s.Store.WriteNotePage("", content, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	w.WriteHeader(http.StatusCreated)
	jsonOK(w, map[string]string{"slug": newSlug, "page_name": pageName})
}

func (s *Server) getNote(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	content, httpStatus, errMsg := s.Store.ReadNotePage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	w.Header().Set(hdrContentType, "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	writeString(w, content)
}

func (s *Server) updateNote(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	// Ensure page exists
	if _, httpStatus, errMsg := s.Store.ReadNotePage(slug, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		jsonError(w, 400, msgReadingBody)
		return
	}

	newSlug, pageName, httpStatus, errMsg := s.Store.WriteNotePage(slug, string(body), location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	if slug != newSlug {
		// Keep internal links in grid and note pages in sync after note slug rename.
		_ = s.Store.UpdateLinksAfterPageRename(slug, newSlug, location) //nolint:errcheck
	}
	jsonOK(w, map[string]string{"slug": newSlug, "page_name": pageName})
}

func (s *Server) deleteNote(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	if httpStatus, errMsg := s.Store.DeleteNotePage(slug, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --------------------------------------------------------------------------
// Whiteboard pages
// --------------------------------------------------------------------------

func (s *Server) createWhiteboard(w http.ResponseWriter, r *http.Request) {
	location := r.URL.Query().Get("location")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		jsonError(w, 400, msgReadingBody)
		return
	}
	newSlug, pageName, httpStatus, errMsg := s.Store.WriteWhiteboardPage("", string(body), location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	w.WriteHeader(http.StatusCreated)
	jsonOK(w, map[string]string{"slug": newSlug, "page_name": pageName})
}

func (s *Server) getWhiteboard(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	content, httpStatus, errMsg := s.Store.ReadWhiteboardPage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	w.Header().Set(hdrContentType, "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	writeString(w, content)
}

func (s *Server) updateWhiteboard(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	if _, httpStatus, errMsg := s.Store.ReadWhiteboardPage(slug, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		jsonError(w, 400, msgReadingBody)
		return
	}
	newSlug, pageName, httpStatus, errMsg := s.Store.WriteWhiteboardPage(slug, string(body), location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	if slug != newSlug {
		// Keep internal links in grid and note pages in sync after whiteboard slug rename.
		_ = s.Store.UpdateLinksAfterPageRename(slug, newSlug, location) //nolint:errcheck
	}
	jsonOK(w, map[string]string{"slug": newSlug, "page_name": pageName})
}

func (s *Server) deleteWhiteboard(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	if httpStatus, errMsg := s.Store.DeleteWhiteboardPage(slug, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --------------------------------------------------------------------------
// Business Process (BPMN) pages
// --------------------------------------------------------------------------

func (s *Server) createBpmn(w http.ResponseWriter, r *http.Request) {
	location := r.URL.Query().Get("location")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		jsonError(w, 400, msgReadingBody)
		return
	}
	newSlug, pageName, httpStatus, errMsg := s.Store.WriteBpmnPage("", string(body), location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	w.WriteHeader(http.StatusCreated)
	jsonOK(w, map[string]string{"slug": newSlug, "page_name": pageName})
}

func (s *Server) getBpmn(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	content, httpStatus, errMsg := s.Store.ReadBpmnPage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	w.Header().Set(hdrContentType, "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	writeString(w, content)
}

func (s *Server) updateBpmn(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	if _, httpStatus, errMsg := s.Store.ReadBpmnPage(slug, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		jsonError(w, 400, msgReadingBody)
		return
	}
	newSlug, pageName, httpStatus, errMsg := s.Store.WriteBpmnPage(slug, string(body), location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	if slug != newSlug {
		// Keep internal links in grid and note pages in sync after bpmn slug rename.
		_ = s.Store.UpdateLinksAfterPageRename(slug, newSlug, location) //nolint:errcheck
	}
	jsonOK(w, map[string]string{"slug": newSlug, "page_name": pageName})
}

func (s *Server) deleteBpmn(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	if httpStatus, errMsg := s.Store.DeleteBpmnPage(slug, location); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --------------------------------------------------------------------------
// Move page to another location
// --------------------------------------------------------------------------

func (s *Server) movePageToLocation(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	var body struct {
		TargetLocation string `json:"target_location"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.TargetLocation == "" {
		jsonError(w, http.StatusBadRequest, msgTargetLocationRequired)
		return
	}

	page, httpStatus, errMsg := s.Store.ReadPage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	_, _, srcKey, srcFernetKey, srcLocked, _, _ := s.resolveEncryption(location)
	_, _, dstKey, dstFernetKey, dstLocked, dstStatus, dstErrMsg := s.resolveEncryption(body.TargetLocation)
	if dstStatus != 0 {
		jsonError(w, dstStatus, dstErrMsg)
		return
	}
	if srcLocked && pageHasSensitiveItems(page) {
		jsonError(w, http.StatusLocked, "source workspace vault is locked")
		return
	}
	if dstLocked && pageHasSensitiveItems(page) {
		jsonError(w, http.StatusLocked, "target workspace vault is locked")
		return
	}
	decryptPage(&page, srcKey, srcFernetKey)
	hasSrcEncryption := len(srcKey) == 32 || srcFernetKey != ""
	hasDstEncryption := len(dstKey) == 32 || dstFernetKey != ""
	if hasSrcEncryption && !hasDstEncryption && pageHasSensitiveItems(page) {
		jsonError(w, http.StatusUnprocessableEntity,
			"cannot move page with encrypted items to a workspace without an encryption key or vault")
		return
	}
	encryptPage(&page, dstKey, dstFernetKey)

	if _, httpStatus, _ := s.Store.ReadPage(slug, body.TargetLocation); httpStatus == 0 {
		jsonError(w, http.StatusConflict, fmt.Sprintf("page '%s' already exists in target location", slug))
		return
	}

	if httpStatus, errMsg := s.Store.WritePage(slug, page, body.TargetLocation); httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	if httpStatus, errMsg := s.Store.DeletePage(slug, location); httpStatus != 0 {
		s.Store.DeletePage(slug, body.TargetLocation) //nolint:errcheck
		jsonError(w, httpStatus, errMsg)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) moveNoteToLocation(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	var body struct {
		TargetLocation string `json:"target_location"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.TargetLocation == "" {
		jsonError(w, http.StatusBadRequest, msgTargetLocationRequired)
		return
	}

	content, httpStatus, errMsg := s.Store.ReadNotePage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	if _, httpStatus, _ := s.Store.ReadNotePage(slug, body.TargetLocation); httpStatus == 0 {
		jsonError(w, http.StatusConflict, fmt.Sprintf("note '%s' already exists in target location", slug))
		return
	}

	newSlug, _, httpStatus, errMsg := s.Store.WriteNotePage("", content, body.TargetLocation)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	_, oldPath, _, _ := s.Store.ResolveWorkspace(location)
	_, newPath, _, _ := s.Store.ResolveWorkspace(body.TargetLocation)
	oldMediaDir := filepath.Join(oldPath, slug)
	newMediaDir := filepath.Join(newPath, newSlug)
	_ = copyDir(oldMediaDir, newMediaDir)

	if httpStatus, errMsg := s.Store.DeleteNotePage(slug, location); httpStatus != 0 {
		s.Store.DeleteNotePage(newSlug, body.TargetLocation) //nolint:errcheck
		_ = os.RemoveAll(newMediaDir)
		jsonError(w, httpStatus, errMsg)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func copyDir(src, dst string) error {
	absSrc, errSrc := filepath.Abs(src)
	absDst, errDst := filepath.Abs(dst)
	if errSrc == nil && errDst == nil {
		cleanSrc := filepath.Clean(absSrc)
		cleanDst := filepath.Clean(absDst)
		if cleanSrc == cleanDst {
			return nil
		}
		if strings.HasPrefix(cleanDst+string(filepath.Separator), cleanSrc+string(filepath.Separator)) {
			return fmt.Errorf("cannot copy directory into itself: %s -> %s", src, dst)
		}
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())
		if entry.IsDir() {
			if err := copyDir(srcPath, dstPath); err != nil {
				return err
			}
		} else {
			in, err := os.Open(srcPath)
			if err != nil {
				return err
			}
			out, err := os.Create(dstPath)
			if err != nil {
				_ = in.Close()
				return err
			}
			_, err = io.Copy(out, in)
			_ = in.Close()
			_ = out.Close()
			if err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) moveWhiteboardToLocation(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	var body struct {
		TargetLocation string `json:"target_location"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.TargetLocation == "" {
		jsonError(w, http.StatusBadRequest, msgTargetLocationRequired)
		return
	}

	content, httpStatus, errMsg := s.Store.ReadWhiteboardPage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	if _, httpStatus, _ := s.Store.ReadWhiteboardPage(slug, body.TargetLocation); httpStatus == 0 {
		jsonError(w, http.StatusConflict, fmt.Sprintf("whiteboard '%s' already exists in target location", slug))
		return
	}

	newSlug, _, httpStatus, errMsg := s.Store.WriteWhiteboardPage("", content, body.TargetLocation)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	if httpStatus, errMsg := s.Store.DeleteWhiteboardPage(slug, location); httpStatus != 0 {
		s.Store.DeleteWhiteboardPage(newSlug, body.TargetLocation) //nolint:errcheck
		jsonError(w, httpStatus, errMsg)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) moveBpmnToLocation(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")

	var body struct {
		TargetLocation string `json:"target_location"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.TargetLocation == "" {
		jsonError(w, http.StatusBadRequest, msgTargetLocationRequired)
		return
	}

	content, httpStatus, errMsg := s.Store.ReadBpmnPage(slug, location)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	if _, httpStatus, _ := s.Store.ReadBpmnPage(slug, body.TargetLocation); httpStatus == 0 {
		jsonError(w, http.StatusConflict, fmt.Sprintf("BPMN diagram '%s' already exists in target location", slug))
		return
	}

	newSlug, _, httpStatus, errMsg := s.Store.WriteBpmnPage("", content, body.TargetLocation)
	if httpStatus != 0 {
		jsonError(w, httpStatus, errMsg)
		return
	}

	if httpStatus, errMsg := s.Store.DeleteBpmnPage(slug, location); httpStatus != 0 {
		s.Store.DeleteBpmnPage(newSlug, body.TargetLocation) //nolint:errcheck
		jsonError(w, httpStatus, errMsg)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// --------------------------------------------------------------------------
// Crypto helpers
// --------------------------------------------------------------------------

// pageHasSensitiveItems returns true if any item in the page carries a field
// that is Fernet or AES-GCM encrypted on disk (Password, OTPSecret, EncText).
func pageHasSensitiveItems(page models.Page) bool {
	for _, g := range page.Groups {
		for _, item := range g.Items {
			if item.Password != nil || item.OTPSecret != nil || item.EncText != nil {
				return true
			}
		}
	}
	return false
}

func groupHasSensitiveItems(group models.Group) bool {
	for _, item := range group.Items {
		if item.Password != nil || item.OTPSecret != nil || item.EncText != nil {
			return true
		}
	}
	return false
}

func encryptField(field *string, key []byte, fernetKey string) *string {
	if field != nil && *field != "" && !crypto.IsAESGCMToken(*field) {
		enc, err := crypto.EncryptValue(*field, key, fernetKey)
		if err == nil {
			return &enc
		}
	}
	return field
}

func decryptField(field *string, key []byte, fernetKey string, requireGCM bool) *string {
	if field != nil && *field != "" {
		if requireGCM && !crypto.IsAESGCMToken(*field) {
			return field
		}
		plain, err := crypto.DecryptValue(*field, key, fernetKey)
		if err == nil {
			return &plain
		}
	}
	return field
}

func encryptItem(item *models.Item, key []byte, fernetKey string) {
	if len(key) != 32 && fernetKey == "" {
		return
	}
	item.Password = encryptField(item.Password, key, fernetKey)
	item.OTPSecret = encryptField(item.OTPSecret, key, fernetKey)
	item.EncText = encryptField(item.EncText, key, fernetKey)

	// For AES-256-GCM vault, also encrypt Username, PwURL, PwNotes
	if len(key) == 32 {
		item.Username = encryptField(item.Username, key, "")
		item.PwURL = encryptField(item.PwURL, key, "")
		item.PwNotes = encryptField(item.PwNotes, key, "")
	}
}

func decryptItem(item *models.Item, key []byte, fernetKey string) {
	item.Password = decryptField(item.Password, key, fernetKey, false)
	item.OTPSecret = decryptField(item.OTPSecret, key, fernetKey, false)
	item.EncText = decryptField(item.EncText, key, fernetKey, false)

	// If OTPSecret failed to decrypt (e.g. stranded Fernet token without Fernet key),
	// do not leak undecrypted raw ciphertext to the client.
	if item.OTPSecret != nil && (strings.HasPrefix(*item.OTPSecret, "gAAAAA") || crypto.IsAESGCMToken(*item.OTPSecret)) {
		item.OTPSecret = nil
	}

	item.Username = decryptField(item.Username, key, "", true)
	item.PwURL = decryptField(item.PwURL, key, "", true)
	item.PwNotes = decryptField(item.PwNotes, key, "", true)
}

func maskItem(item *models.Item) {
	locked := true
	item.Locked = &locked
	masked := "•••••••"
	empty := ""
	if item.Password != nil {
		item.Password = &masked
	}
	if item.OTPSecret != nil {
		item.OTPSecret = &masked
	}
	if item.EncText != nil {
		item.EncText = &masked
	}
	if item.Username != nil && crypto.IsAESGCMToken(*item.Username) {
		item.Username = &masked
	}
	if item.PwURL != nil && crypto.IsAESGCMToken(*item.PwURL) {
		item.PwURL = &empty
	}
	if item.PwNotes != nil && crypto.IsAESGCMToken(*item.PwNotes) {
		item.PwNotes = &empty
	}
}

func encryptItems(items []models.Item, key []byte, fernetKey string) {
	for i := range items {
		encryptItem(&items[i], key, fernetKey)
	}
}

func decryptItems(items []models.Item, key []byte, fernetKey string) {
	for i := range items {
		decryptItem(&items[i], key, fernetKey)
	}
}

func maskItems(items []models.Item) {
	for i := range items {
		if items[i].Password != nil || items[i].OTPSecret != nil || items[i].EncText != nil {
			maskItem(&items[i])
		}
	}
}

func encryptPage(page *models.Page, key []byte, fernetKey string) {
	for i := range page.Groups {
		encryptItems(page.Groups[i].Items, key, fernetKey)
	}
}

func decryptPage(page *models.Page, key []byte, fernetKey string) {
	for i := range page.Groups {
		decryptItems(page.Groups[i].Items, key, fernetKey)
	}
}

func maskPage(page *models.Page) {
	for i := range page.Groups {
		maskItems(page.Groups[i].Items)
	}
}

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------

func jsonOK(w http.ResponseWriter, v interface{}) {
	w.Header().Set(hdrContentType, "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set(hdrContentType, "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"detail": msg})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v interface{}) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		jsonError(w, 422, "invalid JSON: "+err.Error())
		return false
	}
	return true
}

func parseIndex(w http.ResponseWriter, s string) (int, bool) {
	idx, err := strconv.Atoi(s)
	if err != nil {
		jsonError(w, 422, "invalid index: "+s)
		return 0, false
	}
	return idx, true
}

func validateIndex(w http.ResponseWriter, index, length int, label string) bool {
	if index < 0 || index >= length {
		jsonError(w, 422, label+" index "+strconv.Itoa(index)+" is out of range (length "+strconv.Itoa(length)+")")
		return false
	}
	return true
}
