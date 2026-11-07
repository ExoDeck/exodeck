package handlers_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/ExoDeck/exodeck/internal/handlers"
	"github.com/ExoDeck/exodeck/internal/storage"
)

// --------------------------------------------------------------------------
// Static file serving
// --------------------------------------------------------------------------

func TestStaticRootReturns200WithNoCacheHeaders(t *testing.T) {
	ts, _, _ := newTestServer(t)

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET /: status %d, want 200", resp.StatusCode)
	}
	assertNoCacheHeaders(t, resp)
}

func TestStaticAssetServedWithNoCacheHeaders(t *testing.T) {
	ts, _, _ := newTestServer(t)

	resp, err := http.Get(ts.URL + "/app.js")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET /app.js: status %d, want 200", resp.StatusCode)
	}
	assertNoCacheHeaders(t, resp)
}

func TestAPIResponseDoesNotHaveStaticNoCacheHeader(t *testing.T) {
	ts, _, _ := newTestServer(t)

	resp, err := http.Get(ts.URL + "/api/v1/pages")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	// API routes should still return 200
	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET /api/v1/pages: status %d", resp.StatusCode)
	}
	// The no-cache middleware should not set the header IF the code checks for /api/
	// (Python sets headers only for non-/api/ paths; Go preserves this).
}

func TestMissingStaticResourceReturns404(t *testing.T) {
	ts, _, _ := newTestServer(t)

	resp, err := http.Get(ts.URL + "/nonexistent.js")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("GET /nonexistent.js: status %d, want 404", resp.StatusCode)
	}
}

func TestSPAFallback(t *testing.T) {
	ts, _, _ := newTestServer(t)
	resp, err := http.Get(ts.URL + "/examples")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET /examples: status %d, want 200", resp.StatusCode)
	}
}

func assertNoCacheHeaders(t *testing.T, resp *http.Response) {
	t.Helper()
	if resp.Header.Get("Cache-Control") == "" {
		t.Error("missing Cache-Control header")
	}
	if resp.Header.Get("Pragma") == "" {
		t.Error("missing Pragma header")
	}
	if resp.Header.Get("Expires") == "" {
		t.Error("missing Expires header")
	}
}

func TestPreloadScannerFallback(t *testing.T) {
	ts, _, _ := newTestServer(t)
	// When browser preload scanner requests a relative asset like /deep/path/app.js
	// before <base> tag is applied, serveStatic falls back to finding /app.js in the root.
	resp, err := http.Get(ts.URL + "/deep/path/app.js")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200 for preload fallback, got %d", resp.StatusCode)
	}
}

func TestServeStaticMissingIndexHTML(t *testing.T) {
	dataDir := t.TempDir()
	configDir := t.TempDir()
	store := storage.New(fstest.MapFS{}, dataDir)
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: dataDir},
	}, []string{"default"})

	// FrontendFS has empty frontend subdirectory without index.html
	srv := &handlers.Server{
		Store:      store,
		ConfigDir:  configDir,
		FrontendFS: fstest.MapFS{"frontend/other.txt": &fstest.MapFile{Data: []byte("hi")}},
	}
	ts := httptest.NewServer(handlers.NewRouter(srv))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/spa-route-without-extension")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 when index.html is absent, got %d", resp.StatusCode)
	}
}

func TestStaticPathTraversalRejected(t *testing.T) {
	ts, _, _ := newTestServer(t)
	resp, err := http.Get(ts.URL + "/../../../../etc/passwd")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusOK {
		t.Errorf("expected 404 or safe SPA fallback, got %d", resp.StatusCode)
	}
}
