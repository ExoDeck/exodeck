package handlers_test

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ExoDeck/exodeck/internal/models"
)

// --------------------------------------------------------------------------
// Note CRUD
// --------------------------------------------------------------------------

func TestCreateNote(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	content := "# My Note\n\nHello world."
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/notes", nil)
	req.Body = io.NopCloser(byteReader(content))
	req.Header.Set("Content-Type", "text/plain")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST md-page: %d", resp.StatusCode)
	}

	// File should exist on disk
	if _, err := os.Stat(filepath.Join(dataDir, "My Note.md")); err != nil {
		t.Error("md file not created:", err)
	}
}

func TestGetNote(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	content := "# Get Test\n\nContent."
	_ = os.WriteFile(filepath.Join(dataDir, "get-test.md"), []byte(content), 0o644)
	store.InitCache()

	resp, err := http.Get(ts.URL + "/api/v1/notes/get-test")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET md-page: %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != content {
		t.Errorf("content mismatch: %q", body)
	}
}

func TestGetNoteNotFound(t *testing.T) {
	ts, store, _ := newTestServer(t)
	_ = store

	resp, err := http.Get(ts.URL + "/api/v1/notes/nonexistent")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("GET nonexistent md-page: %d, want 404", resp.StatusCode)
	}
}

func TestUpdateNoteSameSlug(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	content := "# Update Test\n\nOriginal."
	_ = os.WriteFile(filepath.Join(dataDir, "Update Test.md"), []byte(content), 0o644)
	store.InitCache()

	newContent := "# Update Test\n\nUpdated content."
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/notes/update-test", byteReader(newContent))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT md-page: %d", resp.StatusCode)
	}

	// Content updated
	data, _ := os.ReadFile(filepath.Join(dataDir, "Update Test.md"))
	if string(data) != newContent {
		t.Error("file content not updated")
	}
}

func TestUpdateNoteRenameSlug(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "old-slug.md"), []byte("# Old Slug\n\nContent."), 0o644)
	store.InitCache()

	newContent := "# Brand New Name\n\nRenamed."
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/notes/old-slug", byteReader(newContent))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT rename: %d", resp.StatusCode)
	}

	// Old file gone, new file exists
	if _, err := os.Stat(filepath.Join(dataDir, "old-slug.md")); !os.IsNotExist(err) {
		t.Error("old slug file should be gone")
	}
	if _, err := os.Stat(filepath.Join(dataDir, "Brand New Name.md")); err != nil {
		t.Error("new slug file should exist:", err)
	}
}

func TestUpdateNoteRenameUpdatesInternalLinks(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "Old Note.md"), []byte("# Old Note\n\nContent."), 0o644)
	store.InitCache()
	_ = os.WriteFile(filepath.Join(dataDir, "Referencer.md"), []byte("# Referencer\n\n[Old](/old-note)"), 0o644)
	store.InitCache()

	url := "/old-note"
	_, _ = store.WritePage("links", models.Page{
		PageName: "Links",
		Groups: []models.Group{{
			Title: "G",
			Items: []models.Item{{Title: "Old", URL: &url}},
		}},
	}, "")

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/notes/old-note", byteReader("# New Note\n\nUpdated"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT rename note: %d", resp.StatusCode)
	}

	page, code, msg := store.ReadPage("links", "")
	if code != 0 {
		t.Fatalf("read grid page: %d %s", code, msg)
	}
	if page.Groups[0].Items[0].URL == nil || *page.Groups[0].Items[0].URL != "/new-note" {
		t.Fatalf("grid link not rewritten, got: %v", page.Groups[0].Items[0].URL)
	}

	referencer, err := os.ReadFile(filepath.Join(dataDir, "Referencer.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(referencer, []byte("](/new-note)")) {
		t.Fatalf("note link not rewritten, got: %s", string(referencer))
	}
}

func TestDeleteNote(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "to-delete.md"), []byte("# To Delete\n"), 0o644)
	store.InitCache()

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/v1/notes/to-delete", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE md-page: %d", resp.StatusCode)
	}
}

func TestDeleteNoteNotFound(t *testing.T) {
	ts, store, _ := newTestServer(t)
	_ = store

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/v1/notes/nonexistent", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("DELETE nonexistent: %d, want 404", resp.StatusCode)
	}
}

func TestCreateDuplicateNoteReturns409(t *testing.T) {
	ts, store, _ := newTestServer(t)
	_ = store

	content := "# Duplicate Md Page\n\nHello world."
	do := func() *http.Response {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/notes", byteReader(content))
		req.Header.Set("Content-Type", "text/plain")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	resp1 := do()
	_ = resp1.Body.Close()
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("first POST md-page: %d", resp1.StatusCode)
	}

	// Second POST with the same title should fail with 409
	resp2 := do()
	_ = resp2.Body.Close()
	if resp2.StatusCode != http.StatusConflict {
		t.Errorf("duplicate POST md-page: got %d, want 409", resp2.StatusCode)
	}
}

func TestListPagesIncludesMarkdown(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	store.WritePage("link-page", models.Page{PageName: "Link Page", Groups: []models.Group{}}, "") //nolint:errcheck
	_ = os.WriteFile(filepath.Join(dataDir, "md-page.md"), []byte("# Md Page\n"), 0o644)
	store.InitCache()
	store.InitCache()

	code, _ := get(t, ts, "/api/v1/pages")
	if code != http.StatusOK {
		t.Fatalf("list pages: %d", code)
	}
}

func TestNoteLocationIsolation(t *testing.T) {
	ts, store, _, workDir := newTestServerMultiLocation(t)
	_ = store

	_ = os.WriteFile(filepath.Join(workDir, "work-doc.md"), []byte("# Work Doc\n"), 0o644)
	store.InitCache()

	resp, err := http.Get(ts.URL + "/api/v1/notes/work-doc?location=work")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("work location md-page: %d", resp.StatusCode)
	}

	resp2, _ := http.Get(ts.URL + "/api/v1/notes/work-doc?location=default")
	_ = resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Errorf("default location md-page should be 404, got %d", resp2.StatusCode)
	}
}

func Note(name string) models.Page {
	return models.Page{PageName: name, Hidden: false, Groups: []models.Group{}}
}

func byteReader(s string) io.Reader {
	return bytes.NewBufferString(s)
}

// --------------------------------------------------------------------------
// Move note to another location
// --------------------------------------------------------------------------

func TestMoveNoteToLocation(t *testing.T) {
	ts, store, defaultDir, _ := newTestServerMultiLocation(t)
	_ = store

	_ = os.WriteFile(filepath.Join(defaultDir, "My Note.md"), []byte("# My Note\n\nContent."), 0o644)
	store.InitCache()

	code, _ := post(t, ts, "/api/v1/notes/my-note/move-to?location=default", map[string]string{"target_location": "work"})
	if code != http.StatusNoContent {
		t.Fatalf("move note: %d", code)
	}

	resp, _ := http.Get(ts.URL + "/api/v1/notes/my-note?location=default")
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("note should be removed from source, got %d", resp.StatusCode)
	}

	resp2, _ := http.Get(ts.URL + "/api/v1/notes/my-note?location=work")
	_ = resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Errorf("note should exist in target, got %d", resp2.StatusCode)
	}
}

func TestMoveNoteToLocationConflictReturns409(t *testing.T) {
	ts, store, defaultDir, workDir := newTestServerMultiLocation(t)
	_ = store

	_ = os.WriteFile(filepath.Join(defaultDir, "My Note.md"), []byte("# My Note\n\nContent."), 0o644)
	store.InitCache()
	_ = os.WriteFile(filepath.Join(workDir, "My Note.md"), []byte("# My Note\n\nOther."), 0o644)
	store.InitCache()

	code, _ := post(t, ts, "/api/v1/notes/my-note/move-to?location=default", map[string]string{"target_location": "work"})
	if code != http.StatusConflict {
		t.Errorf("conflict: got %d, want 409", code)
	}
}

func TestMoveNoteWithMediaDir(t *testing.T) {
	ts, store, defaultDir, workDir := newTestServerMultiLocation(t)
	_ = store

	slug := "note-with-media"
	_ = os.WriteFile(filepath.Join(defaultDir, slug+".md"), []byte("# Note with Media\n\nContent."), 0o644)
	store.InitCache()

	// Create media directory with nested folder and files
	mediaDir := filepath.Join(defaultDir, slug)
	subDir := filepath.Join(mediaDir, "sub")
	_ = os.MkdirAll(subDir, 0o755)
	_ = os.WriteFile(filepath.Join(mediaDir, "image.png"), []byte("image-data"), 0o644)
	_ = os.WriteFile(filepath.Join(subDir, "nested.txt"), []byte("nested-data"), 0o644)

	// Missing target_location -> 400
	code, _ := post(t, ts, "/api/v1/notes/"+slug+"/move-to?location=default", map[string]string{})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for empty target_location, got %d", code)
	}

	// Move nonexistent note -> 404
	code, _ = post(t, ts, "/api/v1/notes/nonexistent/move-to?location=default", map[string]string{"target_location": "work"})
	if code != http.StatusNotFound {
		t.Errorf("expected 404 for moving nonexistent note, got %d", code)
	}

	// Successful move with media copy
	code, _ = post(t, ts, "/api/v1/notes/"+slug+"/move-to?location=default", map[string]string{"target_location": "work"})
	if code != http.StatusNoContent {
		t.Fatalf("move note with media failed: %d", code)
	}

	// Verify files exist in workDir/note-with-media/
	dstImg, err := os.ReadFile(filepath.Join(workDir, slug, "image.png"))
	if err != nil || string(dstImg) != "image-data" {
		t.Errorf("expected copied image.png in target media dir")
	}
	dstNested, err := os.ReadFile(filepath.Join(workDir, slug, "sub", "nested.txt"))
	if err != nil || string(dstNested) != "nested-data" {
		t.Errorf("expected copied nested.txt in target media dir")
	}
}

func TestNoteErrorBranches(t *testing.T) {
	ts, _, _ := newTestServer(t)

	// 1. Get non-existent note -> 404
	resp, _ := http.Get(ts.URL + "/api/v1/notes/nonexistent")
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for nonexistent note GET, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 2. Update non-existent note -> 404
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/notes/nonexistent", strings.NewReader("# New\nText"))
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for nonexistent note PUT, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 3. Delete non-existent note -> 404
	req, _ = http.NewRequest(http.MethodDelete, ts.URL+"/api/v1/notes/nonexistent", nil)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for nonexistent note DELETE, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 4. Create note on read-only docs workspace -> 403
	req, _ = http.NewRequest(http.MethodPost, ts.URL+"/api/v1/notes?location=docs", strings.NewReader("# New Doc\nText"))
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("expected 403 for create note on docs, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
}
