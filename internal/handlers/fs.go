package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

var errPickerUnavailable = errors.New("native folder picker is not available on this system")

type pickFolderRequest struct {
	InitialPath string `json:"initial_path"`
}

type pickFolderResponse struct {
	Path      string `json:"path"`
	Cancelled bool   `json:"cancelled"`
}

func resolveExistingDirOrAncestor(dir string) string {
	if dir == "" {
		return ""
	}
	cur := filepath.Clean(dir)
	for {
		if info, err := os.Stat(cur); err == nil && info.IsDir() {
			return cur
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	return ""
}

func resolveDirWithinRoot(rootDir, rel string) (string, bool) {
	cleanRoot := filepath.Clean(rootDir)
	root, err := os.OpenRoot(cleanRoot)
	if err != nil {
		return "", false
	}
	defer func() {
		_ = root.Close()
	}()

	cur := filepath.Clean(rel)
	if cur == ".." || strings.HasPrefix(cur, ".."+string(filepath.Separator)) || filepath.IsAbs(cur) {
		return "", false
	}
	for {
		if info, statErr := root.Stat(cur); statErr == nil && info.IsDir() {
			if cur == "." {
				return cleanRoot, true
			}
			return filepath.Join(cleanRoot, cur), true
		}
		if cur == "." {
			break
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	return "", false
}

func appendUniqueRoot(roots []string, seen map[string]struct{}, candidate string) []string {
	if candidate == "" {
		return roots
	}
	clean := filepath.Clean(candidate)
	if _, exists := seen[clean]; exists {
		return roots
	}
	seen[clean] = struct{}{}
	return append(roots, clean)
}

func resolveInitialPickDir(rawPath, configDir string, workspaceRoots ...string) string {
	raw := strings.TrimSpace(rawPath)
	homeDir, _ := os.UserHomeDir()

	if raw == "" {
		for _, candidate := range []string{homeDir, configDir} {
			if resolved := resolveExistingDirOrAncestor(candidate); resolved != "" {
				return resolved
			}
		}
		return ""
	}

	if !filepath.IsAbs(raw) && configDir != "" {
		if resolved, ok := resolveDirWithinRoot(configDir, raw); ok {
			return resolved
		}
	}

	if filepath.IsAbs(raw) {
		cleanTarget := filepath.Clean(raw)
		seen := make(map[string]struct{})
		var allowedRoots []string
		allowedRoots = appendUniqueRoot(allowedRoots, seen, homeDir)
		allowedRoots = appendUniqueRoot(allowedRoots, seen, configDir)
		for _, wsRoot := range workspaceRoots {
			allowedRoots = appendUniqueRoot(allowedRoots, seen, wsRoot)
		}

		for _, base := range allowedRoots {
			rel, err := filepath.Rel(base, cleanTarget)
			if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
				continue
			}
			if resolved, ok := resolveDirWithinRoot(base, rel); ok {
				return resolved
			}
		}
	}

	for _, candidate := range []string{homeDir, configDir} {
		if candidate == "" {
			continue
		}
		clean := filepath.Clean(candidate)
		if st, statErr := os.Stat(clean); statErr == nil && st.IsDir() {
			return clean
		}
	}
	return ""
}

func (s *Server) collectAllowedPickerRoots() []string {
	if s.Store == nil {
		return nil
	}
	ws := s.Store.Workspaces()
	roots := make([]string, 0, len(ws))
	for _, cfg := range ws {
		if cfg.Path != "" {
			roots = append(roots, cfg.Path)
		}
	}
	return roots
}

func (s *Server) pickFolder(w http.ResponseWriter, r *http.Request) {
	var req pickFolderRequest
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			jsonError(w, http.StatusUnprocessableEntity, "invalid JSON: "+err.Error())
			return
		}
	}

	initialDir := resolveInitialPickDir(req.InitialPath, s.ConfigDir, s.collectAllowedPickerRoots()...)
	picker := s.FolderPicker
	if picker == nil {
		picker = pickFolderNative
	}

	selected, cancelled, err := picker(r.Context(), initialDir)
	if err != nil {
		if errors.Is(err, errPickerUnavailable) {
			jsonError(w, http.StatusNotImplemented, err.Error())
			return
		}
		jsonError(w, http.StatusInternalServerError, "could not open folder picker: "+err.Error())
		return
	}

	jsonOK(w, pickFolderResponse{
		Path:      selected,
		Cancelled: cancelled,
	})
}
