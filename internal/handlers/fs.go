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

func resolveInitialPickDir(rawPath, configDir string) string {
	raw := strings.TrimSpace(rawPath)
	homeDir, _ := os.UserHomeDir()

	var target string
	switch {
	case raw == "":
		if homeDir != "" {
			target = filepath.Clean(homeDir)
		} else if configDir != "" {
			target = filepath.Clean(configDir)
		}
	case !filepath.IsAbs(raw) && configDir != "":
		target = filepath.Clean(filepath.Join(configDir, raw))
	default:
		target = filepath.Clean(raw)
	}

	if target != "" {
		if info, err := os.Stat(target); err == nil && info.IsDir() {
			return target
		}
		cur := target
		for {
			parent := filepath.Dir(cur)
			if parent == cur {
				break
			}
			cur = parent
			if st, statErr := os.Stat(cur); statErr == nil && st.IsDir() {
				return cur
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

func (s *Server) pickFolder(w http.ResponseWriter, r *http.Request) {
	var req pickFolderRequest
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			jsonError(w, http.StatusUnprocessableEntity, "invalid JSON: "+err.Error())
			return
		}
	}

	initialDir := resolveInitialPickDir(req.InitialPath, s.ConfigDir)
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
