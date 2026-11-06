package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/ExoDeck/exodeck/internal/config"
	"github.com/ExoDeck/exodeck/internal/models"
	"github.com/ExoDeck/exodeck/internal/storage"
)

func (s *Server) getConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := config.Load(s.ConfigDir)
	if err != nil {
		jsonError(w, 500, "could not read config: "+err.Error())
		return
	}
	jsonOK(w, cfg)
}

func (s *Server) putConfig(w http.ResponseWriter, r *http.Request) {
	// Decode into a raw map first so we can merge partial updates over current config
	var incoming map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
		jsonError(w, 422, "invalid JSON: "+err.Error())
		return
	}

	current, err := config.Load(s.ConfigDir)
	if err != nil {
		jsonError(w, 500, "could not read config: "+err.Error())
		return
	}

	// Validate + merge by marshalling current, unmarshalling, then overlaying
	currentBytes, _ := json.Marshal(current)
	var merged map[string]json.RawMessage
	_ = json.Unmarshal(currentBytes, &merged)
	for k, v := range incoming {
		merged[k] = v
	}

	mergedBytes, _ := json.Marshal(merged)
	var newCfg models.ConfigModel
	if err := json.Unmarshal(mergedBytes, &newCfg); err != nil {
		jsonError(w, 422, "invalid config values: "+err.Error())
		return
	}

	// Apply updated workspaces to the live store — validate BEFORE saving to disk
	defaultDataDir := s.ConfigDir + "/data"
	locs, order, err := storage.ParseWorkspaces(newCfg.Workspaces, defaultDataDir, s.ConfigDir)
	if err != nil {
		jsonError(w, 422, "invalid workspaces: "+err.Error())
		return
	}

	if err := config.Save(s.ConfigDir, newCfg); err != nil {
		jsonError(w, 500, "could not save config: "+err.Error())
		return
	}

	s.Store.SetWorkspaces(locs, order)

	jsonOK(w, newCfg)
}
