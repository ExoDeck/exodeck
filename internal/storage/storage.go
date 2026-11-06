package storage

import (
	"bufio"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ExoDeck/exodeck/internal/models"
)


const (
	extGrid         = ".grid"
	extExcalidraw   = ".excalidraw"
	extBPMN         = ".bpmn"
	msgCreatingDir  = "creating data dir: %v"
	errDocsReadOnly = "docs workspace is read-only"
)

func isSupportedFile(relPath string) bool {
	return strings.HasSuffix(relPath, extGrid) ||
		strings.HasSuffix(relPath, ".md") ||
		strings.HasSuffix(relPath, extExcalidraw) ||
		strings.HasSuffix(relPath, extBPMN)
}




// WorkspaceConfig describes one configured data location.
type WorkspaceConfig struct {
	Path      string // absolute path on disk
	FernetKey string // empty when not configured
	Hidden    bool
}

// CacheKey uniquely identifies a page in the cache.
type CacheKey struct {
	Location string
	Slug     string
}

func (c CacheKey) MarshalText() ([]byte, error) {
	return []byte(fmt.Sprintf("%s:%s", c.Location, c.Slug)), nil
}

func (c *CacheKey) UnmarshalText(text []byte) error {
	parts := strings.SplitN(string(text), ":", 2)
	if len(parts) == 2 {
		c.Location = parts[0]
		c.Slug = parts[1]
	}
	return nil
}

// PageEntry holds metadata and the physical path for a page (JSON, Markdown, Excalidraw).
type PageEntry struct {
	Meta    models.PageMeta
	RelPath string // path relative to workspace root
}

// Store holds all mutable runtime state. Create one via New() and pass it to
// the handler constructors.
type Store struct {
	mu            sync.RWMutex
	isInitialized bool
	docsFS        fs.FS
	configDir     string
	workspaces    map[string]WorkspaceConfig // name → config
	workspaceOrd  []string                   // ordered workspace names
	pageEntries   map[CacheKey]PageEntry     // metadata + paths for all files
	searchIndex   []models.SearchResult
	taskIndex     []models.TaskIndexItem
	fileModTimes  map[string]int64 // workspaceName:relPath → modTime
}

// IndexData is persisted to disk for fast startup.
type IndexData struct {
	Version      int
	PageEntries  map[CacheKey]PageEntry
	SearchIndex  []models.SearchResult
	TaskIndex    []models.TaskIndexItem
	FileModTimes map[string]int64
}

// New returns an uninitialised Store. Call InitCache after setting Workspaces.
func New(docsFS fs.FS, configDir string) *Store {
	return &Store{
		docsFS:       docsFS,
		configDir:    configDir,
		workspaces:   map[string]WorkspaceConfig{},
		workspaceOrd: []string{},
		pageEntries:  map[CacheKey]PageEntry{},
		searchIndex:  []models.SearchResult{},
		taskIndex:    []models.TaskIndexItem{},
		fileModTimes: map[string]int64{},
	}
}

// SetWorkspaces replaces the workspace map and reinitialises the cache.
func (s *Store) SetWorkspaces(locs map[string]WorkspaceConfig, order []string) {
	s.mu.Lock()
	s.workspaces = locs
	s.workspaceOrd = order
	s.mu.Unlock()
	s.InitCache()
}

// Workspaces returns a snapshot of the current workspace map.
func (s *Store) Workspaces() map[string]WorkspaceConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]WorkspaceConfig, len(s.workspaces))
	for k, v := range s.workspaces {
		out[k] = v
	}
	return out
}

// WorkspaceNames returns workspace names in ordered arrangement.
func (s *Store) WorkspaceNames() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := make([]string, len(s.workspaceOrd))
	copy(names, s.workspaceOrd)
	return names
}

// VisibleWorkspaceNames returns only the names of non-hidden workspaces in ordered arrangement.
func (s *Store) VisibleWorkspaceNames() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := make([]string, 0, len(s.workspaceOrd))
	for _, name := range s.workspaceOrd {
		if lc, ok := s.workspaces[name]; ok && !lc.Hidden {
			names = append(names, name)
		}
	}
	return names
}

// GetWorkspaceFernetKey returns the Fernet key for a workspace, or "" if not set.
func (s *Store) GetWorkspaceFernetKey(workspaceName string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if lc, ok := s.workspaces[workspaceName]; ok {
		return lc.FernetKey
	}
	return ""
}

// ResolveWorkspace maps an optional location query parameter to a name and path.
// If location is "" the first configured location is used.
// Returns an error message and HTTP status that the handler can forward.
func (s *Store) ResolveWorkspace(location string) (name string, path string, httpStatus int, errMsg string) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if location == "" {
		if len(s.workspaceOrd) == 0 {
			return "", "", 500, "no workspaces configured"
		}
		first := s.workspaceOrd[0]
		return first, s.workspaces[first].Path, 0, ""
	}

	if location == "docs" {
		return "docs", "docs", 0, ""
	}

	lc, ok := s.workspaces[location]
	if !ok {
		allowed := strings.Join(s.WorkspaceNames(), ", ")
		return "", "", 400, fmt.Sprintf("Unknown workspace '%s'. Allowed workspaces: %s", location, allowed)
	}
	return location, lc.Path, 0, ""
}

func (s *Store) indexFilePath() string {
	primary := filepath.Join(s.configDir, "data", ".exodeck_index.json")
	if _, err := os.Stat(primary); err == nil {
		return primary
	}
	legacy := filepath.Join(s.configDir, "data", ".startgrd_index.json")
	if _, err := os.Stat(legacy); err == nil {
		return legacy
	}
	return primary
}

func (s *Store) loadIndex() {
	f, err := os.Open(s.indexFilePath())
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	var idx IndexData
	if err := json.NewDecoder(f).Decode(&idx); err == nil {
		if idx.PageEntries != nil {
			s.pageEntries = make(map[CacheKey]PageEntry, len(idx.PageEntries))
			for k, v := range idx.PageEntries {
				if !strings.HasPrefix(filepath.Base(v.RelPath), ".") && !strings.HasPrefix(k.Slug, ".") && isSupportedFile(v.RelPath) {
					s.pageEntries[k] = v
				}
			}
		}
		if idx.SearchIndex != nil {
			s.searchIndex = idx.SearchIndex
		}
		if idx.Version < 2 {
			s.taskIndex = nil
		} else if idx.TaskIndex != nil {
			s.taskIndex = idx.TaskIndex
		}
		if idx.FileModTimes != nil {
			s.fileModTimes = idx.FileModTimes
		}
	}
}

func (s *Store) saveIndex() {
	primary := filepath.Join(s.configDir, "data", ".exodeck_index.json")
	// Ensure data directory exists
	_ = os.MkdirAll(filepath.Dir(primary), 0755)
	f, err := os.Create(primary)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	idx := IndexData{
		Version:      2,
		PageEntries:  s.pageEntries,
		SearchIndex:  s.searchIndex,
		TaskIndex:    s.taskIndex,
		FileModTimes: s.fileModTimes,
	}
	_ = json.NewEncoder(f).Encode(idx)

	// Clean up legacy index if it existed
	legacy := filepath.Join(s.configDir, "data", ".startgrd_index.json")
	if _, err := os.Stat(legacy); err == nil {
		_ = os.Remove(legacy)
	}
}

// InitCache loads all *.grid pages from every configured location into memory.
func (s *Store) InitCache() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.isInitialized {
		s.loadIndex()
		s.isInitialized = true
	}

	currentFiles := make(map[string]bool)

	for name, lc := range s.workspaces {
		s.loadWorkspaceLocked(name, lc.Path, currentFiles)
	}
	s.loadWorkspaceLocked("docs", "docs", currentFiles)

	s.evictDeletedFilesLocked(currentFiles, "")
	if len(s.taskIndex) == 0 && len(s.pageEntries) > 0 {
		s.populateTaskIndexFromDiskLocked()
	}
	s.saveIndex()
}

// ReloadCacheForWorkspace evicts and reloads all pages for a single workspace.
func (s *Store) ReloadCacheForWorkspace(workspaceName string) {
	lc, ok := func() (WorkspaceConfig, bool) {
		s.mu.RLock()
		defer s.mu.RUnlock()
		lc, ok := s.workspaces[workspaceName]
		return lc, ok
	}()

	s.mu.Lock()
	defer s.mu.Unlock()

	currentFiles := make(map[string]bool)
	if ok {
		s.loadWorkspaceLocked(workspaceName, lc.Path, currentFiles)
	} else if workspaceName == "docs" {
		s.loadWorkspaceLocked("docs", "docs", currentFiles)
	}

	s.evictDeletedFilesLocked(currentFiles, workspaceName)
	s.saveIndex()
}

func (s *Store) shouldEvictEntryLocked(k CacheKey, entry PageEntry, currentFiles map[string]bool, workspaceName string) bool {
	if workspaceName != "" && k.Location != workspaceName {
		return false
	}
	if strings.HasPrefix(filepath.Base(entry.RelPath), ".") || strings.HasPrefix(k.Slug, ".") || !isSupportedFile(entry.RelPath) {
		return true
	}
	fileKey := fileModKey(k.Location, entry.RelPath)
	if currentFiles[fileKey] {
		return false
	}

	var path string
	if k.Location != "docs" {
		if lc, ok := s.workspaces[k.Location]; ok {
			path = lc.Path
		}
	}

	if path != "" {
		fullPath := filepath.Join(path, entry.RelPath)
		if _, err := os.Stat(fullPath); err == nil || !os.IsNotExist(err) {
			slog.Debug("evictDeletedFilesLocked: Stat bypassed eviction", "slug", k.Slug, "location", k.Location)
			return false
		}
	}
	return true
}

func (s *Store) evictDeletedFilesLocked(currentFiles map[string]bool, workspaceName string) {
	// Remove deleted files
	for key := range s.fileModTimes {
		if workspaceName != "" && !strings.HasPrefix(key, workspaceName+":") {
			continue
		}
		if !currentFiles[key] {
			delete(s.fileModTimes, key)
		}
	}

	// Remove pageEntries and search index for deleted files
	for k, entry := range s.pageEntries {
		if s.shouldEvictEntryLocked(k, entry, currentFiles, workspaceName) {
			slog.Debug("evictDeletedFilesLocked: Evicting", "slug", k.Slug, "location", k.Location)
			delete(s.pageEntries, k)
			s.removeSearchIndexItemsLocked(k.Location, k.Slug)
			s.removeTaskIndexItemsLocked(k.Location, k.Slug)
		}
	}
}

func (s *Store) makeWalkFn(locName string, currentFiles map[string]bool) func(string, bool, error, func() (int64, error), func() (fs.File, error)) error {
	return func(relPath string, isDir bool, err error, getModTime func() (int64, error), openFile func() (fs.File, error)) error {
		if strings.HasPrefix(filepath.Base(relPath), ".") {
			return nil
		}
		fileKey := fileModKey(locName, relPath)
		isSupportedExt := isSupportedFile(relPath)
		if !isDir && isSupportedExt {
			currentFiles[fileKey] = true
		}

		if err != nil || isDir || !isSupportedExt {
			return nil
		}

		modTime, err := getModTime()
		if err != nil {
			return nil
		}

		if cachedTime, ok := s.fileModTimes[fileKey]; ok && cachedTime == modTime {
			return nil // Unchanged
		}

		return s.processWorkspaceFileLocked(locName, relPath, modTime, openFile)
	}
}

func (s *Store) loadDocsWorkspaceLocked(walkFn func(string, bool, error, func() (int64, error), func() (fs.File, error)) error) {
	_ = fs.WalkDir(s.docsFS, "docs", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d == nil {
			return nil
		}
		relPath := strings.TrimPrefix(p, "docs/")
		if relPath == "" || relPath == "docs" {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		return walkFn(relPath, d.IsDir(), err, func() (int64, error) {
			info, err := d.Info()
			if err != nil {
				return 0, err
			}
			return info.ModTime().UnixNano(), nil
		}, func() (fs.File, error) {
			return s.docsFS.Open(p)
		})
	})
}

func (s *Store) loadDiskWorkspaceLocked(path string, walkFn func(string, bool, error, func() (int64, error), func() (fs.File, error)) error) {
	_ = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d == nil {
			return nil
		}
		if p == path {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		relPath, errRel := filepath.Rel(path, p)
		if errRel != nil {
			return nil
		}
		return walkFn(relPath, d.IsDir(), err, func() (int64, error) {
			info, err := d.Info()
			if err != nil {
				return 0, err
			}
			return info.ModTime().UnixNano(), nil
		}, func() (fs.File, error) {
			return os.Open(p)
		})
	})
}

// loadWorkspaceLocked reads all pages from path into s.pages and s.pageEntries. Caller must hold s.mu write lock.
func (s *Store) loadWorkspaceLocked(locName, path string, currentFiles map[string]bool) {
	walkFn := s.makeWalkFn(locName, currentFiles)
	if locName == "docs" {
		s.loadDocsWorkspaceLocked(walkFn)
	} else {
		s.loadDiskWorkspaceLocked(path, walkFn)
	}
}

func (s *Store) processWorkspaceFileLocked(locName, relPath string, modTime int64, openFile func() (fs.File, error)) error {
	f, errOpen := openFile()
	if errOpen != nil {
		return nil
	}
	defer func() { _ = f.Close() }()

	var createdAt, modifiedAt *string
	if info, errStat := f.Stat(); errStat == nil {
		cTime, mTime := getFileTimes(info)
		cStr := cTime.Format(time.RFC3339)
		mStr := mTime.Format(time.RFC3339)
		createdAt = &cStr
		modifiedAt = &mStr
	}

	// File is readable. Remove old entry if exists.
	s.removePageByRelPathLocked(locName, relPath)

	pageName, pageType, isHidden, customSort, taskStatus, gridPage, ok := s.extractPageDataLocked(relPath, f)
	if !ok {
		return nil // skip file
	}

	if pageName == "" {
		noExt := strings.TrimSuffix(relPath, filepath.Ext(relPath))
		pageName = filepath.ToSlash(noExt)
		pageName = strings.ReplaceAll(pageName, "/", " / ")
	}

	baseSlug := Slugify(pageName)
	slug := baseSlug
	counter := 1
	for {
		if _, exists := s.pageEntries[CacheKey{locName, slug}]; !exists {
			break
		}
		slug = fmt.Sprintf("%s-%d", baseSlug, counter)
		counter++
	}

	meta := models.PageMeta{
		Slug:       slug,
		PageName:   pageName,
		Hidden:     isHidden,
		CustomSort: customSort,
		PageType:   pageType,
		Location:   locName,
		TaskStatus: taskStatus,
		FileName:   filepath.ToSlash(relPath),
		CreatedAt:  createdAt,
		ModifiedAt: modifiedAt,
	}

	s.pageEntries[CacheKey{locName, slug}] = PageEntry{
		Meta:    meta,
		RelPath: relPath,
	}
	slog.Debug("Added page to entries", "slug", slug, "workspace", locName, "total_entries", len(s.pageEntries))

	if pageType == "grid" {
		gridPage.PageName = pageName
		s.addSearchIndexItemsLocked(gridPage, locName, slug)
		s.addTaskIndexItemsLocked(gridPage, locName, slug)
	}

	fileKey := fileModKey(locName, relPath)
	s.fileModTimes[fileKey] = modTime
	return nil
}

func (s *Store) extractPageDataLocked(relPath string, f fs.File) (pageName, pageType string, isHidden, customSort bool, taskStatus string, gridPage models.Page, ok bool) {
	ok = true
	if strings.HasSuffix(relPath, extGrid) {
		if err := json.NewDecoder(f).Decode(&gridPage); err == nil {
			pageName = gridPage.PageName
			pageType = "grid"
			isHidden = gridPage.Hidden
			customSort = gridPage.CustomSort
			taskStatus = GetPageTaskStatus(gridPage)
		} else {
			return "", "", false, false, "", models.Page{}, false
		}
	} else if strings.HasSuffix(relPath, ".md") {
		pageName = ExtractH1FromReader(f)
		pageType = "note"
	} else if strings.HasSuffix(relPath, extExcalidraw) {
		var wrapper struct {
			PageName string `json:"page-name"`
		}
		if err := json.NewDecoder(f).Decode(&wrapper); err == nil && wrapper.PageName != "" {
			pageName = wrapper.PageName
		}
		pageType = "whiteboard"
	} else if strings.HasSuffix(relPath, extBPMN) {
		pageName = ExtractBpmnNameFromReader(f)
		pageType = "bpmn"
	}

	if pageName != "" && !strings.Contains(pageName, " / ") {
		dir := filepath.Dir(relPath)
		if dir != "." && dir != "" && dir != string(filepath.Separator) && dir != "/" && dir != "\\" {
			dirParts := strings.Split(filepath.ToSlash(dir), "/")
			pageName = strings.Join(dirParts, " / ") + " / " + pageName
		}
	}
	return
}

// rebuildSearchIndexLocked rebuilds the flat search index. Caller must hold s.mu write lock.

// SearchItems returns up to 50 results matching the query (case-insensitive).
func (s *Store) SearchItems(query string) []models.SearchResult {
	s.mu.RLock()
	defer s.mu.RUnlock()

	lower := strings.ToLower(query)
	var results []models.SearchResult
	for _, r := range s.searchIndex {
		if strings.Contains(strings.ToLower(r.Title), lower) ||
			strings.Contains(strings.ToLower(r.PageName), lower) {
			results = append(results, r)
			if len(results) >= 50 {
				break
			}
		}
	}
	return results
}

// ListPages returns metadata for all pages (JSON, Markdown, Excalidraw) in a location.
func (s *Store) ListPages(location string) ([]models.PageMeta, int, string) {
	name, _, status, errMsg := s.ResolveWorkspace(location)
	if status != 0 {
		return nil, status, errMsg
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	var pages []models.PageMeta
	for k, entry := range s.pageEntries {
		if k.Location == name {
			if strings.HasPrefix(filepath.Base(entry.RelPath), ".") || strings.HasPrefix(entry.Meta.Slug, ".") {
				continue
			}
			pages = append(pages, entry.Meta)
		}
	}

	sort.Slice(pages, func(i, j int) bool {
		return strings.ToLower(pages[i].PageName) < strings.ToLower(pages[j].PageName)
	})
	return pages, 0, ""
}

// ReadPage returns a deep copy of the cached page.
func (s *Store) ReadPage(slug, location string) (models.Page, int, string) {
	name, path, status, errMsg := s.ResolveWorkspace(location)
	if status != 0 {
		return models.Page{}, status, errMsg
	}

	s.mu.RLock()
	entry, ok := s.pageEntries[CacheKey{name, slug}]
	s.mu.RUnlock()

	if !ok {
		return models.Page{}, 404, fmt.Sprintf("page '%s' not found", slug)
	}

	if entry.Meta.PageType != "grid" {
		return models.Page{}, 400, "not a grid page"
	}

	var data []byte
	var err error
	if name == "docs" {
		data, err = fs.ReadFile(s.docsFS, filepath.ToSlash(filepath.Join("docs", entry.RelPath)))
	} else {
		data, err = ReadFileWithRetry(filepath.Join(path, entry.RelPath))
	}

	if err != nil {
		return models.Page{}, 500, "could not read page file"
	}

	var page models.Page
	if err := json.Unmarshal(data, &page); err != nil {
		return models.Page{}, 500, "could not parse page file"
	}
	page.PageName = entry.Meta.PageName
	return page, 0, ""
}

// WritePage serialises page to disk and updates the cache.
func (s *Store) WritePage(slug string, page models.Page, location string) (int, string) {
	name, path, status, errMsg := s.ResolveWorkspace(location)
	if status != 0 {
		return status, errMsg
	}
	if name == "docs" {
		return 403, errDocsReadOnly
	}

	data, err := marshalPage(page)
	if err != nil {
		return 500, fmt.Sprintf("serialising page: %v", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	var relPath string
	if oldEntry, ok := s.pageEntries[CacheKey{name, slug}]; ok {
		relPath = strings.TrimSuffix(oldEntry.RelPath, ".json")
		if !strings.HasSuffix(relPath, extGrid) {
			relPath += extGrid
		}
	} else {
		relPath = slug + extGrid
	}

	fullPath := filepath.Join(path, relPath)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		return 500, fmt.Sprintf(msgCreatingDir, err)
	}
	if err := os.WriteFile(fullPath, data, 0644); err != nil {
		return 500, fmt.Sprintf("writing file: %v", err)
	}

	// Update modtime
	var createdAt, modifiedAt *string
	if info, err := os.Stat(fullPath); err == nil {
		s.fileModTimes[fileModKey(name, relPath)] = info.ModTime().UnixNano()
		cTime, mTime := getFileTimes(info)
		cStr := cTime.Format(time.RFC3339)
		mStr := mTime.Format(time.RFC3339)
		createdAt = &cStr
		modifiedAt = &mStr
	}

	s.pageEntries[CacheKey{name, slug}] = PageEntry{
		Meta: models.PageMeta{
			Slug:       slug,
			PageName:   page.PageName,
			Hidden:     page.Hidden,
			CustomSort: page.CustomSort,
			PageType:   "grid",
			Location:   name,
			TaskStatus: GetPageTaskStatus(page),
			FileName:   filepath.ToSlash(relPath),
			CreatedAt:  createdAt,
			ModifiedAt: modifiedAt,
		},
		RelPath: relPath,
	}

	s.removeSearchIndexItemsLocked(name, slug)
	s.addSearchIndexItemsLocked(page, name, slug)
	s.removeTaskIndexItemsLocked(name, slug)
	s.addTaskIndexItemsLocked(page, name, slug)
	s.saveIndex()

	return 0, ""
}

// DeletePage removes the JSON file and its cache entry.
func (s *Store) DeletePage(slug, location string) (int, string) {
	name, path, status, errMsg := s.ResolveWorkspace(location)
	if status != 0 {
		return status, errMsg
	}
	if name == "docs" {
		return 403, errDocsReadOnly
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.pageEntries[CacheKey{name, slug}]
	if !ok {
		return 404, "page not found"
	}

	fullPath := filepath.Join(path, entry.RelPath)
	_ = os.Remove(fullPath)

	delete(s.pageEntries, CacheKey{name, slug})
	delete(s.fileModTimes, fileModKey(name, entry.RelPath))
	s.removeSearchIndexItemsLocked(name, slug)
	s.removeTaskIndexItemsLocked(name, slug)
	s.saveIndex()

	return 0, ""
}

// ReadNotePage returns the raw Markdown content of a .md file.
func (s *Store) ReadNotePage(slug, location string) (string, int, string) {
	name, path, status, errMsg := s.ResolveWorkspace(location)
	if status != 0 {
		return "", status, errMsg
	}

	s.mu.RLock()
	entry, ok := s.pageEntries[CacheKey{name, slug}]
	s.mu.RUnlock()

	if !ok {
		return "", 404, fmt.Sprintf("note '%s' not found", slug)
	}

	var data []byte
	var err error
	if name == "docs" {
		data, err = fs.ReadFile(s.docsFS, "docs/"+entry.RelPath)
	} else {
		fullPath := filepath.Join(path, entry.RelPath)
		data, err = ReadFileWithRetry(fullPath)
	}

	if err != nil {
		if os.IsNotExist(err) || errors.Is(err, fs.ErrNotExist) {
			return "", 404, fmt.Sprintf("note '%s' not found", slug)
		}
		return "", 500, fmt.Sprintf("reading note page: %v", err)
	}

	rawContent := string(data)
	actualH1 := ExtractH1(rawContent)
	if actualH1 != entry.Meta.PageName {
		lines := strings.Split(rawContent, "\n")
		replaced := false
		for i, line := range lines {
			if strings.HasPrefix(line, "# ") {
				lines[i] = "# " + entry.Meta.PageName
				replaced = true
				break
			}
		}
		if replaced {
			rawContent = strings.Join(lines, "\n")
		} else {
			rawContent = "# " + entry.Meta.PageName + "\n\n" + rawContent
		}
	}

	return rawContent, 0, ""
}

func (s *Store) generateUniqueSlugLocked(locName, baseSlug, oldSlug string) (string, error) {
	if oldSlug == "" {
		if _, exists := s.pageEntries[CacheKey{locName, baseSlug}]; exists {
			return "", fmt.Errorf("already exists")
		}
		return baseSlug, nil
	} else if baseSlug != oldSlug {
		newSlug := baseSlug
		counter := 1
		for {
			if _, exists := s.pageEntries[CacheKey{locName, newSlug}]; !exists {
				break
			}
			newSlug = fmt.Sprintf("%s-%d", baseSlug, counter)
			counter++
		}
		return newSlug, nil
	}
	return oldSlug, nil
}

func isSameFile(path1, path2 string) bool {
	stat1, err1 := os.Stat(path1)
	stat2, err2 := os.Stat(path2)
	if err1 == nil && err2 == nil {
		return os.SameFile(stat1, stat2)
	}
	return false
}

func (s *Store) renameMediaDirLocked(oldMediaDir, newMediaDir string) {
	if stat, err := os.Stat(oldMediaDir); err == nil && stat.IsDir() {
		_ = os.MkdirAll(filepath.Dir(newMediaDir), 0o755)
		_ = os.Rename(oldMediaDir, newMediaDir)
	}
}

func (s *Store) cleanupOldPageLocked(name, oldSlug, newSlug, path, newRelPath, fullPath string, isNote bool) {
	oldEntry, ok := s.pageEntries[CacheKey{name, oldSlug}]

	if newSlug != oldSlug {
		delete(s.pageEntries, CacheKey{name, oldSlug})
	}

	if !ok || oldEntry.RelPath == newRelPath || oldEntry.RelPath == "" {
		return
	}

	fullOldPath := filepath.Join(path, oldEntry.RelPath)
	sameFile := isSameFile(fullOldPath, fullPath)
	if !sameFile {
		_ = os.Remove(fullOldPath)
	}

	if isNote && !sameFile {
		oldMediaDir := strings.TrimSuffix(fullOldPath, ".md")
		newMediaDir := strings.TrimSuffix(fullPath, ".md")
		if oldMediaDir != newMediaDir {
			s.renameMediaDirLocked(oldMediaDir, newMediaDir)
		}
	}
}

// WriteNotePage writes content to a .md file, renaming if the H1 slug changed.
// Returns (newSlug, pageName, httpStatus, errMsg).
func (s *Store) WriteNotePage(oldSlug, content, location string) (string, string, int, string) {
	name, path, status, errMsg := s.ResolveWorkspace(location)
	if status != 0 {
		return "", "", status, errMsg
	}
	if name == "docs" {
		return "", "", 403, errDocsReadOnly
	}

	pageName := ExtractH1(content)
	if pageName == "" {
		pageName = "Untitled"
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	baseSlug := Slugify(pageName)
	newSlug, err := s.generateUniqueSlugLocked(name, baseSlug, oldSlug)
	if err != nil {
		return "", "", 409, fmt.Sprintf("note '%s' already exists", baseSlug)
	}

	fileNameBase := LogicalToPhysicalPath(pageName)
	if newSlug != baseSlug {
		fileNameBase += strings.TrimPrefix(newSlug, baseSlug)
	}
	newRelPath := fileNameBase + ".md"
	fullPath := filepath.Join(path, newRelPath)

	// Directory creation
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		return "", "", 500, fmt.Sprintf(msgCreatingDir, err)
	}

	if err := os.WriteFile(fullPath, []byte(content), 0o644); err != nil {
		return "", "", 500, fmt.Sprintf("writing note: %v", err)
	}

	if oldSlug != "" {
		s.cleanupOldPageLocked(name, oldSlug, newSlug, path, newRelPath, fullPath, true)
	}

	// Update modtime
	var createdAt, modifiedAt *string
	if info, err := os.Stat(fullPath); err == nil {
		s.fileModTimes[fileModKey(name, newRelPath)] = info.ModTime().UnixNano()
		cTime, mTime := getFileTimes(info)
		cStr := cTime.Format(time.RFC3339)
		mStr := mTime.Format(time.RFC3339)
		createdAt = &cStr
		modifiedAt = &mStr
	}
	s.pageEntries[CacheKey{name, newSlug}] = PageEntry{
		Meta: models.PageMeta{
			Slug:       newSlug,
			PageName:   pageName,
			PageType:   "note",
			Location:   name,
			FileName:   filepath.ToSlash(newRelPath),
			CreatedAt:  createdAt,
			ModifiedAt: modifiedAt,
		},
		RelPath: newRelPath,
	}

	s.saveIndex()
	return newSlug, pageName, 0, ""
}

// DeleteNotePage removes a .md file; returns 404 if not found.
func (s *Store) DeleteNotePage(slug, location string) (int, string) {
	name, path, status, errMsg := s.ResolveWorkspace(location)
	if status != 0 {
		return status, errMsg
	}
	if name == "docs" {
		return 403, errDocsReadOnly
	}

	s.mu.Lock()
	entry, ok := s.pageEntries[CacheKey{name, slug}]
	s.mu.Unlock()
	if !ok {
		return 404, fmt.Sprintf("note '%s' not found", slug)
	}

	fullPath := filepath.Join(path, entry.RelPath)

	// Read content before deletion to find referenced media
	contentBytes, _ := os.ReadFile(fullPath)
	content := string(contentBytes)

	if err := os.Remove(fullPath); err != nil {
		return 500, fmt.Sprintf("deleting note: %v", err)
	}

	mediaDir := strings.TrimSuffix(fullPath, ".md")
	if entries, err := os.ReadDir(mediaDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				if strings.Contains(content, e.Name()) {
					_ = os.Remove(filepath.Join(mediaDir, e.Name()))
				}
			}
		}
		// os.Remove on a directory only succeeds if it is empty.
		_ = os.Remove(mediaDir)
	}

	s.mu.Lock()
	delete(s.pageEntries, CacheKey{name, slug})
	delete(s.fileModTimes, fileModKey(name, entry.RelPath))
	s.mu.Unlock()

	s.saveIndex()
	return 0, ""
}

// UpdateLinksAfterPageRename scans all grid pages and note pages in a location,
// updating any internal links that reference the renamed page.
// oldSlug and newSlug must be different; location should be the workspace name.
func (s *Store) UpdateLinksAfterPageRename(oldSlug, newSlug, location string) error {
	if oldSlug == newSlug {
		return nil // no change to slug; nothing to do
	}

	workspaceName, _, status, errMsg := s.ResolveWorkspace(location)
	if status != 0 {
		return fmt.Errorf("%s", errMsg)
	}
	if workspaceName == "docs" {
		return errors.New(errDocsReadOnly)
	}

	oldPath := workspacePagePath(workspaceName, oldSlug)
	newPath := workspacePagePath(workspaceName, newSlug)
	oldBarePath := "/" + oldSlug
	newBarePath := "/" + newSlug

	s.updateGridLinksAfterRename(workspaceName, location, oldPath, newPath, oldBarePath, newBarePath)
	return s.updateNoteLinksAfterRename(workspaceName, location, oldPath, newPath, oldBarePath, newBarePath)
}

func workspacePagePath(workspaceName, slug string) string {
	return fmt.Sprintf("/%s/%s", workspaceName, slug)
}

func isLegacyInternalPageLink(url, oldPath, oldBarePath string) bool {
	paths := []string{oldPath, oldBarePath}
	for _, path := range paths {
		if url == path ||
			url == "http://localhost:8000"+path ||
			url == "http://localhost:8001"+path {
			return true
		}
	}
	return false
}

func rewriteInternalPageLink(url, oldPath, newPath, oldBarePath, newBarePath string) string {
	if url == oldPath || strings.HasSuffix(url, oldPath) {
		return newPath
	}
	if url == oldBarePath || strings.HasSuffix(url, oldBarePath) {
		return newBarePath
	}
	return url
}

func (s *Store) gridPageSlugsInWorkspace(workspaceName string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	slugs := make([]string, 0)
	for k, entry := range s.pageEntries {
		if k.Location == workspaceName && entry.Meta.PageType == "grid" {
			slugs = append(slugs, k.Slug)
		}
	}
	return slugs
}

func (s *Store) updateGridLinksAfterRename(workspaceName, location, oldPath, newPath, oldBarePath, newBarePath string) {
	for _, pageSlug := range s.gridPageSlugsInWorkspace(workspaceName) {
		s.updateGridLinksInPage(pageSlug, location, oldPath, newPath, oldBarePath, newBarePath)
	}
}

func (s *Store) updateGridLinksInPage(pageSlug, location, oldPath, newPath, oldBarePath, newBarePath string) {
	page, status, _ := s.ReadPage(pageSlug, location)
	if status != 0 {
		return
	}

	updated := false
	for gi := range page.Groups {
		for ii := range page.Groups[gi].Items {
			item := &page.Groups[gi].Items[ii]
			if item.URL == nil || !isLegacyInternalPageLink(*item.URL, oldPath, oldBarePath) {
				continue
			}
			rewritten := rewriteInternalPageLink(*item.URL, oldPath, newPath, oldBarePath, newBarePath)
			if rewritten != *item.URL {
				*item.URL = rewritten
				updated = true
			}
		}
	}
	if updated {
		// Can't call s.WritePage here because updateGridLinksInPage is often called
		// inside a loop or already holding locks?
		// Actually WritePage locks. If we are not holding locks, we can call it.
		// Wait, updateGridLinksAfterRename calls gridPageSlugsInWorkspace (which locks/unlocks)
		// then updateGridLinksInPage (ReadPage locks/unlocks). So calling WritePage is fine!
		s.WritePage(pageSlug, page, location)
	}
}

func rewriteNoteLinks(content, oldPath, newPath, oldBarePath, newBarePath string) string {
	replacements := [][2]string{
		{"](" + oldPath, "](" + newPath},
		{"](http://localhost:8000" + oldPath, "](" + newPath},
		{"](http://localhost:8001" + oldPath, "](" + newPath},
		{"](" + oldBarePath, "](" + newBarePath},
		{"](http://localhost:8000" + oldBarePath, "](" + newBarePath},
		{"](http://localhost:8001" + oldBarePath, "](" + newBarePath},
	}

	updated := content
	for _, pair := range replacements {
		updated = strings.ReplaceAll(updated, pair[0], pair[1])
	}
	return updated
}

func (s *Store) updateNoteLinksAfterRename(workspaceName, location, oldPath, newPath, oldBarePath, newBarePath string) error {
	s.mu.RLock()
	var noteSlugs []string
	for k, entry := range s.pageEntries {
		if k.Location == workspaceName && entry.Meta.PageType == "note" {
			noteSlugs = append(noteSlugs, k.Slug)
		}
	}
	s.mu.RUnlock()

	for _, noteSlug := range noteSlugs {
		content, status, _ := s.ReadNotePage(noteSlug, location)
		if status != 0 {
			continue
		}

		updated := rewriteNoteLinks(content, oldPath, newPath, oldBarePath, newBarePath)
		if updated == content {
			continue
		}

		s.mu.RLock()
		entry, ok := s.pageEntries[CacheKey{workspaceName, noteSlug}]
		s.mu.RUnlock()
		if !ok {
			continue
		}

		_, path, status, _ := s.ResolveWorkspace(location)
		if status != 0 {
			continue
		}

		fullPath := filepath.Join(path, entry.RelPath)
		if err := os.WriteFile(fullPath, []byte(updated), 0o644); err != nil {
			fmt.Printf("[UpdateLinksAfterPageRename] failed to write note page %s: %v\n", noteSlug, err)
		}
	}

	return nil
}

// WriteWhiteboardPage writes an Excalidraw JSON file. When oldSlug is "" a conflict
// check is performed to avoid silently overwriting an existing whiteboard.
// Returns (newSlug, pageName, httpStatus, errMsg).
func (s *Store) WriteWhiteboardPage(oldSlug, content, location string) (string, string, int, string) {
	name, path, status, errMsg := s.ResolveWorkspace(location)
	if status != 0 {
		return "", "", status, errMsg
	}
	if name == "docs" {
		return "", "", 403, errDocsReadOnly
	}

	// Extract the page name from the wrapper JSON "page-name" field.
	var wrapper struct {
		PageName string `json:"page-name"`
	}
	if err := json.Unmarshal([]byte(content), &wrapper); err != nil || wrapper.PageName == "" {
		return "", "", 400, "whiteboard content must be valid JSON with a \"page-name\" field"
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	baseSlug := Slugify(wrapper.PageName)
	newSlug, err := s.generateUniqueSlugLocked(name, baseSlug, oldSlug)
	if err != nil {
		return "", "", 409, fmt.Sprintf("whiteboard '%s' already exists", baseSlug)
	}

	fileNameBase := LogicalToPhysicalPath(wrapper.PageName)
	if newSlug != baseSlug {
		fileNameBase += strings.TrimPrefix(newSlug, baseSlug)
	}
	newRelPath := fileNameBase + extExcalidraw
	fullPath := filepath.Join(path, newRelPath)

	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		return "", "", 500, fmt.Sprintf(msgCreatingDir, err)
	}

	// Pretty-print the JSON before writing so the file is human-readable
	// and produces clean git diffs.
	var raw any
	if err := json.Unmarshal([]byte(content), &raw); err != nil {
		return "", "", 400, "whiteboard content must be valid JSON"
	}
	pretty, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return "", "", 500, fmt.Sprintf("formatting whiteboard JSON: %v", err)
	}
	if err := os.WriteFile(fullPath, pretty, 0o644); err != nil {
		return "", "", 500, fmt.Sprintf("writing whiteboard: %v", err)
	}

	if oldSlug != "" {
		s.cleanupOldPageLocked(name, oldSlug, newSlug, path, newRelPath, fullPath, false)
	}

	var createdAt, modifiedAt *string
	if info, err := os.Stat(fullPath); err == nil {
		s.fileModTimes[fileModKey(name, newRelPath)] = info.ModTime().UnixNano()
		cTime, mTime := getFileTimes(info)
		cStr := cTime.Format(time.RFC3339)
		mStr := mTime.Format(time.RFC3339)
		createdAt = &cStr
		modifiedAt = &mStr
	}

	s.pageEntries[CacheKey{name, newSlug}] = PageEntry{
		Meta: models.PageMeta{
			Slug:       newSlug,
			PageName:   wrapper.PageName,
			PageType:   "whiteboard",
			Location:   name,
			FileName:   filepath.ToSlash(newRelPath),
			CreatedAt:  createdAt,
			ModifiedAt: modifiedAt,
		},
		RelPath: newRelPath,
	}

	return newSlug, wrapper.PageName, 0, ""
}

// ReadWhiteboardPage returns the raw JSON content of a .excalidraw file.
func (s *Store) ReadWhiteboardPage(slug, location string) (string, int, string) {
	name, path, status, errMsg := s.ResolveWorkspace(location)
	if status != 0 {
		return "", status, errMsg
	}

	s.mu.RLock()
	entry, ok := s.pageEntries[CacheKey{name, slug}]
	s.mu.RUnlock()

	if !ok {
		slog.Debug("ReadWhiteboardPage cache miss", "name", name, "slug", slug, "total_entries", len(s.pageEntries))
		return "", 404, fmt.Sprintf("whiteboard '%s' not found in memory cache", slug)
	}

	var data []byte
	var err error
	var fullPath string
	if name == "docs" {
		data, err = fs.ReadFile(s.docsFS, "docs/"+entry.RelPath)
	} else {
		fullPath = filepath.Join(path, entry.RelPath)
		data, err = ReadFileWithRetry(fullPath)
	}

	if err != nil {
		if os.IsNotExist(err) || errors.Is(err, fs.ErrNotExist) {
			return "", 404, fmt.Sprintf("whiteboard '%s' not found on disk at %s", slug, fullPath)
		}
		return "", 500, fmt.Sprintf("reading whiteboard: %v", err)
	}

	rawContent := string(data)
	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err == nil {
		if name, ok := parsed["page-name"].(string); !ok || name != entry.Meta.PageName {
			parsed["page-name"] = entry.Meta.PageName
			if modified, err := json.Marshal(parsed); err == nil {
				rawContent = string(modified)
			}
		}
	}

	return rawContent, 0, ""
}

// DeleteWhiteboardPage removes a .excalidraw file; returns 404 if not found.
func (s *Store) DeleteWhiteboardPage(slug, location string) (int, string) {
	name, path, status, errMsg := s.ResolveWorkspace(location)
	if status != 0 {
		return status, errMsg
	}
	if name == "docs" {
		return 403, errDocsReadOnly
	}

	s.mu.Lock()
	entry, ok := s.pageEntries[CacheKey{name, slug}]
	s.mu.Unlock()
	if !ok {
		return 404, fmt.Sprintf("whiteboard '%s' not found", slug)
	}

	fullPath := filepath.Join(path, entry.RelPath)
	if err := os.Remove(fullPath); err != nil {
		return 500, fmt.Sprintf("deleting whiteboard: %v", err)
	}

	s.mu.Lock()
	delete(s.pageEntries, CacheKey{name, slug})
	s.mu.Unlock()

	return 0, ""
}

// WriteBpmnPage writes a BPMN 2.0 XML file. When oldSlug is "" a conflict
// check is performed to avoid silently overwriting an existing BPMN page.
// Returns (newSlug, pageName, httpStatus, errMsg).
func (s *Store) WriteBpmnPage(oldSlug, content, location string) (string, string, int, string) {
	name, path, status, errMsg := s.ResolveWorkspace(location)
	if status != 0 {
		return "", "", status, errMsg
	}
	if name == "docs" {
		return "", "", 403, errDocsReadOnly
	}

	var wrapper struct {
		PageName string `json:"page-name"`
		BpmnXML  string `json:"bpmn_xml"`
	}
	if err := json.Unmarshal([]byte(content), &wrapper); err != nil || strings.TrimSpace(wrapper.PageName) == "" {
		return "", "", 400, "BPMN content must be valid JSON with a non-empty \"page-name\" field"
	}
	if strings.TrimSpace(wrapper.BpmnXML) == "" {
		return "", "", 400, "bpmn_xml cannot be empty"
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	baseSlug := Slugify(wrapper.PageName)
	newSlug, err := s.generateUniqueSlugLocked(name, baseSlug, oldSlug)
	if err != nil {
		return "", "", 409, fmt.Sprintf("BPMN diagram '%s' already exists", baseSlug)
	}

	fileNameBase := LogicalToPhysicalPath(wrapper.PageName)
	if newSlug != baseSlug {
		fileNameBase += strings.TrimPrefix(newSlug, baseSlug)
	}
	newRelPath := fileNameBase + extBPMN
	fullPath := filepath.Join(path, newRelPath)

	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		return "", "", 500, fmt.Sprintf(msgCreatingDir, err)
	}

	if err := os.WriteFile(fullPath, []byte(wrapper.BpmnXML), 0o644); err != nil {
		return "", "", 500, fmt.Sprintf("writing BPMN file: %v", err)
	}

	if oldSlug != "" {
		s.cleanupOldPageLocked(name, oldSlug, newSlug, path, newRelPath, fullPath, false)
	}

	var createdAt, modifiedAt *string
	if info, err := os.Stat(fullPath); err == nil {
		s.fileModTimes[fileModKey(name, newRelPath)] = info.ModTime().UnixNano()
		cTime, mTime := getFileTimes(info)
		cStr := cTime.Format(time.RFC3339)
		mStr := mTime.Format(time.RFC3339)
		createdAt = &cStr
		modifiedAt = &mStr
	}

	s.pageEntries[CacheKey{name, newSlug}] = PageEntry{
		Meta: models.PageMeta{
			Slug:       newSlug,
			PageName:   wrapper.PageName,
			PageType:   "bpmn",
			Location:   name,
			FileName:   filepath.ToSlash(newRelPath),
			CreatedAt:  createdAt,
			ModifiedAt: modifiedAt,
		},
		RelPath: newRelPath,
	}

	s.saveIndex()
	return newSlug, wrapper.PageName, 0, ""
}

// ReadBpmnPage returns the JSON representation {"page-name": "...", "bpmn_xml": "..."} of a .bpmn file.
func (s *Store) ReadBpmnPage(slug, location string) (string, int, string) {
	name, path, status, errMsg := s.ResolveWorkspace(location)
	if status != 0 {
		return "", status, errMsg
	}

	s.mu.RLock()
	entry, ok := s.pageEntries[CacheKey{name, slug}]
	s.mu.RUnlock()

	if !ok {
		slog.Debug("ReadBpmnPage cache miss", "name", name, "slug", slug, "total_entries", len(s.pageEntries))
		return "", 404, fmt.Sprintf("BPMN diagram '%s' not found in memory cache", slug)
	}

	var data []byte
	var err error
	var fullPath string
	if name == "docs" {
		data, err = fs.ReadFile(s.docsFS, "docs/"+entry.RelPath)
	} else {
		fullPath = filepath.Join(path, entry.RelPath)
		data, err = ReadFileWithRetry(fullPath)
	}

	if err != nil {
		if os.IsNotExist(err) || errors.Is(err, fs.ErrNotExist) {
			return "", 404, fmt.Sprintf("BPMN diagram '%s' not found on disk at %s", slug, fullPath)
		}
		return "", 500, fmt.Sprintf("reading BPMN file: %v", err)
	}

	resp := map[string]string{
		"page-name": entry.Meta.PageName,
		"bpmn_xml":  string(data),
	}
	out, err := json.Marshal(resp)
	if err != nil {
		return "", 500, fmt.Sprintf("encoding BPMN response: %v", err)
	}

	return string(out), 0, ""
}

// DeleteBpmnPage removes a .bpmn file; returns 404 if not found.
func (s *Store) DeleteBpmnPage(slug, location string) (int, string) {
	name, path, status, errMsg := s.ResolveWorkspace(location)
	if status != 0 {
		return status, errMsg
	}
	if name == "docs" {
		return 403, errDocsReadOnly
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.pageEntries[CacheKey{name, slug}]
	if !ok {
		return 404, fmt.Sprintf("BPMN diagram '%s' not found", slug)
	}

	fullPath := filepath.Join(path, entry.RelPath)
	if err := os.Remove(fullPath); err != nil {
		return 500, fmt.Sprintf("deleting BPMN file: %v", err)
	}

	delete(s.pageEntries, CacheKey{name, slug})
	delete(s.fileModTimes, fileModKey(name, entry.RelPath))
	s.saveIndex()

	return 0, ""
}

// itemDueStatus returns "overdue", "due_soon", or "" for a single task item.
func itemDueStatus(item models.Item, today, tomorrow time.Time) string {
	if item.TaskChecked == nil || *item.TaskChecked || item.TaskDueDate == nil {
		return ""
	}
	due, err := time.Parse("2006-01-02", *item.TaskDueDate)
	if err != nil {
		return ""
	}
	due = due.UTC().Truncate(24 * time.Hour)
	if !due.After(today) {
		return "overdue"
	}
	if due.Equal(tomorrow) {
		return "due_soon"
	}
	return ""
}

// GetPageTaskStatus scans unchecked task items and returns the aggregate status.
func GetPageTaskStatus(page models.Page) string {
	today := time.Now().UTC().Truncate(24 * time.Hour)
	tomorrow := today.Add(24 * time.Hour)
	status := ""

	for _, group := range page.Groups {
		for _, item := range group.Items {
			s := itemDueStatus(item, today, tomorrow)
			if s == "overdue" {
				return "overdue"
			}
			if s == "due_soon" {
				status = "due_soon"
			}
		}
	}
	return status
}

// LogicalToPhysicalPath converts a page name (e.g. "A / B / C") into a safe relative file path (e.g. "A/B/C").
// It preserves capitalization and spaces within path segments, only replacing forbidden OS characters.
func LogicalToPhysicalPath(pageName string) string {
	parts := strings.Split(pageName, "/")
	var safeParts []string

	// Characters forbidden on Windows and common filesystems
	forbidden := regexp.MustCompile(`[<>:"/\\|?*]+`)

	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if trimmed == "" {
			continue
		}
		safePart := forbidden.ReplaceAllString(trimmed, "-")
		// Prevent parts that are entirely periods (like "." or "..")
		if strings.Trim(safePart, ".") == "" {
			safePart = "dot"
		}
		safeParts = append(safeParts, safePart)
	}

	if len(safeParts) == 0 {
		return "Untitled"
	}
	return filepath.Join(safeParts...)
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

// Slugify converts a page name to a safe filename slug.
// Transliterates German Umlaute before replacing other special characters.
func Slugify(name string) string {
	s := strings.ToLower(name)
	s = strings.ReplaceAll(s, "ä", "ae")
	s = strings.ReplaceAll(s, "ö", "oe")
	s = strings.ReplaceAll(s, "ü", "ue")
	s = strings.ReplaceAll(s, "ß", "ss")

	s = slugRe.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	return s
}

// SanitizeFilename removes or replaces special characters in a filename while preserving the extension.
// It converts spaces and special characters to hyphens, making the filename safe for URLs and filesystems.
func SanitizeFilename(filename string) string {
	// Separate filename from extension
	idx := strings.LastIndexByte(filename, '.')
	var name, ext string
	if idx > 0 && idx < len(filename)-1 {
		name = filename[:idx]
		ext = strings.ToLower(filename[idx:]) // Lowercase the extension too
	} else {
		name = filename
		ext = ""
	}

	// Sanitize the name part: replace spaces and special chars with hyphens
	sanitized := strings.ToLower(name)
	// Keep only alphanumeric, hyphens, and underscores; replace everything else with hyphen
	fileNameRe := regexp.MustCompile(`[^a-z0-9_-]+`)
	sanitized = fileNameRe.ReplaceAllString(sanitized, "-")
	sanitized = strings.Trim(sanitized, "-")

	// Reconstruct with extension
	if ext != "" {
		return sanitized + ext
	}
	return sanitized
}

// ExtractH1FromReader returns the content of the first # Heading 1 line from an io.Reader, or "".
// It stops reading after finding the heading to avoid buffering entire large files.
func ExtractH1FromReader(r io.Reader) string {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "# ") {
			return strings.TrimSpace(line[2:])
		}
	}
	if err := scanner.Err(); err != nil {
		return ""
	}
	return ""
}

// ExtractBpmnNameFromReader scans XML tokens to extract the name attribute of a process or definitions element.
func ExtractBpmnNameFromReader(r io.Reader) string {
	decoder := xml.NewDecoder(r)
	for {
		tok, err := decoder.Token()
		if err != nil {
			break
		}
		if se, ok := tok.(xml.StartElement); ok {
			if strings.EqualFold(se.Name.Local, "process") || strings.EqualFold(se.Name.Local, "definitions") {
				for _, attr := range se.Attr {
					if strings.EqualFold(attr.Name.Local, "name") && strings.TrimSpace(attr.Value) != "" {
						return strings.TrimSpace(attr.Value)
					}
				}
			}
		}
	}
	return ""
}

// ExtractH1 returns the content of the first # Heading 1 line, or "".
func ExtractH1(content string) string {
	for _, line := range strings.Split(content, "\n") {
		if strings.HasPrefix(line, "# ") {
			return strings.TrimSpace(line[2:])
		}
	}
	return ""
}

// marshalPage serialises a Page omitting null/empty optional Item fields.
func marshalPage(page models.Page) ([]byte, error) {
	return json.MarshalIndent(page, "", "  ")
}

// deepCopyPage returns a value copy of a Page (items are value types so a
// single level of slice copy is sufficient).

// ParseWorkspaces converts the workspaces value from config into a map.
// Accepts nil (defaults to empty map), a slice of
// maps (for ordered workspaces array), or a map[string]any (legacy format).
// Relative location paths are resolved from relativeBaseDir.
func ParseWorkspaces(raw interface{}, defaultDataDir, relativeBaseDir string) (map[string]WorkspaceConfig, []string, error) {
	if raw == nil {
		return make(map[string]WorkspaceConfig), []string{}, nil
	}

	if slice, ok := raw.([]interface{}); ok {
		if len(slice) == 0 {
			return make(map[string]WorkspaceConfig), []string{}, nil
		}
		return parseSliceWorkspaces(slice, relativeBaseDir)
	}

	m, ok := raw.(map[string]interface{})
	if !ok {
		return nil, nil, fmt.Errorf("workspaces must be an array or object")
	}
	if len(m) == 0 {
		return make(map[string]WorkspaceConfig), []string{}, nil
	}
	return parseMapWorkspaces(m, relativeBaseDir)
}

func parseSliceWorkspaces(slice []interface{}, relativeBaseDir string) (map[string]WorkspaceConfig, []string, error) {
	result := make(map[string]WorkspaceConfig, len(slice))
	order := make([]string, 0, len(slice))
	for i, val := range slice {
		vMap, ok := val.(map[string]interface{})
		if !ok {
			return nil, nil, fmt.Errorf("workspaces[%d] must be an object", i)
		}
		name, _ := vMap["name"].(string)
		name = strings.TrimSpace(name)
		if name == "" {
			return nil, nil, fmt.Errorf("workspaces[%d] must have a non-empty name", i)
		}
		pathVal, _ := vMap["path"].(string)
		if pathVal == "" {
			return nil, nil, fmt.Errorf("workspaces[%d] must have a non-empty path", i)
		}
		fernetKey, _ := vMap["fernet_key"].(string)
		hidden, _ := vMap["hidden"].(bool)
		if _, exists := result[name]; !exists {
			result[name] = WorkspaceConfig{Path: resolvePath(pathVal, relativeBaseDir), FernetKey: fernetKey, Hidden: hidden}
			order = append(order, name)
		}
	}
	return result, order, nil
}

func parseMapWorkspaces(m map[string]interface{}, relativeBaseDir string) (map[string]WorkspaceConfig, []string, error) {
	result := make(map[string]WorkspaceConfig, len(m))
	order := make([]string, 0, len(m))
	for name, val := range m {
		name = strings.TrimSpace(name)
		lc, err := parseWorkspaceEntry(name, val, relativeBaseDir)
		if err != nil {
			return nil, nil, err
		}
		result[name] = lc
		order = append(order, name)
	}
	sort.Strings(order)
	return result, order, nil
}

func parseWorkspaceEntry(name string, val interface{}, relativeBaseDir string) (WorkspaceConfig, error) {
	switch v := val.(type) {
	case string:
		return WorkspaceConfig{Path: resolvePath(v, relativeBaseDir)}, nil
	case map[string]interface{}:
		pathVal, _ := v["path"].(string)
		if pathVal == "" {
			return WorkspaceConfig{}, fmt.Errorf("workspaces[%q] must have a non-empty path", name)
		}
		fernetKey, _ := v["fernet_key"].(string)
		hidden, _ := v["hidden"].(bool)
		return WorkspaceConfig{Path: resolvePath(pathVal, relativeBaseDir), FernetKey: fernetKey, Hidden: hidden}, nil
	default:
		return WorkspaceConfig{}, fmt.Errorf("workspaces[%q] must be a path string or object", name)
	}
}

func resolvePath(p, baseDir string) string {
	if filepath.IsAbs(p) {
		return p
	}
	// Treat relative paths as relative to the executable/config directory.
	return filepath.Clean(filepath.Join(baseDir, p))
}

func (s *Store) addSearchIndexItemsLocked(page models.Page, loc, slug string) {
	if page.Hidden {
		return
	}
	for gIdx, group := range page.Groups {
		for iIdx, item := range group.Items {
			l := loc
			res := models.SearchResult{
				Location:   &l,
				Slug:       slug,
				PageName:   page.PageName,
				GroupIndex: gIdx,
				ItemIndex:  iIdx,
				Title:      item.Title,
				URL:        item.URL,
				ItemType:   item.ItemType(),
			}
			s.searchIndex = append(s.searchIndex, res)
		}
	}
}

func (s *Store) removeSearchIndexItemsLocked(loc, slug string) {
	newIdx := make([]models.SearchResult, 0, len(s.searchIndex))
	for _, res := range s.searchIndex {
		l := ""
		if res.Location != nil {
			l = *res.Location
		}
		if l == loc && res.Slug == slug {
			continue
		}
		newIdx = append(newIdx, res)
	}
	s.searchIndex = newIdx
}

func fileModKey(locName, relPath string) string {
	return fmt.Sprintf("%s:%s", locName, strings.ToLower(filepath.ToSlash(relPath)))
}

func (s *Store) removePageByRelPathLocked(locName, relPath string) {
	var toDelete []CacheKey
	target := strings.ToLower(filepath.ToSlash(relPath))
	for k, entry := range s.pageEntries {
		if k.Location == locName && strings.ToLower(filepath.ToSlash(entry.RelPath)) == target {
			toDelete = append(toDelete, k)
		}
	}
	for _, k := range toDelete {
		delete(s.pageEntries, k)
		s.removeSearchIndexItemsLocked(k.Location, k.Slug)
		s.removeTaskIndexItemsLocked(k.Location, k.Slug)
	}
}

func (s *Store) addTaskIndexItemsLocked(page models.Page, loc, slug string) {
	if page.Hidden {
		return
	}
	for gIdx, group := range page.Groups {
		for iIdx, item := range group.Items {
			if item.TaskChecked == nil || *item.TaskChecked {
				continue
			}
			dueDate := ""
			if item.TaskDueDate != nil {
				dueDate = *item.TaskDueDate
			}
			var taskCreated string
			if item.TaskCreated != nil {
				taskCreated = *item.TaskCreated
			}
			var createdAt string
			if item.CreatedAt != nil {
				createdAt = *item.CreatedAt
			}
			taskItem := models.TaskIndexItem{
				Location:    loc,
				Slug:        slug,
				PageName:    page.PageName,
				GroupTitle:  group.Title,
				GroupIndex:  gIdx,
				ItemIndex:   iIdx,
				Title:       item.Title,
				TaskDueDate: dueDate,
				TaskChecked: false,
				TaskCreated: taskCreated,
				CreatedAt:   createdAt,
			}
			s.taskIndex = append(s.taskIndex, taskItem)
		}
	}
}

func (s *Store) removeTaskIndexItemsLocked(loc, slug string) {
	newIdx := make([]models.TaskIndexItem, 0, len(s.taskIndex))
	for _, item := range s.taskIndex {
		if item.Location == loc && item.Slug == slug {
			continue
		}
		newIdx = append(newIdx, item)
	}
	s.taskIndex = newIdx
}

func (s *Store) populateTaskIndexFromDiskLocked() {
	s.taskIndex = nil
	for k, entry := range s.pageEntries {
		if entry.Meta.PageType != "grid" || entry.Meta.Hidden {
			continue
		}
		lc, ok := s.workspaces[k.Location]
		if !ok {
			continue
		}
		data, err := ReadFileWithRetry(filepath.Join(lc.Path, entry.RelPath))
		if err != nil {
			continue
		}
		var page models.Page
		if err := json.Unmarshal(data, &page); err != nil {
			continue
		}
		page.PageName = entry.Meta.PageName
		s.addTaskIndexItemsLocked(page, k.Location, k.Slug)
	}
}

// GetDueTasks returns all unchecked tasks with due date today or earlier (overdue)
// or tomorrow (due soon) across visible, non-hidden workspaces and non-hidden pages.
func (s *Store) GetDueTasks() []models.DueTask {
	s.mu.RLock()
	defer s.mu.RUnlock()

	visibleWorkspaces := make(map[string]bool)
	for _, name := range s.workspaceOrd {
		if lc, ok := s.workspaces[name]; ok && !lc.Hidden {
			visibleWorkspaces[name] = true
		}
	}

	today := time.Now().UTC().Truncate(24 * time.Hour)
	tomorrow := today.Add(24 * time.Hour)

	var results []models.DueTask
	for _, item := range s.taskIndex {
		if !visibleWorkspaces[item.Location] {
			continue
		}
		entry, ok := s.pageEntries[CacheKey{item.Location, item.Slug}]
		if !ok || entry.Meta.Hidden {
			continue
		}

		due, err := time.Parse("2006-01-02", item.TaskDueDate)
		if err != nil {
			continue
		}
		due = due.UTC().Truncate(24 * time.Hour)

		var status string
		if !due.After(today) {
			status = "overdue"
		} else if due.Equal(tomorrow) {
			status = "due_soon"
		} else {
			continue
		}

		pageName := entry.Meta.PageName
		if pageName == "" {
			pageName = item.PageName
		}

		results = append(results, models.DueTask{
			Location:   item.Location,
			Slug:       item.Slug,
			PageName:   pageName,
			GroupTitle: item.GroupTitle,
			GroupIndex: item.GroupIndex,
			ItemIndex:  item.ItemIndex,
			Title:      item.Title,
			DueDate:    item.TaskDueDate,
			DueStatus:  status,
		})
	}

	sort.SliceStable(results, func(i, j int) bool {
		if results[i].DueStatus != results[j].DueStatus {
			return results[i].DueStatus == "overdue"
		}
		if results[i].DueDate != results[j].DueDate {
			return results[i].DueDate < results[j].DueDate
		}
		if results[i].Location != results[j].Location {
			return results[i].Location < results[j].Location
		}
		return results[i].Title < results[j].Title
	})

	if results == nil {
		results = []models.DueTask{}
	}
	return results
}

func parseFlexibleTime(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	formats := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05",
		"2006-01-02",
	}
	for _, f := range formats {
		if t, err := time.Parse(f, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// GetAllTasks returns all unchecked tasks across visible, non-hidden workspaces and non-hidden pages,
// sorted by:
// 1. Tasks with a due date (earliest due date first, tie-breaking by created date)
// 2. Created date (earliest created date first)
func (s *Store) GetAllTasks() []models.Task {
	s.mu.RLock()
	defer s.mu.RUnlock()

	visibleWorkspaces := make(map[string]bool)
	for _, name := range s.workspaceOrd {
		if lc, ok := s.workspaces[name]; ok && !lc.Hidden {
			visibleWorkspaces[name] = true
		}
	}

	today := time.Now().UTC().Truncate(24 * time.Hour)
	tomorrow := today.Add(24 * time.Hour)

	var results []models.Task
	for _, item := range s.taskIndex {
		if !visibleWorkspaces[item.Location] {
			continue
		}
		entry, ok := s.pageEntries[CacheKey{item.Location, item.Slug}]
		if !ok || entry.Meta.Hidden {
			continue
		}

		var status string
		if item.TaskDueDate != "" {
			if due, err := time.Parse("2006-01-02", item.TaskDueDate); err == nil {
				due = due.UTC().Truncate(24 * time.Hour)
				if !due.After(today) {
					status = "overdue"
				} else if due.Equal(tomorrow) {
					status = "due_soon"
				} else {
					status = "upcoming"
				}
			}
		}

		pageName := entry.Meta.PageName
		if pageName == "" {
			pageName = item.PageName
		}

		results = append(results, models.Task{
			Location:    item.Location,
			Slug:        item.Slug,
			PageName:    pageName,
			GroupTitle:  item.GroupTitle,
			GroupIndex:  item.GroupIndex,
			ItemIndex:   item.ItemIndex,
			Title:       item.Title,
			DueDate:     item.TaskDueDate,
			DueStatus:   status,
			TaskCreated: item.TaskCreated,
			CreatedAt:   item.CreatedAt,
		})
	}

	sort.SliceStable(results, func(i, j int) bool {
		hasDueI := results[i].DueDate != ""
		hasDueJ := results[j].DueDate != ""
		if hasDueI != hasDueJ {
			return hasDueI
		}
		if hasDueI && hasDueJ && results[i].DueDate != results[j].DueDate {
			return results[i].DueDate < results[j].DueDate
		}

		cI := results[i].TaskCreated
		if cI == "" {
			cI = results[i].CreatedAt
		}
		cJ := results[j].TaskCreated
		if cJ == "" {
			cJ = results[j].CreatedAt
		}
		if cI != cJ {
			if cI == "" {
				return false
			}
			if cJ == "" {
				return true
			}
			tI, okI := parseFlexibleTime(cI)
			tJ, okJ := parseFlexibleTime(cJ)
			if okI && okJ {
				if !tI.Equal(tJ) {
					return tI.Before(tJ)
				}
			} else {
				return cI < cJ
			}
		}

		if results[i].Location != results[j].Location {
			return results[i].Location < results[j].Location
		}
		return results[i].Title < results[j].Title
	})

	if results == nil {
		results = []models.Task{}
	}
	return results
}

// ReadFileWithRetry attempts to read a file, retrying on temporary errors.
func ReadFileWithRetry(name string) ([]byte, error) {
	var data []byte
	var err error
	for i := 0; i < 20; i++ {
		data, err = os.ReadFile(name)
		if err == nil {
			return data, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil, err
}
