package mcp

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/ExoDeck/exodeck/internal/config"
	"github.com/ExoDeck/exodeck/internal/models"
	"github.com/ExoDeck/exodeck/internal/storage"
)

func (s *Server) registerAllTools() {
	s.registerWorkspaceTools()
	s.registerPageTools()
}

func (s *Server) registerWorkspaceTools() {
	// 1. list_workspaces
	s.registerTool(
		"list_workspaces",
		"List configured ExoDeck workspaces with their path, visibility status, and page counts.",
		objectSchema(map[string]interface{}{
			"include_hidden": boolProp("Include hidden workspaces and hidden pages in counts (default: false)."),
		}),
		s.toolListWorkspaces,
	)

	// 2. create_workspace
	s.registerTool(
		"create_workspace",
		"Create and register a new workspace in config.json and ensure its directory exists on disk.",
		objectSchema(map[string]interface{}{
			"name":   stringProp("Unique display name for the workspace."),
			"path":   stringProp("Filesystem directory path (absolute or relative to config directory)."),
			"hidden": boolProp("Whether the workspace is hidden by default (default: false)."),
		}, "name", "path"),
		s.toolCreateWorkspace,
	)

	// 3. update_workspace
	s.registerTool(
		"update_workspace",
		"Update an existing workspace's name, path, or hidden status in config.json.",
		objectSchema(map[string]interface{}{
			"name":     stringProp("Current name of the workspace to update."),
			"new_name": stringProp("Optional new display name for the workspace."),
			"path":     stringProp("Optional new filesystem path for the workspace."),
			"hidden":   boolProp("Optional new hidden status for the workspace."),
		}, "name"),
		s.toolUpdateWorkspace,
	)

	// 4. delete_workspace
	s.registerTool(
		"delete_workspace",
		"Remove a workspace from config.json (files on disk are preserved).",
		objectSchema(map[string]interface{}{
			"name": stringProp("Name of the workspace to remove from configuration."),
		}, "name"),
		s.toolDeleteWorkspace,
	)

	// 5. get_config
	s.registerTool(
		"get_config",
		"Get ExoDeck application configuration (theme, font sizes, groupbox width, git sync, and workspaces).",
		objectSchema(map[string]interface{}{}),
		s.toolGetConfig,
	)

	// 6. update_config
	s.registerTool(
		"update_config",
		"Update ExoDeck application configuration settings in config.json.",
		objectSchema(map[string]interface{}{
			"theme":              stringEnumProp("UI theme ('dark' or 'light').", "dark", "light"),
			"groupbox_max_width": intProp("Maximum width in pixels for grid group boxes (e.g. 420)."),
			"font_size_ui":       intProp("UI font size in pixels (e.g. 14)."),
			"font_size_note":     intProp("Note font size in pixels (e.g. 16)."),
			"font_size_links":    intProp("Links font size in pixels (e.g. 14)."),
			"enable_git_sync":    boolProp("Enable or disable Git synchronization."),
		}),
		s.toolUpdateConfig,
	)

	// 7. list_pages
	s.registerTool(
		"list_pages",
		"List pages across a specific workspace or all workspaces. Supports filtering by page_type and include_hidden.",
		objectSchema(map[string]interface{}{
			"workspace":      stringProp("Workspace name, or '*' / empty to list across all workspaces."),
			"page_type":      stringEnumProp("Optional filter by page type: 'grid', 'note', 'whiteboard', or 'bpmn'.", "grid", "note", "whiteboard", "bpmn"),
			"include_hidden": boolProp("Include pages in hidden workspaces and pages marked hidden (default: false)."),
		}),
		s.toolListPages,
	)

	// 8. search
	s.registerTool(
		"search",
		"Search across ExoDeck workspaces for pages (grid, note, whiteboard, bpmn) and grid items (links, notes, tasks).",
		objectSchema(map[string]interface{}{
			"query":          stringProp("Case-insensitive search query string."),
			"workspace":      stringProp("Optional workspace name to restrict the search to."),
			"page_type":      stringEnumProp("Optional page type filter ('grid', 'note', 'whiteboard', 'bpmn').", "grid", "note", "whiteboard", "bpmn"),
			"item_type":      stringEnumProp("Optional grid item type filter ('link', 'note', 'task').", "link", "note", "task"),
			"include_hidden": boolProp("Include hidden workspaces and hidden pages in search results (default: false)."),
		}, "query"),
		s.toolSearch,
	)

	// 9. list_tasks
	s.registerTool(
		"list_tasks",
		"List unchecked tasks across workspaces. Can return all open tasks or only due/overdue tasks.",
		objectSchema(map[string]interface{}{
			"filter":         stringEnumProp("Task filter: 'all' for all unchecked tasks, or 'due' for overdue and due-soon tasks (default: 'all').", "all", "due"),
			"workspace":      stringProp("Optional workspace name to filter tasks by."),
			"include_hidden": boolProp("Include tasks from hidden workspaces and hidden pages (default: false)."),
		}),
		s.toolListTasks,
	)

	// 10. move_page
	s.registerTool(
		"move_page",
		"Move a page (grid, note, whiteboard, or bpmn) from one workspace to another.",
		objectSchema(map[string]interface{}{
			"slug":             stringProp("Slug of the page to move."),
			"workspace":        stringProp("Source workspace name."),
			"target_workspace": stringProp("Destination workspace name."),
		}, "slug", "workspace", "target_workspace"),
		s.toolMovePage,
	)

	// 37. git_sync_status
	s.registerTool(
		"git_sync_status",
		"Check Git synchronization status and uncommitted changes for a workspace or all workspaces.",
		objectSchema(map[string]interface{}{
			"workspace": stringProp("Optional workspace name. If omitted, returns status for all workspaces."),
		}),
		s.toolGitSyncStatus,
	)

	// 38. git_sync
	s.registerTool(
		"git_sync",
		"Run Git synchronization (git add, commit, pull --rebase, push) and reload cache for a workspace.",
		objectSchema(map[string]interface{}{
			"workspace": stringProp("Workspace name to synchronize."),
		}, "workspace"),
		s.toolGitSync,
	)
}

// WorkspaceSummary is returned by list_workspaces.
type WorkspaceSummary struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Hidden    bool   `json:"hidden"`
	PageCount int    `json:"page_count"`
}

func (s *Server) isWorkspaceHidden(name string) bool {
	if isBuiltInHelpWorkspace(name) {
		return false
	}
	wsMap := s.Store.Workspaces()
	if cfg, ok := wsMap[name]; ok {
		return cfg.Hidden
	}
	return false
}

func isBuiltInHelpWorkspace(name string) bool {
	return strings.EqualFold(name, "ExoDeck") || strings.EqualFold(name, "docs") || strings.EqualFold(name, "Help")
}

func (s *Server) targetWorkspaces(workspace string, includeHidden bool) ([]string, error) {
	if workspace != "" && workspace != "*" {
		resolved, _, status, errMsg := s.Store.ResolveWorkspace(workspace)
		if status != 0 {
			return nil, errors.New(errMsg)
		}
		if !includeHidden && s.isWorkspaceHidden(resolved) {
			return nil, fmt.Errorf("workspace '%s' is hidden (pass include_hidden=true to access it)", resolved)
		}
		return []string{resolved}, nil
	}

	if includeHidden {
		return s.Store.WorkspaceNames(), nil
	}
	return s.Store.VisibleWorkspaceNames(), nil
}

func (s *Server) toolListWorkspaces(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		IncludeHidden bool `json:"include_hidden"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	names := s.Store.WorkspaceNames()
	wsMap := s.Store.Workspaces()
	var result []WorkspaceSummary

	for _, name := range names {
		cfg, ok := wsMap[name]
		if !ok {
			continue
		}
		if cfg.Hidden && !in.IncludeHidden {
			continue
		}
		pages, status, _ := s.Store.ListPages(name)
		count := 0
		if status == 0 {
			for _, p := range pages {
				if p.Hidden && !in.IncludeHidden {
					continue
				}
				count++
			}
		}
		result = append(result, WorkspaceSummary{
			Name:      name,
			Path:      cfg.Path,
			Hidden:    cfg.Hidden,
			PageCount: count,
		})
	}

	if result == nil {
		result = []WorkspaceSummary{}
	}
	return result, nil
}

type workspaceEntryMap struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Hidden    bool   `json:"hidden"`
	FernetKey string `json:"fernet_key,omitempty"`
}

func normalizeWorkspacesSlice(raw interface{}, store *storage.Store) []workspaceEntryMap {
	var list []workspaceEntryMap
	switch v := raw.(type) {
	case []interface{}:
		for _, item := range v {
			if m, ok := item.(map[string]interface{}); ok {
				name, _ := m["name"].(string)
				path, _ := m["path"].(string)
				hidden, _ := m["hidden"].(bool)
				fk, _ := m["fernet_key"].(string)
				if name != "" && path != "" {
					list = append(list, workspaceEntryMap{
						Name:      name,
						Path:      path,
						Hidden:    hidden,
						FernetKey: fk,
					})
				}
			}
		}
	case map[string]interface{}:
		var names []string
		for k := range v {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, name := range names {
			switch entry := v[name].(type) {
			case string:
				list = append(list, workspaceEntryMap{Name: name, Path: entry})
			case map[string]interface{}:
				path, _ := entry["path"].(string)
				hidden, _ := entry["hidden"].(bool)
				fk, _ := entry["fernet_key"].(string)
				list = append(list, workspaceEntryMap{Name: name, Path: path, Hidden: hidden, FernetKey: fk})
			}
		}
	}

	if len(list) == 0 && store != nil {
		wsMap := store.Workspaces()
		for _, name := range store.WorkspaceNames() {
			if lc, ok := wsMap[name]; ok {
				list = append(list, workspaceEntryMap{
					Name:      name,
					Path:      lc.Path,
					Hidden:    lc.Hidden,
					FernetKey: lc.FernetKey,
				})
			}
		}
	}
	return list
}

func toRawWorkspaceSlice(entries []workspaceEntryMap) []interface{} {
	out := make([]interface{}, 0, len(entries))
	for _, e := range entries {
		m := map[string]interface{}{
			"name":   e.Name,
			"path":   e.Path,
			"hidden": e.Hidden,
		}
		if e.FernetKey != "" {
			m["fernet_key"] = e.FernetKey
		}
		out = append(out, m)
	}
	return out
}

func (s *Server) saveAndReloadWorkspaces(cfg models.ConfigModel, entries []workspaceEntryMap) error {
	cfg.Workspaces = toRawWorkspaceSlice(entries)
	defaultDataDir := filepath.Join(s.ConfigDir, "data")
	locs, order, err := storage.ParseWorkspaces(cfg.Workspaces, defaultDataDir, s.ConfigDir)
	if err != nil {
		return fmt.Errorf("invalid workspaces configuration: %w", err)
	}
	if err := config.Save(s.ConfigDir, cfg); err != nil {
		return fmt.Errorf("saving config.json: %w", err)
	}
	s.Store.SetWorkspaces(locs, order)
	return nil
}

func (s *Server) toolCreateWorkspace(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Name   string `json:"name"`
		Path   string `json:"path"`
		Hidden bool   `json:"hidden"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	name := strings.TrimSpace(in.Name)
	pathVal := strings.TrimSpace(in.Path)
	if name == "" {
		return nil, errors.New("workspace 'name' cannot be empty")
	}
	if pathVal == "" {
		return nil, errors.New("workspace 'path' cannot be empty")
	}
	if isBuiltInHelpWorkspace(name) {
		return nil, fmt.Errorf("workspace name '%s' is reserved", name)
	}

	cfg, err := config.Load(s.ConfigDir)
	if err != nil {
		return nil, fmt.Errorf("loading config: %w", err)
	}

	entries := normalizeWorkspacesSlice(cfg.Workspaces, s.Store)
	for _, e := range entries {
		if strings.EqualFold(e.Name, name) {
			return nil, fmt.Errorf("workspace '%s' already exists", name)
		}
	}

	resolvedPath := pathVal
	if !filepath.IsAbs(resolvedPath) {
		resolvedPath = filepath.Clean(filepath.Join(s.ConfigDir, resolvedPath))
	}
	if err := os.MkdirAll(resolvedPath, 0o755); err != nil {
		return nil, fmt.Errorf("creating workspace directory: %w", err)
	}

	entries = append(entries, workspaceEntryMap{
		Name:   name,
		Path:   pathVal,
		Hidden: in.Hidden,
	})

	if err := s.saveAndReloadWorkspaces(cfg, entries); err != nil {
		return nil, err
	}

	return map[string]interface{}{
		"name":          name,
		"path":          resolvedPath,
		"hidden":        in.Hidden,
		"status":        "created",
		"total_count":   len(entries),
	}, nil
}

func (s *Server) toolUpdateWorkspace(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Name    string  `json:"name"`
		NewName *string `json:"new_name"`
		Path    *string `json:"path"`
		Hidden  *bool   `json:"hidden"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	target := strings.TrimSpace(in.Name)
	if target == "" {
		return nil, errors.New("workspace 'name' is required")
	}

	cfg, err := config.Load(s.ConfigDir)
	if err != nil {
		return nil, fmt.Errorf("loading config: %w", err)
	}

	entries := normalizeWorkspacesSlice(cfg.Workspaces, s.Store)
	foundIdx := -1
	for i, e := range entries {
		if e.Name == target {
			foundIdx = i
			break
		}
	}
	if foundIdx == -1 {
		return nil, fmt.Errorf("workspace '%s' not found", target)
	}

	if in.NewName != nil {
		newName := strings.TrimSpace(*in.NewName)
		if newName == "" {
			return nil, errors.New("new_name cannot be empty")
		}
		if isBuiltInHelpWorkspace(newName) {
			return nil, fmt.Errorf("workspace name '%s' is reserved", newName)
		}
		for i, e := range entries {
			if i != foundIdx && strings.EqualFold(e.Name, newName) {
				return nil, fmt.Errorf("workspace '%s' already exists", newName)
			}
		}
		entries[foundIdx].Name = newName
	}

	if in.Path != nil {
		newPath := strings.TrimSpace(*in.Path)
		if newPath == "" {
			return nil, errors.New("path cannot be empty")
		}
		resolvedPath := newPath
		if !filepath.IsAbs(resolvedPath) {
			resolvedPath = filepath.Clean(filepath.Join(s.ConfigDir, resolvedPath))
		}
		if err := os.MkdirAll(resolvedPath, 0o755); err != nil {
			return nil, fmt.Errorf("creating workspace directory: %w", err)
		}
		entries[foundIdx].Path = newPath
	}

	if in.Hidden != nil {
		entries[foundIdx].Hidden = *in.Hidden
	}

	if err := s.saveAndReloadWorkspaces(cfg, entries); err != nil {
		return nil, err
	}

	return map[string]interface{}{
		"name":   entries[foundIdx].Name,
		"path":   entries[foundIdx].Path,
		"hidden": entries[foundIdx].Hidden,
		"status": "updated",
	}, nil
}

func (s *Server) toolDeleteWorkspace(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	target := strings.TrimSpace(in.Name)
	if target == "" {
		return nil, errors.New("workspace 'name' is required")
	}

	cfg, err := config.Load(s.ConfigDir)
	if err != nil {
		return nil, fmt.Errorf("loading config: %w", err)
	}

	entries := normalizeWorkspacesSlice(cfg.Workspaces, s.Store)
	filtered := make([]workspaceEntryMap, 0, len(entries))
	found := false
	for _, e := range entries {
		if e.Name == target {
			found = true
			continue
		}
		filtered = append(filtered, e)
	}
	if !found {
		return nil, fmt.Errorf("workspace '%s' not found", target)
	}

	if err := s.saveAndReloadWorkspaces(cfg, filtered); err != nil {
		return nil, err
	}

	return map[string]interface{}{
		"name":   target,
		"status": "deleted",
	}, nil
}

func sanitizeConfigForRead(cfg models.ConfigModel, store *storage.Store) map[string]interface{} {
	entries := normalizeWorkspacesSlice(cfg.Workspaces, store)
	sanitizedWS := make([]map[string]interface{}, 0, len(entries))
	for _, e := range entries {
		sanitizedWS = append(sanitizedWS, map[string]interface{}{
			"name":   e.Name,
			"path":   e.Path,
			"hidden": e.Hidden,
		})
	}
	return map[string]interface{}{
		"theme":              cfg.Theme,
		"groupbox_max_width": cfg.GroupboxMaxWidth,
		"font_size_ui":       cfg.FontSizeUI,
		"font_size_note":     cfg.FontSizeNote,
		"font_size_links":    cfg.FontSizeLinks,
		"port":               cfg.Port,
		"enable_git_sync":    cfg.EnableGitSync,
		"workspaces":         sanitizedWS,
	}
}

func (s *Server) toolGetConfig(_ context.Context, _ json.RawMessage) (interface{}, error) {
	cfg, err := config.Load(s.ConfigDir)
	if err != nil {
		return nil, fmt.Errorf("reading config: %w", err)
	}
	return sanitizeConfigForRead(cfg, s.Store), nil
}

func (s *Server) toolUpdateConfig(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Theme            *string `json:"theme"`
		GroupboxMaxWidth *int    `json:"groupbox_max_width"`
		FontSizeUI       *int    `json:"font_size_ui"`
		FontSizeNote     *int    `json:"font_size_note"`
		FontSizeLinks    *int    `json:"font_size_links"`
		EnableGitSync    *bool   `json:"enable_git_sync"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	cfg, err := config.Load(s.ConfigDir)
	if err != nil {
		return nil, fmt.Errorf("reading config: %w", err)
	}

	if in.Theme != nil {
		if *in.Theme != "dark" && *in.Theme != "light" {
			return nil, errors.New("theme must be 'dark' or 'light'")
		}
		cfg.Theme = *in.Theme
	}
	if in.GroupboxMaxWidth != nil {
		if *in.GroupboxMaxWidth <= 0 {
			return nil, errors.New("groupbox_max_width must be positive")
		}
		cfg.GroupboxMaxWidth = *in.GroupboxMaxWidth
	}
	if in.FontSizeUI != nil {
		if *in.FontSizeUI <= 0 {
			return nil, errors.New("font_size_ui must be positive")
		}
		cfg.FontSizeUI = *in.FontSizeUI
	}
	if in.FontSizeNote != nil {
		if *in.FontSizeNote <= 0 {
			return nil, errors.New("font_size_note must be positive")
		}
		cfg.FontSizeNote = *in.FontSizeNote
	}
	if in.FontSizeLinks != nil {
		if *in.FontSizeLinks <= 0 {
			return nil, errors.New("font_size_links must be positive")
		}
		cfg.FontSizeLinks = *in.FontSizeLinks
	}
	if in.EnableGitSync != nil {
		cfg.EnableGitSync = *in.EnableGitSync
	}

	if err := config.Save(s.ConfigDir, cfg); err != nil {
		return nil, fmt.Errorf("saving config: %w", err)
	}

	return sanitizeConfigForRead(cfg, s.Store), nil
}

func (s *Server) toolListPages(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Workspace     string `json:"workspace"`
		PageType      string `json:"page_type"`
		IncludeHidden bool   `json:"include_hidden"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	workspaces, err := s.targetWorkspaces(in.Workspace, in.IncludeHidden)
	if err != nil {
		return nil, err
	}

	var result []models.PageMeta
	for _, ws := range workspaces {
		pages, status, errMsg := s.Store.ListPages(ws)
		if status != 0 {
			return nil, errors.New(errMsg)
		}
		for _, p := range pages {
			if p.Hidden && !in.IncludeHidden {
				continue
			}
			if in.PageType != "" && !strings.EqualFold(p.PageType, in.PageType) {
				continue
			}
			result = append(result, p)
		}
	}

	if result == nil {
		result = []models.PageMeta{}
	}
	return result, nil
}

// SearchResponse aggregates matching pages and grid items across workspaces.
type SearchResponse struct {
	Pages []models.PageMeta     `json:"pages"`
	Items []models.SearchResult `json:"items"`
}

func (s *Server) toolSearch(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Query         string `json:"query"`
		Workspace     string `json:"workspace"`
		PageType      string `json:"page_type"`
		ItemType      string `json:"item_type"`
		IncludeHidden bool   `json:"include_hidden"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	q := strings.ToLower(strings.TrimSpace(in.Query))
	if q == "" {
		return nil, errors.New("'query' cannot be empty")
	}

	workspaces, err := s.targetWorkspaces(in.Workspace, in.IncludeHidden)
	if err != nil {
		return nil, err
	}

	matchedPages := make([]models.PageMeta, 0)
	matchedItems := make([]models.SearchResult, 0)

	for _, ws := range workspaces {
		pages, status, _ := s.Store.ListPages(ws)
		if status != 0 {
			continue
		}
		for _, meta := range pages {
			if meta.Hidden && !in.IncludeHidden {
				continue
			}
			if in.PageType != "" && !strings.EqualFold(meta.PageType, in.PageType) {
				continue
			}

			pageMatch := strings.Contains(strings.ToLower(meta.PageName), q) ||
				strings.Contains(strings.ToLower(meta.Slug), q)
			if !pageMatch && meta.PageType == "note" {
				if content, st, _ := s.Store.ReadNotePage(meta.Slug, ws); st == 0 {
					if strings.Contains(strings.ToLower(content), q) {
						pageMatch = true
					}
				}
			}
			if pageMatch && in.ItemType == "" {
				matchedPages = append(matchedPages, meta)
			}

			if meta.PageType == "grid" {
				s.searchGridPageItems(ws, meta, q, in.ItemType, &matchedItems)
			}
		}
	}

	return SearchResponse{
		Pages: matchedPages,
		Items: matchedItems,
	}, nil
}

func (s *Server) searchGridPageItems(ws string, meta models.PageMeta, lowerQuery, itemTypeFilter string, out *[]models.SearchResult) {
	page, status, _ := s.Store.ReadPage(meta.Slug, ws)
	if status != 0 {
		return
	}
	for gIdx, group := range page.Groups {
		groupMatches := strings.Contains(strings.ToLower(group.Title), lowerQuery)
		for iIdx, item := range group.Items {
			// Never expose or search inside encrypted/password item secrets
			if isSensitiveItem(item) {
				continue
			}
			iType := item.ItemType()
			if itemTypeFilter != "" && !strings.EqualFold(iType, itemTypeFilter) {
				continue
			}

			matched := groupMatches ||
				strings.Contains(strings.ToLower(item.Title), lowerQuery) ||
				strings.Contains(strings.ToLower(meta.PageName), lowerQuery)
			if !matched && item.URL != nil && strings.Contains(strings.ToLower(*item.URL), lowerQuery) {
				matched = true
			}
			if !matched && item.Notes != nil && strings.Contains(strings.ToLower(*item.Notes), lowerQuery) {
				matched = true
			}
			if !matched && item.Text != nil && *item.Text != "" {
				decoded := decodeMarkdownText(*item.Text)
				if strings.Contains(strings.ToLower(decoded), lowerQuery) {
					matched = true
				}
			}
			if matched {
				loc := ws
				*out = append(*out, models.SearchResult{
					Location:   &loc,
					Slug:       meta.Slug,
					PageName:   meta.PageName,
					GroupIndex: gIdx,
					ItemIndex:  iIdx,
					Title:      item.Title,
					URL:        item.URL,
					ItemType:   iType,
				})
			}
		}
	}
}

func (s *Server) toolListTasks(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Filter        string `json:"filter"`
		Workspace     string `json:"workspace"`
		IncludeHidden bool   `json:"include_hidden"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	filter := strings.ToLower(strings.TrimSpace(in.Filter))
	if filter == "" {
		filter = "all"
	}
	if filter != "all" && filter != "due" {
		return nil, errors.New("filter must be 'all' or 'due'")
	}

	workspaces, err := s.targetWorkspaces(in.Workspace, in.IncludeHidden)
	if err != nil {
		return nil, err
	}
	allowedWS := make(map[string]bool, len(workspaces))
	for _, ws := range workspaces {
		allowedWS[ws] = true
	}

	if !in.IncludeHidden {
		if filter == "due" {
			due := s.Store.GetDueTasks()
			var filtered []models.DueTask
			for _, t := range due {
				if allowedWS[t.Location] {
					filtered = append(filtered, t)
				}
			}
			if filtered == nil {
				filtered = []models.DueTask{}
			}
			return filtered, nil
		}
		all := s.Store.GetAllTasks()
		var filtered []models.Task
		for _, t := range all {
			if allowedWS[t.Location] {
				filtered = append(filtered, t)
			}
		}
		if filtered == nil {
			filtered = []models.Task{}
		}
		return filtered, nil
	}

	// When include_hidden is true, scan across all allowed workspaces including hidden ones
	today := time.Now().UTC().Truncate(24 * time.Hour)
	tomorrow := today.Add(24 * time.Hour)
	var tasks []models.Task

	for _, ws := range workspaces {
		pages, st, _ := s.Store.ListPages(ws)
		if st != 0 {
			continue
		}
		for _, meta := range pages {
			if meta.PageType != "grid" {
				continue
			}
			page, pst, _ := s.Store.ReadPage(meta.Slug, ws)
			if pst != 0 {
				continue
			}
			for gIdx, group := range page.Groups {
				for iIdx, item := range group.Items {
					if item.TaskChecked == nil || *item.TaskChecked {
						continue
					}
					dueDate := ""
					dueStatus := ""
					if item.TaskDueDate != nil && *item.TaskDueDate != "" {
						dueDate = *item.TaskDueDate
						if due, err := time.Parse("2006-01-02", dueDate); err == nil {
							due = due.UTC().Truncate(24 * time.Hour)
							if !due.After(today) {
								dueStatus = "overdue"
							} else if due.Equal(tomorrow) {
								dueStatus = "due_soon"
							} else {
								dueStatus = "upcoming"
							}
						}
					}
					if filter == "due" && dueStatus != "overdue" && dueStatus != "due_soon" {
						continue
					}
					var createdAt, taskCreated string
					if item.CreatedAt != nil {
						createdAt = *item.CreatedAt
					}
					if item.TaskCreated != nil {
						taskCreated = *item.TaskCreated
					}
					tasks = append(tasks, models.Task{
						Location:    ws,
						Slug:        meta.Slug,
						PageName:    meta.PageName,
						GroupTitle:  group.Title,
						GroupIndex:  gIdx,
						ItemIndex:   iIdx,
						Title:       item.Title,
						DueDate:     dueDate,
						DueStatus:   dueStatus,
						CreatedAt:   createdAt,
						TaskCreated: taskCreated,
					})
				}
			}
		}
	}

	if tasks == nil {
		tasks = []models.Task{}
	}
	return tasks, nil
}

func (s *Server) toolMovePage(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug            string `json:"slug"`
		Workspace       string `json:"workspace"`
		TargetWorkspace string `json:"target_workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if in.Slug == "" || in.Workspace == "" || in.TargetWorkspace == "" {
		return nil, errors.New("slug, workspace, and target_workspace are required")
	}

	srcName, srcPath, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	dstName, dstPath, st, errMsg := s.Store.ResolveWorkspace(in.TargetWorkspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	if srcName == dstName {
		return nil, errors.New("source and target workspaces are the same")
	}
	if isBuiltInHelpWorkspace(srcName) || isBuiltInHelpWorkspace(dstName) {
		return nil, errors.New("ExoDeck help workspace is read-only")
	}

	pages, st, errMsg := s.Store.ListPages(srcName)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	var pageType string
	for _, p := range pages {
		if p.Slug == in.Slug {
			pageType = p.PageType
			break
		}
	}
	if pageType == "" {
		return nil, fmt.Errorf("page '%s' not found in workspace '%s'", in.Slug, srcName)
	}

	switch pageType {
	case "grid":
		page, status, msg := s.Store.ReadPage(in.Slug, srcName)
		if status != 0 {
			return nil, errors.New(msg)
		}
		if pageContainsSensitiveItems(page) {
			return nil, errors.New("cannot move a grid page containing encrypted/password items via MCP")
		}
		if _, dstSt, _ := s.Store.ReadPage(in.Slug, dstName); dstSt == 0 {
			return nil, fmt.Errorf("page '%s' already exists in target workspace '%s'", in.Slug, dstName)
		}
		if wSt, wMsg := s.Store.WritePage(in.Slug, page, dstName); wSt != 0 {
			return nil, errors.New(wMsg)
		}
		if dSt, dMsg := s.Store.DeletePage(in.Slug, srcName); dSt != 0 {
			_, _ = s.Store.DeletePage(in.Slug, dstName)
			return nil, errors.New(dMsg)
		}

	case "note":
		content, status, msg := s.Store.ReadNotePage(in.Slug, srcName)
		if status != 0 {
			return nil, errors.New(msg)
		}
		if _, dstSt, _ := s.Store.ReadNotePage(in.Slug, dstName); dstSt == 0 {
			return nil, fmt.Errorf("note '%s' already exists in target workspace '%s'", in.Slug, dstName)
		}
		newSlug, _, wSt, wMsg := s.Store.WriteNotePage("", content, dstName)
		if wSt != 0 {
			return nil, errors.New(wMsg)
		}
		oldMediaDir := filepath.Join(srcPath, in.Slug)
		newMediaDir := filepath.Join(dstPath, newSlug)
		_ = copyDirectory(oldMediaDir, newMediaDir)
		if dSt, dMsg := s.Store.DeleteNotePage(in.Slug, srcName); dSt != 0 {
			_, _ = s.Store.DeleteNotePage(newSlug, dstName)
			_ = os.RemoveAll(newMediaDir)
			return nil, errors.New(dMsg)
		}

	case "whiteboard":
		content, status, msg := s.Store.ReadWhiteboardPage(in.Slug, srcName)
		if status != 0 {
			return nil, errors.New(msg)
		}
		if _, dstSt, _ := s.Store.ReadWhiteboardPage(in.Slug, dstName); dstSt == 0 {
			return nil, fmt.Errorf("whiteboard '%s' already exists in target workspace '%s'", in.Slug, dstName)
		}
		newSlug, _, wSt, wMsg := s.Store.WriteWhiteboardPage("", content, dstName)
		if wSt != 0 {
			return nil, errors.New(wMsg)
		}
		if dSt, dMsg := s.Store.DeleteWhiteboardPage(in.Slug, srcName); dSt != 0 {
			_, _ = s.Store.DeleteWhiteboardPage(newSlug, dstName)
			return nil, errors.New(dMsg)
		}

	case "bpmn":
		content, status, msg := s.Store.ReadBpmnPage(in.Slug, srcName)
		if status != 0 {
			return nil, errors.New(msg)
		}
		if _, dstSt, _ := s.Store.ReadBpmnPage(in.Slug, dstName); dstSt == 0 {
			return nil, fmt.Errorf("BPMN diagram '%s' already exists in target workspace '%s'", in.Slug, dstName)
		}
		newSlug, _, wSt, wMsg := s.Store.WriteBpmnPage("", content, dstName)
		if wSt != 0 {
			return nil, errors.New(wMsg)
		}
		if dSt, dMsg := s.Store.DeleteBpmnPage(in.Slug, srcName); dSt != 0 {
			_, _ = s.Store.DeleteBpmnPage(newSlug, dstName)
			return nil, errors.New(dMsg)
		}
	}

	return map[string]interface{}{
		"slug":             in.Slug,
		"page_type":        pageType,
		"source_workspace": srcName,
		"target_workspace": dstName,
		"status":           "moved",
	}, nil
}

func copyDirectory(src, dst string) error {
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
			if err := copyDirectory(srcPath, dstPath); err != nil {
				return err
			}
			continue
		}
		inFile, err := os.Open(srcPath)
		if err != nil {
			return err
		}
		outFile, err := os.Create(dstPath)
		if err != nil {
			_ = inFile.Close()
			return err
		}
		_, err = io.Copy(outFile, inFile)
		_ = inFile.Close()
		_ = outFile.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// Git Sync tools

type defaultGitRunner struct{}

func (defaultGitRunner) Run(ctx context.Context, cwd string, args ...string) (int, string, string) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		return 1, "", "git executable not found: " + err.Error()
	}
	if absPath, absErr := filepath.Abs(gitPath); absErr == nil {
		gitPath = absPath
	}
	cmd := exec.CommandContext(ctx, gitPath, args...)
	cmd.Dir = cwd
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err = cmd.Run()
	rc := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			rc = exitErr.ExitCode()
		} else {
			rc = 1
		}
	}
	return rc, outBuf.String(), errBuf.String()
}

func (s *Server) getGitRunner() GitRunner {
	if s.GitRunner != nil {
		return s.GitRunner
	}
	return defaultGitRunner{}
}

func (s *Server) isGitSyncEnabled() bool {
	cfg, err := config.Load(s.ConfigDir)
	if err != nil {
		return false
	}
	return cfg.EnableGitSync
}

func (s *Server) gitStatusForWorkspace(ctx context.Context, location string, runner GitRunner) (map[string]interface{}, error) {
	if !s.isGitSyncEnabled() {
		return map[string]interface{}{"enabled": false}, nil
	}
	name, dataDir, status, errMsg := s.Store.ResolveWorkspace(location)
	if status != 0 {
		return nil, errors.New(errMsg)
	}
	if isBuiltInHelpWorkspace(name) {
		return map[string]interface{}{"enabled": false}, nil
	}

	rc, toplevel, _ := runner.Run(ctx, dataDir, "rev-parse", "--show-toplevel")
	if rc != 0 {
		return map[string]interface{}{"enabled": false, "error": "Not a git repository"}, nil
	}

	toplevelPath, _ := filepath.Abs(strings.TrimSpace(toplevel))
	dataDirPath, _ := filepath.Abs(dataDir)
	if !strings.EqualFold(toplevelPath, dataDirPath) {
		return map[string]interface{}{"enabled": false, "error": "Not the root of a git repository"}, nil
	}

	_, stdout, _ := runner.Run(ctx, dataDir, "status", "-s")
	return map[string]interface{}{
		"enabled":     true,
		"uncommitted": strings.TrimSpace(stdout) != "",
		"output":      strings.TrimSpace(stdout),
	}, nil
}

func (s *Server) toolGitSyncStatus(ctx context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	runner := s.getGitRunner()
	if strings.TrimSpace(in.Workspace) != "" {
		return s.gitStatusForWorkspace(ctx, in.Workspace, runner)
	}

	result := map[string]interface{}{}
	for _, name := range s.Store.WorkspaceNames() {
		st, err := s.gitStatusForWorkspace(ctx, name, runner)
		if err != nil {
			return nil, err
		}
		result[name] = st
	}
	return result, nil
}

func (s *Server) toolGitSync(ctx context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if !s.isGitSyncEnabled() {
		return nil, errors.New("git sync is disabled in config.json (enable_git_sync: false)")
	}

	wsName, dataDir, status, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if status != 0 {
		return nil, errors.New(errMsg)
	}
	if isBuiltInHelpWorkspace(wsName) {
		return nil, errors.New("git sync is disabled for ExoDeck help workspace")
	}

	runner := s.getGitRunner()
	rc, toplevel, _ := runner.Run(ctx, dataDir, "rev-parse", "--show-toplevel")
	if rc != 0 {
		return nil, errors.New("workspace is not a Git repository")
	}
	toplevelPath, _ := filepath.Abs(strings.TrimSpace(toplevel))
	dataDirPath, _ := filepath.Abs(dataDir)
	if !strings.EqualFold(toplevelPath, dataDirPath) {
		return nil, errors.New("workspace is not the root of a Git repository")
	}

	commands := [][]string{
		{"add", "."},
		{"commit", "-m", "Auto-sync from ExoDeck MCP"},
		{"pull", "--rebase"},
		{"push"},
	}

	var logs []string
	for _, cmdArgs := range commands {
		rc, stdout, stderr := runner.Run(ctx, dataDir, cmdArgs...)
		logs = append(logs, "$ git "+strings.Join(cmdArgs, " ")+"\n"+stdout+stderr)
		if rc != 0 {
			if cmdArgs[0] == "commit" && (strings.Contains(stdout, "nothing to commit") || strings.Contains(stdout, "nothing added to commit")) {
				continue
			}
			detail := stderr
			if detail == "" {
				detail = stdout
			}
			return nil, fmt.Errorf("git command failed: git %s\n%s", strings.Join(cmdArgs, " "), detail)
		}
	}

	s.Store.ReloadCacheForWorkspace(wsName)
	return map[string]interface{}{
		"workspace": wsName,
		"status":    "success",
		"log":       strings.Join(logs, "\n"),
	}, nil
}

func decodeMarkdownText(encoded string) string {
	if encoded == "" {
		return ""
	}
	if decoded, err := base64.StdEncoding.DecodeString(encoded); err == nil {
		return string(decoded)
	}
	return encoded
}

func encodeMarkdownText(markdown string) string {
	return base64.StdEncoding.EncodeToString([]byte(markdown))
}
