package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/ExoDeck/exodeck/internal/storage"
)

func doPickFolderRequest(t *testing.T, ts *httptest.Server, body string, hasBody bool) (*http.Response, map[string]interface{}) {
	t.Helper()
	var req *http.Request
	var err error
	if hasBody {
		req, err = http.NewRequest(http.MethodPost, ts.URL+"/api/v1/fs/pick-folder", strings.NewReader(body))
	} else {
		req, err = http.NewRequest(http.MethodPost, ts.URL+"/api/v1/fs/pick-folder", nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = resp.Body.Close()
	}()

	var parsed map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&parsed)
	return resp, parsed
}

func TestPickFolder(t *testing.T) {
	baseDir := t.TempDir()
	fakeHome := filepath.Join(baseDir, "home")
	configDir := filepath.Join(baseDir, "cfg")
	browseDir := filepath.Join(baseDir, "browse")
	relSub := filepath.Join(configDir, "rel-child")
	chosenDir := filepath.Join(baseDir, "picked")
	for _, dir := range []string{fakeHome, browseDir, relSub, chosenDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	filePath := filepath.Join(browseDir, "notes.txt")
	if err := os.WriteFile(filePath, []byte("hi"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("USERPROFILE", fakeHome)
	t.Setenv("HOME", fakeHome)

	var gotInitialDir string
	var mockSelected string
	var mockCancelled bool
	var mockErr error

	srv := &Server{
		Store:      storage.New(nil, os.TempDir()),
		ConfigDir:  configDir,
		FrontendFS: fstest.MapFS{},
		FolderPicker: func(_ context.Context, initialDir string) (string, bool, error) {
			gotInitialDir = initialDir
			return mockSelected, mockCancelled, mockErr
		},
	}
	ts := httptest.NewServer(NewRouter(srv))
	defer ts.Close()

	// 1. Selected folder with existing initial_path -> 200
	mockSelected = chosenDir
	mockCancelled = false
	mockErr = nil
	payload, _ := json.Marshal(map[string]string{"initial_path": browseDir})
	resp, body := doPickFolderRequest(t, ts, string(payload), true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /fs/pick-folder status = %d, want 200 (%v)", resp.StatusCode, body)
	}
	if gotInitialDir != browseDir {
		t.Errorf("picker received initialDir = %q, want %q", gotInitialDir, browseDir)
	}
	if body["path"] != chosenDir || body["cancelled"] != false {
		t.Errorf("unexpected response body: %v", body)
	}

	// 2. Relative initial_path resolves relative to ConfigDir
	gotInitialDir = ""
	resp, _ = doPickFolderRequest(t, ts, `{"initial_path":"rel-child"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("relative path status = %d, want 200", resp.StatusCode)
	}
	if gotInitialDir != relSub {
		t.Errorf("relative path resolved to %q, want %q", gotInitialDir, relSub)
	}

	// 3. Non-existent nested initial_path walks up to nearest existing ancestor
	missingNested := filepath.Join(browseDir, "missing", "child")
	payload, _ = json.Marshal(map[string]string{"initial_path": missingNested})
	resp, _ = doPickFolderRequest(t, ts, string(payload), true)
	if resp.StatusCode != http.StatusOK || gotInitialDir != browseDir {
		t.Errorf("nested missing initialDir = %q (status %d), want %q", gotInitialDir, resp.StatusCode, browseDir)
	}

	// 4. File path walks up to parent directory
	payload, _ = json.Marshal(map[string]string{"initial_path": filePath})
	resp, _ = doPickFolderRequest(t, ts, string(payload), true)
	if resp.StatusCode != http.StatusOK || gotInitialDir != browseDir {
		t.Errorf("file initialDir = %q (status %d), want %q", gotInitialDir, resp.StatusCode, browseDir)
	}

	// 5. Empty initial_path and empty request body both resolve to homeDir
	gotInitialDir = ""
	resp, _ = doPickFolderRequest(t, ts, `{}`, true)
	if resp.StatusCode != http.StatusOK || gotInitialDir != fakeHome {
		t.Errorf("empty initial_path got %q (status %d), want %q", gotInitialDir, resp.StatusCode, fakeHome)
	}

	gotInitialDir = ""
	resp, _ = doPickFolderRequest(t, ts, "", false)
	if resp.StatusCode != http.StatusOK || gotInitialDir != fakeHome {
		t.Errorf("empty body got %q (status %d), want %q", gotInitialDir, resp.StatusCode, fakeHome)
	}

	// 6. User cancels dialog -> 200 with cancelled=true and empty path
	mockSelected = ""
	mockCancelled = true
	resp, body = doPickFolderRequest(t, ts, `{}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("cancelled status = %d, want 200", resp.StatusCode)
	}
	if body["cancelled"] != true || body["path"] != "" {
		t.Errorf("expected cancelled=true and empty path, got %v", body)
	}

	// 7. Invalid JSON body -> 422
	resp, _ = doPickFolderRequest(t, ts, "{bad", true)
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("expected 422 for invalid JSON, got %d", resp.StatusCode)
	}

	// 8. Picker unavailable -> 501
	mockCancelled = false
	mockErr = errPickerUnavailable
	resp, body = doPickFolderRequest(t, ts, `{}`, true)
	if resp.StatusCode != http.StatusNotImplemented {
		t.Errorf("expected 501 for errPickerUnavailable, got %d (%v)", resp.StatusCode, body)
	}

	// 9. Unexpected picker error -> 500
	mockErr = errors.New("boom")
	resp, body = doPickFolderRequest(t, ts, `{}`, true)
	if resp.StatusCode != http.StatusInternalServerError {
		t.Errorf("expected 500 for picker error, got %d (%v)", resp.StatusCode, body)
	}

	// 10. Real non-nil bytes body with empty JSON object is valid
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/fs/pick-folder", bytes.NewReader([]byte(`{}`)))
	if err != nil {
		t.Fatal(err)
	}
	mockErr = nil
	mockSelected = chosenDir
	rawResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = rawResp.Body.Close()
	if rawResp.StatusCode != http.StatusOK {
		t.Errorf("bytes request status = %d, want 200", rawResp.StatusCode)
	}
}

func TestResolveInitialPickDirFallbacks(t *testing.T) {
	baseDir := t.TempDir()
	configDir := filepath.Join(baseDir, "cfg")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	missingHome := filepath.Join(baseDir, "no-such-home")

	// Empty USERPROFILE/HOME falls back to ConfigDir
	t.Setenv("USERPROFILE", "")
	t.Setenv("HOME", "")
	if got := resolveInitialPickDir("", configDir); got != configDir {
		t.Errorf("resolveInitialPickDir empty home = %q, want %q", got, configDir)
	}

	// Missing home and empty configDir yields ""
	if got := resolveInitialPickDir("", ""); got != "" {
		t.Errorf("resolveInitialPickDir no home/config = %q, want empty", got)
	}

	// Non-existent home inside baseDir walks up to baseDir
	t.Setenv("USERPROFILE", missingHome)
	t.Setenv("HOME", missingHome)
	if got := resolveInitialPickDir("", configDir); got != baseDir {
		t.Errorf("resolveInitialPickDir missing home walks up to = %q, want %q", got, baseDir)
	}

	// Unresolvable path (unused drive on Windows, or missing relative with no home/config) hits fallback
	for d := 'Z'; d >= 'D'; d-- {
		unusedDrive := string(d) + `:\`
		if _, err := os.Stat(unusedDrive); os.IsNotExist(err) {
			if got := resolveInitialPickDir(unusedDrive+`missing\sub`, configDir); got != configDir {
				t.Errorf("unused drive fallback = %q, want %q", got, configDir)
			}
			if got := resolveInitialPickDir(unusedDrive+`missing\sub`, filepath.Join(baseDir, "missing-cfg")); got != "" {
				t.Errorf("unused drive with missing home+config = %q, want empty", got)
			}
			break
		}
	}
}
