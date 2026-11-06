package handlers_test

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/ExoDeck/exodeck/internal/models"
)

const wbContent = `{"page-name":"My Whiteboard","excalidraw":{"elements":[],"appState":{}}}`
const wbContentRenamed = `{"page-name":"Renamed Board","excalidraw":{"elements":[],"appState":{}}}`

// --------------------------------------------------------------------------
// Whiteboard page CRUD
// --------------------------------------------------------------------------

func TestCreateWhiteboard(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/whiteboards", byteReader(wbContent))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST whiteboard: %d", resp.StatusCode)
	}

	if _, err := os.Stat(filepath.Join(dataDir, "My Whiteboard.excalidraw")); err != nil {
		t.Error(".excalidraw file not created:", err)
	}
}

func TestGetWhiteboard(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "My Whiteboard.excalidraw"), []byte(wbContent), 0o644)
	store.InitCache()

	resp, err := http.Get(ts.URL + "/api/v1/whiteboards/my-whiteboard")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET whiteboard: %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != wbContent {
		t.Errorf("content mismatch: %q", body)
	}
}

func TestGetWhiteboardNotFound(t *testing.T) {
	ts, store, _ := newTestServer(t)
	_ = store

	resp, err := http.Get(ts.URL + "/api/v1/whiteboards/nonexistent")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("GET nonexistent whiteboard: %d, want 404", resp.StatusCode)
	}
}

func TestUpdateWhiteboard(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "My Whiteboard.excalidraw"), []byte(wbContent), 0o644)
	store.InitCache()

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/whiteboards/my-whiteboard", byteReader(wbContent))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT whiteboard: %d", resp.StatusCode)
	}
}

func TestUpdateWhiteboardRename(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "My Whiteboard.excalidraw"), []byte(wbContent), 0o644)
	store.InitCache()

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/whiteboards/my-whiteboard", byteReader(wbContentRenamed))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT rename whiteboard: %d", resp.StatusCode)
	}

	if _, err := os.Stat(filepath.Join(dataDir, "My Whiteboard.excalidraw")); !os.IsNotExist(err) {
		t.Error("old .excalidraw file should be gone")
	}
	if _, err := os.Stat(filepath.Join(dataDir, "Renamed Board.excalidraw")); err != nil {
		t.Error("new .excalidraw file should exist:", err)
	}
}

func TestUpdateWhiteboardRenameUpdatesInternalLinks(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "My Whiteboard.excalidraw"), []byte(wbContent), 0o644)
	store.InitCache()
	_ = os.WriteFile(filepath.Join(dataDir, "Note Links.md"), []byte("# Note Links\n\n[Board](/my-whiteboard)"), 0o644)
	store.InitCache()

	url := "/my-whiteboard"
	_, _ = store.WritePage("links", models.Page{
		PageName: "Links",
		Groups: []models.Group{{
			Title: "G",
			Items: []models.Item{{Title: "Board", URL: &url}},
		}},
	}, "")

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/whiteboards/my-whiteboard", byteReader(wbContentRenamed))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT rename whiteboard: %d", resp.StatusCode)
	}

	page, code, msg := store.ReadPage("links", "")
	if code != 0 {
		t.Fatalf("read grid page: %d %s", code, msg)
	}
	if page.Groups[0].Items[0].URL == nil || *page.Groups[0].Items[0].URL != "/renamed-board" {
		t.Fatalf("grid link not rewritten, got: %v", page.Groups[0].Items[0].URL)
	}

	note, err := os.ReadFile(filepath.Join(dataDir, "Note Links.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(note, []byte("](/renamed-board)")) {
		t.Fatalf("note link not rewritten, got: %s", string(note))
	}
}

func TestDeleteWhiteboard(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "to-delete.excalidraw"), []byte(`{"page-name":"To Delete","excalidraw":{}}`), 0o644)
	store.InitCache()

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/v1/whiteboards/to-delete", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE whiteboard: %d", resp.StatusCode)
	}
}

func TestDeleteWhiteboardNotFound(t *testing.T) {
	ts, store, _ := newTestServer(t)
	_ = store

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/v1/whiteboards/nonexistent", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("DELETE nonexistent whiteboard: %d, want 404", resp.StatusCode)
	}
}

func TestCreateDuplicateWhiteboardReturns409(t *testing.T) {
	ts, store, _ := newTestServer(t)
	_ = store

	do := func() *http.Response {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/whiteboards", byteReader(wbContent))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	resp1 := do()
	_ = resp1.Body.Close()
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("first POST whiteboard: %d", resp1.StatusCode)
	}

	resp2 := do()
	_ = resp2.Body.Close()
	if resp2.StatusCode != http.StatusConflict {
		t.Errorf("duplicate POST whiteboard: got %d, want 409", resp2.StatusCode)
	}
}

func TestListPagesIncludesWhiteboard(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "My Whiteboard.excalidraw"), []byte(wbContent), 0o644)
	store.InitCache()

	code, _ := get(t, ts, "/api/v1/pages")
	if code != http.StatusOK {
		t.Fatalf("list pages: %d", code)
	}
}

func TestCreateWhiteboardInvalidJSON(t *testing.T) {
	ts, store, _ := newTestServer(t)
	_ = store

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/whiteboards", byteReader("not json"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("invalid JSON: got %d, want 400", resp.StatusCode)
	}
}

// --------------------------------------------------------------------------
// Move whiteboard to another location
// --------------------------------------------------------------------------

func TestMoveWhiteboardToLocation(t *testing.T) {
	ts, store, defaultDir, _ := newTestServerMultiLocation(t)
	_ = store

	_ = os.WriteFile(filepath.Join(defaultDir, "My Whiteboard.excalidraw"), []byte(wbContent), 0o644)
	store.InitCache()

	code, _ := post(t, ts, "/api/v1/whiteboards/my-whiteboard/move-to?location=default", map[string]string{"target_location": "work"})
	if code != http.StatusNoContent {
		t.Fatalf("move whiteboard: %d", code)
	}

	resp, _ := http.Get(ts.URL + "/api/v1/whiteboards/my-whiteboard?location=default")
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("whiteboard should be removed from source, got %d", resp.StatusCode)
	}

	resp2, _ := http.Get(ts.URL + "/api/v1/whiteboards/my-whiteboard?location=work")
	_ = resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Errorf("whiteboard should exist in target, got %d", resp2.StatusCode)
	}
}

func TestMoveWhiteboardToLocationConflictReturns409(t *testing.T) {
	ts, store, defaultDir, workDir := newTestServerMultiLocation(t)
	_ = store

	_ = os.WriteFile(filepath.Join(defaultDir, "My Whiteboard.excalidraw"), []byte(wbContent), 0o644)
	store.InitCache()
	_ = os.WriteFile(filepath.Join(workDir, "My Whiteboard.excalidraw"), []byte(wbContent), 0o644)
	store.InitCache()

	code, _ := post(t, ts, "/api/v1/whiteboards/my-whiteboard/move-to?location=default", map[string]string{"target_location": "work"})
	if code != http.StatusConflict {
		t.Errorf("conflict: got %d, want 409", code)
	}
}

func TestWhiteboardErrorCases(t *testing.T) {
	ts, _, _ := newTestServer(t)

	// 1. Move whiteboard empty target_location -> 400
	code, _ := post(t, ts, "/api/v1/whiteboards/my-wb/move-to", map[string]string{})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for empty target_location, got %d", code)
	}

	// 2. Move nonexistent whiteboard -> 404
	code, _ = post(t, ts, "/api/v1/whiteboards/nonexistent/move-to", map[string]string{"target_location": "work"})
	if code != http.StatusNotFound {
		t.Errorf("expected 404 for moving nonexistent whiteboard, got %d", code)
	}

	// 3. Update nonexistent whiteboard -> 404
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/whiteboards/nonexistent", byteReader(wbContent))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for updating nonexistent whiteboard, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 4. Delete nonexistent whiteboard -> 404
	req, _ = http.NewRequest(http.MethodDelete, ts.URL+"/api/v1/whiteboards/nonexistent", nil)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for deleting nonexistent whiteboard, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 5. Get nonexistent whiteboard -> 404
	resp, _ = http.Get(ts.URL + "/api/v1/whiteboards/nonexistent")
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for getting nonexistent whiteboard, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 6. Create whiteboard on docs workspace -> 403
	req, _ = http.NewRequest(http.MethodPost, ts.URL+"/api/v1/whiteboards?location=docs", byteReader(wbContent))
	req.Header.Set("Content-Type", "application/json")
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("expected 403 for creating whiteboard on docs, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
}
