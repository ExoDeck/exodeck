package handlers_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/ExoDeck/exodeck/internal/handlers"
	"github.com/ExoDeck/exodeck/internal/models"
	"github.com/ExoDeck/exodeck/internal/storage"
)

// newTestServer creates a fully wired test server with an isolated temp data dir.
// It uses a stub embedded FS for the frontend.
func newTestServer(t *testing.T) (*httptest.Server, *storage.Store, string) {
	t.Helper()
	dataDir := t.TempDir()
	configDir := t.TempDir()

	store := storage.New(fstest.MapFS{}, os.TempDir())
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: dataDir},
	}, []string{"default"})

	srv := &handlers.Server{
		Store:      store,
		ConfigDir:  configDir,
		FrontendFS: stubFrontendFS,
	}
	ts := httptest.NewServer(handlers.NewRouter(srv))
	t.Cleanup(ts.Close)
	return ts, store, dataDir
}

// newTestServerMultiLocation creates a server with two data locations.
func newTestServerMultiLocation(t *testing.T) (*httptest.Server, *storage.Store, string, string) {
	t.Helper()
	defaultDir := t.TempDir()
	workDir := t.TempDir()
	configDir := t.TempDir()

	store := storage.New(fstest.MapFS{}, os.TempDir())
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: defaultDir},
		"work":    {Path: workDir},
	}, []string{"default", "work"})

	srv := &handlers.Server{
		Store:      store,
		ConfigDir:  configDir,
		FrontendFS: stubFrontendFS,
	}
	ts := httptest.NewServer(handlers.NewRouter(srv))
	t.Cleanup(ts.Close)
	return ts, store, defaultDir, workDir
}

// get performs a GET and returns the parsed JSON body and HTTP status.
func get(t *testing.T, ts *httptest.Server, path string) (int, map[string]interface{}) {
	t.Helper()
	resp, err := http.Get(ts.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	var v map[string]interface{}
	_ = json.Unmarshal(body, &v)
	return resp.StatusCode, v
}

func post(t *testing.T, ts *httptest.Server, path string, payload interface{}) (int, map[string]interface{}) {
	t.Helper()
	data, _ := json.Marshal(payload)
	resp, err := http.Post(ts.URL+path, "application/json", bytes.NewReader(data))
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	var v map[string]interface{}
	_ = json.Unmarshal(body, &v)
	return resp.StatusCode, v
}

func put(t *testing.T, ts *httptest.Server, path string, payload interface{}) (int, map[string]interface{}) {
	t.Helper()
	data, _ := json.Marshal(payload)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+path, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT %s: %v", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	var v map[string]interface{}
	_ = json.Unmarshal(body, &v)
	return resp.StatusCode, v
}

func del(t *testing.T, ts *httptest.Server, path string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodDelete, ts.URL+path, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("DELETE %s: %v", path, err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

// writePageToDisk writes a minimal page JSON directly to dataDir for pre-seeding.
func writePageToDisk(t *testing.T, dir, slug string, page models.Page) {
	t.Helper()
	data, err := json.MarshalIndent(page, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, slug+".grid"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// stubFrontendFS is a minimal fs.FS with a frontend/index.html for static serving.
var stubFrontendFS = fstest.MapFS{
	"frontend/index.html": {Data: []byte("<html>test</html>")},
	"frontend/app.js":     {Data: []byte("// app")},
}

// newTestServerWithKey creates a server with a single keyed location.
func newTestServerWithKey(t *testing.T, dataDir, configDir, fernetKey string) (*storage.Store, *httptest.Server) {
	t.Helper()
	store := storage.New(fstest.MapFS{}, os.TempDir())
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: dataDir, FernetKey: fernetKey},
	}, []string{"default"})
	srv := &handlers.Server{
		Store:      store,
		ConfigDir:  configDir,
		FrontendFS: stubFrontendFS,
	}
	ts := httptest.NewServer(handlers.NewRouter(srv))
	t.Cleanup(ts.Close)
	return store, ts
}

// newTestServerFull returns (ts, store, dataDir, configDir) for tests that need both dirs.
func newTestServerFull(t *testing.T) (*httptest.Server, *storage.Store, string, string) {
	t.Helper()
	dataDir := t.TempDir()
	configDir := t.TempDir()

	store := storage.New(fstest.MapFS{}, os.TempDir())
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: dataDir},
	}, []string{"default"})
	srv := &handlers.Server{
		Store:      store,
		ConfigDir:  configDir,
		FrontendFS: stubFrontendFS,
	}
	ts := httptest.NewServer(handlers.NewRouter(srv))
	t.Cleanup(ts.Close)
	return ts, store, dataDir, configDir
}
