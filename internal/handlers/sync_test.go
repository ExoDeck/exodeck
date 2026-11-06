package handlers_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/ExoDeck/exodeck/internal/handlers"
	"github.com/ExoDeck/exodeck/internal/storage"
)

// --------------------------------------------------------------------------
// Sync tests — these call syncStatusForLocation / syncData via the public API
// so we exercise the real HTTP layer but with a mocked GitRunner injected
// through the Server.GitRunner field.
//
// Because the Server struct doesn't expose GitRunner publicly yet we test the
// endpoint through newTestServer (which uses RealGitRunner). Tests that need
// a mock runner test the helper function directly.
// --------------------------------------------------------------------------

func TestSyncStatusDisabled(t *testing.T) {
	ts, _, configDir := newTestServer(t)

	// No config.json → enable_git_sync defaults to false
	_ = configDir

	resp, err := http.Get(ts.URL + "/api/v1/sync/status")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("sync/status: %d", resp.StatusCode)
	}
}

func TestSyncPostDisabledReturns403(t *testing.T) {
	ts, _, _ := newTestServer(t)

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/sync", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("sync POST disabled: %d, want 403", resp.StatusCode)
	}
}

// --------------------------------------------------------------------------
// Unit-level tests using the exported syncStatusForLocation helper surface
// (we can't inject a runner via the handler; instead we test via the real HTTP
// server and rely on the git binary being available or returning an error).
// --------------------------------------------------------------------------

func TestSyncStatusAllEndpoint(t *testing.T) {
	ts, _, _ := newTestServer(t)

	resp, err := http.Get(ts.URL + "/api/v1/sync/status/all")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("sync/status/all: %d", resp.StatusCode)
	}
}

type mockGitRunner struct {
	fn func(ctx context.Context, cwd string, args ...string) (int, string, string)
}

func (m mockGitRunner) Run(ctx context.Context, cwd string, args ...string) (int, string, string) {
	return m.fn(ctx, cwd, args...)
}

func TestSyncWithMockRunner(t *testing.T) {
	dataDir := t.TempDir()
	configDir := t.TempDir()

	// Write config with enable_git_sync = true
	cfgJSON := `{"enable_git_sync": true}`
	_ = os.WriteFile(filepath.Join(configDir, "config.json"), []byte(cfgJSON), 0o644)

	store := storage.New(fstest.MapFS{}, os.TempDir())
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: dataDir},
	}, []string{"default"})

	mock := mockGitRunner{
		fn: func(ctx context.Context, cwd string, args ...string) (int, string, string) {
			if len(args) > 0 && args[0] == "rev-parse" {
				return 0, dataDir, ""
			}
			if len(args) > 0 && args[0] == "status" {
				return 0, " M modified-file.json\n", ""
			}
			return 0, "ok", ""
		},
	}

	srv := &handlers.Server{
		Store:      store,
		ConfigDir:  configDir,
		FrontendFS: stubFrontendFS,
		GitRunner:  mock,
	}
	ts := httptest.NewServer(handlers.NewRouter(srv))
	defer ts.Close()

	// 1. Status endpoint
	resp, err := http.Get(ts.URL + "/api/v1/sync/status")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var statusBody map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&statusBody)
	if statusBody["enabled"] != true || statusBody["uncommitted"] != true {
		t.Errorf("unexpected status body: %+v", statusBody)
	}

	// 2. Status all endpoint
	respAll, err := http.Get(ts.URL + "/api/v1/sync/status/all")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = respAll.Body.Close() }()
	if respAll.StatusCode != http.StatusOK {
		t.Errorf("expected 200 for sync/status/all, got %d", respAll.StatusCode)
	}

	// 3. Sync POST succeeds
	postResp, err := http.Post(ts.URL+"/api/v1/sync?location=default", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = postResp.Body.Close() }()
	if postResp.StatusCode != http.StatusOK {
		t.Errorf("expected 200 for sync POST, got %d", postResp.StatusCode)
	}

	// 4. Sync POST fails when git fails
	srv.GitRunner = mockGitRunner{
		fn: func(ctx context.Context, cwd string, args ...string) (int, string, string) {
			if len(args) > 0 && args[0] == "rev-parse" {
				return 0, dataDir, ""
			}
			if len(args) > 0 && args[0] == "pull" {
				return 1, "", "conflict error"
			}
			return 0, "", ""
		},
	}
	failResp, err := http.Post(ts.URL+"/api/v1/sync?location=default", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = failResp.Body.Close() }()
	if failResp.StatusCode != http.StatusInternalServerError {
		t.Errorf("expected 500 when git pull fails, got %d", failResp.StatusCode)
	}
}

func TestRealGitRunner(t *testing.T) {
	runner := handlers.RealGitRunner{}
	// Run git version
	_, _, _ = runner.Run(context.Background(), t.TempDir(), "version")

	// Cancelled context to trigger non-zero exit code / error branch
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rc, _, _ := runner.Run(ctx, t.TempDir(), "status")
	if rc == 0 {
		t.Errorf("expected non-zero exit code for cancelled context")
	}
}

func TestSyncEdgeCases(t *testing.T) {
	dataDir := t.TempDir()
	configDir := t.TempDir()

	cfgJSON := `{"enable_git_sync": true}`
	_ = os.WriteFile(filepath.Join(configDir, "config.json"), []byte(cfgJSON), 0o644)

	store := storage.New(fstest.MapFS{}, os.TempDir())
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: dataDir},
		"docs":    {Path: t.TempDir()},
	}, []string{"default", "docs"})

	mock := mockGitRunner{
		fn: func(ctx context.Context, cwd string, args ...string) (int, string, string) {
			return 0, dataDir, ""
		},
	}

	srv := &handlers.Server{
		Store:      store,
		ConfigDir:  configDir,
		FrontendFS: stubFrontendFS,
		GitRunner:  mock,
	}
	ts := httptest.NewServer(handlers.NewRouter(srv))
	defer ts.Close()

	// 1. Docs workspace returns 403
	resp, _ := http.Post(ts.URL+"/api/v1/sync?location=docs", "application/json", nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("expected 403 for docs sync, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 2. rev-parse fails (not a git repo) -> 400
	srv.GitRunner = mockGitRunner{
		fn: func(ctx context.Context, cwd string, args ...string) (int, string, string) {
			if len(args) > 0 && args[0] == "rev-parse" {
				return 1, "", "fatal: not a git repo"
			}
			return 0, "", ""
		},
	}
	resp, _ = http.Post(ts.URL+"/api/v1/sync?location=default", "application/json", nil)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 when not a git repo, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 3. toplevel != dataDir (not root of repo) -> 400
	srv.GitRunner = mockGitRunner{
		fn: func(ctx context.Context, cwd string, args ...string) (int, string, string) {
			if len(args) > 0 && args[0] == "rev-parse" {
				return 0, filepath.Dir(dataDir), "" // parent dir is toplevel
			}
			return 0, "", ""
		},
	}
	resp, _ = http.Post(ts.URL+"/api/v1/sync?location=default", "application/json", nil)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 when not root of git repo, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 4. commit returns rc != 0 with "nothing to commit" -> should continue and succeed
	srv.GitRunner = mockGitRunner{
		fn: func(ctx context.Context, cwd string, args ...string) (int, string, string) {
			if len(args) > 0 && args[0] == "rev-parse" {
				return 0, dataDir, ""
			}
			if len(args) > 0 && args[0] == "commit" {
				return 1, "On branch main\nnothing to commit, working tree clean\n", ""
			}
			return 0, "ok", ""
		},
	}
	resp, _ = http.Post(ts.URL+"/api/v1/sync?location=default", "application/json", nil)
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200 when nothing to commit, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 5. Invalid workspace location on sync status -> 400
	respStatus, err := http.Get(ts.URL + "/api/v1/sync/status?location=invalid-ws")
	if err != nil || respStatus.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for sync status with invalid location, got %v", respStatus.StatusCode)
	}
	_ = respStatus.Body.Close()

	// 6. Invalid workspace location on sync POST -> 400
	respSyncBadLoc, err := http.Post(ts.URL+"/api/v1/sync?location=invalid-ws", "application/json", nil)
	if err != nil || respSyncBadLoc.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for sync POST with invalid location, got %v", respSyncBadLoc.StatusCode)
	}
	_ = respSyncBadLoc.Body.Close()

	// 7. Git command failure where stderr is empty and stdout has detail -> 500
	srv.GitRunner = mockGitRunner{
		fn: func(ctx context.Context, cwd string, args ...string) (int, string, string) {
			if len(args) > 0 && args[0] == "rev-parse" {
				return 0, dataDir, ""
			}
			if len(args) > 0 && args[0] == "push" {
				return 1, "stdout error output", "" // stderr empty
			}
			return 0, "", ""
		},
	}
	respFailStdout, err := http.Post(ts.URL+"/api/v1/sync?location=default", "application/json", nil)
	if err != nil || respFailStdout.StatusCode != http.StatusInternalServerError {
		t.Errorf("expected 500 for push failure with empty stderr, got %v", respFailStdout.StatusCode)
	}
	_ = respFailStdout.Body.Close()
}
