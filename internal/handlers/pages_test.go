package handlers_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/ExoDeck/exodeck/internal/handlers"
	"github.com/ExoDeck/exodeck/internal/models"
	"github.com/ExoDeck/exodeck/internal/storage"
)

// --------------------------------------------------------------------------
// Page CRUD
// --------------------------------------------------------------------------

func TestPageCRUDHappyPath(t *testing.T) {
	ts, _, _ := newTestServer(t)

	// POST /api/v1/pages
	page := models.Page{PageName: "Test Page", Groups: []models.Group{}}
	code, body := post(t, ts, "/api/v1/pages", page)
	if code != http.StatusCreated {
		t.Fatalf("POST pages: %d %v", code, body)
	}
	slug, _ := body["slug"].(string)
	if slug != "test-page" {
		t.Errorf("slug = %q, want test-page", slug)
	}

	// GET /api/v1/pages/{slug}
	code, got := get(t, ts, "/api/v1/pages/test-page")
	if code != http.StatusOK {
		t.Fatalf("GET page: %d %v", code, got)
	}
	if got["page-name"] != "Test Page" {
		t.Errorf("page-name = %v", got["page-name"])
	}

	// PUT /api/v1/pages/{slug}
	updated := models.Page{PageName: "Test Page", Hidden: true, Groups: []models.Group{}}
	code, _ = put(t, ts, "/api/v1/pages/test-page", updated)
	if code != http.StatusOK {
		t.Fatalf("PUT page: %d", code)
	}

	// DELETE /api/v1/pages/{slug}
	code = del(t, ts, "/api/v1/pages/test-page")
	if code != http.StatusNoContent {
		t.Fatalf("DELETE page: %d", code)
	}

	// GET should now return 404
	code, _ = get(t, ts, "/api/v1/pages/test-page")
	if code != http.StatusNotFound {
		t.Errorf("expected 404 after delete, got %d", code)
	}
}

func TestCreateDuplicatePageReturns409(t *testing.T) {
	ts, _, _ := newTestServer(t)

	page := models.Page{PageName: "Duplicate Page", Groups: []models.Group{}}
	code, _ := post(t, ts, "/api/v1/pages", page)
	if code != http.StatusCreated {
		t.Fatalf("first POST: %d", code)
	}

	// Second POST with the same name should fail with 409
	code, _ = post(t, ts, "/api/v1/pages", page)
	if code != http.StatusConflict {
		t.Errorf("duplicate POST: got %d, want 409", code)
	}
}

func TestPageMissingSlugReturns404(t *testing.T) {
	ts, _, _ := newTestServer(t)

	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		var code int
		switch method {
		case http.MethodGet:
			code, _ = get(t, ts, "/api/v1/pages/missing-slug")
		case http.MethodPut:
			code, _ = put(t, ts, "/api/v1/pages/missing-slug", models.Page{PageName: "X"})
		default:
			code = del(t, ts, "/api/v1/pages/missing-slug")
		}
		if code != http.StatusNotFound {
			t.Errorf("%s missing slug: got %d, want 404", method, code)
		}
	}
}

func TestPageRenameChangesSlug(t *testing.T) {
	ts, store, _ := newTestServer(t)

	page := models.Page{PageName: "Original", Groups: []models.Group{}}
	store.WritePage("original", page, "") //nolint:errcheck

	renamed := models.Page{PageName: "Renamed", Groups: []models.Group{}}
	code, _ := put(t, ts, "/api/v1/pages/original", renamed)
	if code != http.StatusOK {
		t.Fatalf("PUT: %d", code)
	}

	code, _ = get(t, ts, "/api/v1/pages/original")
	if code != http.StatusNotFound {
		t.Errorf("old slug should be 404, got %d", code)
	}

	code, _ = get(t, ts, "/api/v1/pages/renamed")
	if code != http.StatusOK {
		t.Errorf("new slug should be 200, got %d", code)
	}
}

func TestPageLocationRouting(t *testing.T) {
	ts, store, _, workDir := newTestServerMultiLocation(t)

	pageDefault := models.Page{PageName: "Same Name", Groups: []models.Group{}}
	store.WritePage("same-name", pageDefault, "") //nolint:errcheck

	pageWork := models.Page{PageName: "Same Name", Hidden: true, Groups: []models.Group{}}
	writePageToDisk(t, workDir, "same-name", pageWork)
	store.InitCache()

	code, def := get(t, ts, "/api/v1/pages/same-name?location=default")
	if code != http.StatusOK {
		t.Fatalf("default: %d", code)
	}
	code, wrk := get(t, ts, "/api/v1/pages/same-name?location=work")
	if code != http.StatusOK {
		t.Fatalf("work: %d", code)
	}
	if def["hidden"] == wrk["hidden"] {
		t.Error("locations should be isolated")
	}
}

func TestUnknownLocationReturns400(t *testing.T) {
	ts, _, _ := newTestServer(t)
	code, _ := get(t, ts, "/api/v1/pages?location=nonexistent")
	if code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", code)
	}
}

// --------------------------------------------------------------------------
// Bootstrap
// --------------------------------------------------------------------------

func TestBootstrapReturnsLocationsAndPages(t *testing.T) {
	ts, store, _ := newTestServer(t)
	store.WritePage("alpha", models.Page{PageName: "Alpha", Groups: []models.Group{}}, "") //nolint:errcheck

	code, body := get(t, ts, "/api/v1/bootstrap")
	if code != http.StatusOK {
		t.Fatalf("bootstrap: %d %v", code, body)
	}
	if body["locations"] == nil {
		t.Error("expected locations in bootstrap response")
	}
	if body["pages"] == nil {
		t.Error("expected pages in bootstrap response")
	}
	if body["vault_status"] == nil {
		t.Error("expected vault_status in bootstrap response")
	}
}

// --------------------------------------------------------------------------
// Search
// --------------------------------------------------------------------------

func TestSearchReturnsMatchingItems(t *testing.T) {
	ts, store, _ := newTestServer(t)
	url := "https://github.com"
	page := models.Page{
		PageName: "Links",
		Groups: []models.Group{
			{Title: "Dev", Items: []models.Item{{Title: "GitHub", URL: &url}}},
		},
	}
	store.WritePage("links", page, "") //nolint:errcheck

	code, _ := get(t, ts, "/api/v1/search?q=github")
	if code != http.StatusOK {
		t.Fatalf("search: %d", code)
	}
}

// --------------------------------------------------------------------------
// Locations endpoint
// --------------------------------------------------------------------------

func TestLocationsEndpoint(t *testing.T) {
	ts, _, _, _ := newTestServerMultiLocation(t)
	code, body := get(t, ts, "/api/v1/locations")
	if code != http.StatusOK {
		t.Fatalf("locations: %d", code)
	}
	_ = body // slice returned; just assert 200
}

func TestLocationsReturnsSlice(t *testing.T) {
	ts, _, _, _ := newTestServerMultiLocation(t)
	resp, err := http.Get(ts.URL + "/api/v1/locations")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var names []string
	_ = json.NewDecoder(resp.Body).Decode(&names)
	if len(names) != 2 {
		t.Errorf("expected 2 locations, got %d: %v", len(names), names)
	}
}

// --------------------------------------------------------------------------
// Move page to another location
// --------------------------------------------------------------------------

func TestMovePageToLocation(t *testing.T) {
	ts, store, _, _ := newTestServerMultiLocation(t)

	store.WritePage("my-page", models.Page{PageName: "My Page", Groups: []models.Group{}}, "default") //nolint:errcheck

	code, _ := post(t, ts, "/api/v1/pages/my-page/move-to?location=default", map[string]string{"target_location": "work"})
	if code != http.StatusNoContent {
		t.Fatalf("move page: %d", code)
	}

	// Should be gone from default
	code, _ = get(t, ts, "/api/v1/pages/my-page?location=default")
	if code != http.StatusNotFound {
		t.Errorf("page should be removed from source, got %d", code)
	}

	// Should exist in work
	code, _ = get(t, ts, "/api/v1/pages/my-page?location=work")
	if code != http.StatusOK {
		t.Errorf("page should exist in target, got %d", code)
	}
}

func TestMovePageToLocationMissingTargetReturns400(t *testing.T) {
	ts, store, _, _ := newTestServerMultiLocation(t)
	store.WritePage("my-page", models.Page{PageName: "My Page", Groups: []models.Group{}}, "default") //nolint:errcheck

	code, _ := post(t, ts, "/api/v1/pages/my-page/move-to?location=default", map[string]string{})
	if code != http.StatusBadRequest {
		t.Errorf("missing target: got %d, want 400", code)
	}
}

func TestMovePageToLocationConflictReturns409(t *testing.T) {
	ts, store, _, _ := newTestServerMultiLocation(t)
	store.WritePage("my-page", models.Page{PageName: "My Page", Groups: []models.Group{}}, "default") //nolint:errcheck
	store.WritePage("my-page", models.Page{PageName: "My Page", Groups: []models.Group{}}, "work")    //nolint:errcheck

	code, _ := post(t, ts, "/api/v1/pages/my-page/move-to?location=default", map[string]string{"target_location": "work"})
	if code != http.StatusConflict {
		t.Errorf("conflict: got %d, want 409", code)
	}
}

func TestMovePageWithSensitiveItemsToUnencryptedLocationReturns422(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := t.TempDir()
	configDir := t.TempDir()

	const testKey = "cDRCaTNFd1hJcEJLVjhiaTVSM3pkdlp1QW1lZE1qT3Y=" // valid 32-byte base64 key

	store := storage.New(fstest.MapFS{}, os.TempDir())
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"encrypted": {Path: srcDir, FernetKey: testKey},
		"plain":     {Path: dstDir},
	}, []string{"encrypted", "plain"})
	srv := &handlers.Server{Store: store, ConfigDir: configDir, FrontendFS: stubFrontendFS}
	ts := httptest.NewServer(handlers.NewRouter(srv))
	t.Cleanup(ts.Close)

	pw := "secret"
	page := models.Page{
		PageName: "Secure Page",
		Groups: []models.Group{
			{Title: "Logins", Items: []models.Item{{Title: "MyApp", Password: &pw}}},
		},
	}
	store.WritePage("secure-page", page, "encrypted") //nolint:errcheck

	code, body := post(t, ts, "/api/v1/pages/secure-page/move-to?location=encrypted",
		map[string]string{"target_location": "plain"})
	if code != http.StatusUnprocessableEntity {
		t.Errorf("expected 422 but got %d: %v", code, body)
	}

	// Page should still be in the source location
	code, _ = get(t, ts, "/api/v1/pages/secure-page?location=encrypted")
	if code != http.StatusOK {
		t.Errorf("page should still exist in source after rejected move, got %d", code)
	}

	// Move to invalid target location -> 400
	code, _ = post(t, ts, "/api/v1/pages/secure-page/move-to?location=encrypted",
		map[string]string{"target_location": "invalid-target"})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for move to invalid target, got %d", code)
	}

	// Move non-existent page -> 404
	code, _ = post(t, ts, "/api/v1/pages/missing/move-to?location=encrypted",
		map[string]string{"target_location": "plain"})
	if code != http.StatusNotFound {
		t.Errorf("expected 404 for move non-existent page, got %d", code)
	}
}

func TestGetDueTasksEndpoint(t *testing.T) {
	ts, store, _ := newTestServer(t)

	todayStr := "2020-01-01" // definitely overdue
	bFalse := false

	page := models.Page{
		PageName: "Tasks",
		Groups: []models.Group{
			{
				Title: "Todo",
				Items: []models.Item{
					{Title: "Urgent fix", TaskChecked: &bFalse, TaskDueDate: &todayStr},
				},
			},
		},
	}
	store.WritePage("tasks", page, "default") //nolint:errcheck

	// Test GET /api/v1/tasks/due
	res, err := http.Get(ts.URL + "/api/v1/tasks/due")
	if err != nil {
		t.Fatalf("GET /api/v1/tasks/due: %v", err)
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.StatusCode)
	}

	var dueTasks []models.DueTask
	if err := json.NewDecoder(res.Body).Decode(&dueTasks); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if len(dueTasks) != 1 {
		t.Fatalf("expected 1 due task, got %d", len(dueTasks))
	}
	if dueTasks[0].Title != "Urgent fix" || dueTasks[0].DueStatus != "overdue" {
		t.Errorf("unexpected task: %+v", dueTasks[0])
	}

	// Test /bootstrap includes due_tasks and all_tasks
	code, bData := get(t, ts, "/api/v1/bootstrap")
	if code != http.StatusOK {
		t.Fatalf("GET /api/v1/bootstrap: %d", code)
	}
	if _, ok := bData["due_tasks"]; !ok {
		t.Errorf("expected due_tasks in bootstrap response: %v", bData)
	}
	if _, ok := bData["all_tasks"]; !ok {
		t.Errorf("expected all_tasks in bootstrap response: %v", bData)
	}

	// Test GET /api/v1/tasks
	resAll, err := http.Get(ts.URL + "/api/v1/tasks")
	if err != nil {
		t.Fatalf("GET /api/v1/tasks: %v", err)
	}
	defer func() { _ = resAll.Body.Close() }()
	if resAll.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from /tasks, got %d", resAll.StatusCode)
	}
	var allTasks []models.Task
	if err := json.NewDecoder(resAll.Body).Decode(&allTasks); err != nil {
		t.Fatalf("decode /tasks: %v", err)
	}
	if len(allTasks) != 1 {
		t.Fatalf("expected 1 task in /tasks, got %d", len(allTasks))
	}
	if allTasks[0].Title != "Urgent fix" {
		t.Errorf("unexpected task: %+v", allTasks[0])
	}
}

func TestMovePagesBetweenLocations(t *testing.T) {
	ts, store, _, _ := newTestServerMultiLocation(t)

	// 1. Move Grid Page
	store.WritePage("move-grid", models.Page{PageName: "Move Grid", Groups: []models.Group{}}, "default")
	code, body := post(t, ts, "/api/v1/pages/move-grid/move-to?location=default", map[string]string{
		"target_location": "work",
	})
	if code != http.StatusNoContent {
		t.Fatalf("move grid page: %d %v", code, body)
	}

	// 2. Move Note Page
	store.WriteNotePage("move-note", "# Move Note\nBody content", "default")
	code, body = post(t, ts, "/api/v1/notes/move-note/move-to?location=default", map[string]string{
		"target_location": "work",
	})
	if code != http.StatusNoContent {
		t.Fatalf("move note page: %d %v", code, body)
	}

	// 3. Move Whiteboard Page
	store.WriteWhiteboardPage("move-wb", `{"page-name":"Move WB"}`, "default")
	code, body = post(t, ts, "/api/v1/whiteboards/move-wb/move-to?location=default", map[string]string{
		"target_location": "work",
	})
	if code != http.StatusNoContent {
		t.Fatalf("move whiteboard page: %d %v", code, body)
	}

	// 4. Move BPMN Page
	xmlData := `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process id="P1" name="Move BPMN"/></bpmn:definitions>`
	store.WriteBpmnPage("move-bpmn", `{"page-name":"Move BPMN","bpmn_xml":"`+strings.ReplaceAll(xmlData, `"`, `\"`)+`"}`, "default")
	code, body = post(t, ts, "/api/v1/bpmn/move-bpmn/move-to?location=default", map[string]string{
		"target_location": "work",
	})
	if code != http.StatusNoContent {
		t.Fatalf("move bpmn page: %d %v", code, body)
	}
}

func TestPageErrorBranches(t *testing.T) {
	defaultDir := t.TempDir()
	configDir := t.TempDir()

	docsFS := fstest.MapFS{
		"docs/pdocs.grid": &fstest.MapFile{
			Data: []byte(`{"page-name":"PDocs","groups":[]}`),
		},
	}
	store := storage.New(docsFS, os.TempDir())
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: defaultDir},
	}, []string{"default"})

	srv := &handlers.Server{
		Store:      store,
		ConfigDir:  configDir,
		FrontendFS: stubFrontendFS,
	}
	ts := httptest.NewServer(handlers.NewRouter(srv))
	defer ts.Close()

	// 1. Create page with invalid location -> 400
	code, _ := post(t, ts, "/api/v1/pages?location=bad-ws", models.Page{PageName: "X"})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for createPage bad location, got %d", code)
	}

	// 2. Create page on docs workspace -> 403
	code, _ = post(t, ts, "/api/v1/pages?location=docs", models.Page{PageName: "X"})
	if code != http.StatusForbidden {
		t.Errorf("expected 403 for createPage on docs, got %d", code)
	}

	// 3. Delete page on docs workspace -> 403
	code = del(t, ts, "/api/v1/pages/pdocs?location=docs")
	if code != http.StatusForbidden {
		t.Errorf("expected 403 for deletePage on docs, got %d", code)
	}

	// 4. Update page on docs workspace -> 403
	code, _ = put(t, ts, "/api/v1/pages/pdocs?location=docs", models.Page{PageName: "PDocs"})
	if code != http.StatusForbidden {
		t.Errorf("expected 403 for updatePage on docs, got %d", code)
	}

	// 5. Update page with invalid location -> 400
	store.WritePage("p", models.Page{PageName: "P", Groups: []models.Group{}}, "default")
	code, _ = put(t, ts, "/api/v1/pages/p?location=bad-ws", models.Page{PageName: "P"})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for updatePage bad location, got %d", code)
	}

	// 6. Rename page with existing media dir
	oldMediaDir := filepath.Join(defaultDir, "p")
	_ = os.MkdirAll(oldMediaDir, 0o755)
	_ = os.WriteFile(filepath.Join(oldMediaDir, "test.png"), []byte("png"), 0o644)

	code, _ = put(t, ts, "/api/v1/pages/p?location=default", models.Page{PageName: "P Renamed"})
	if code != http.StatusOK {
		t.Errorf("expected 200 for updatePage rename, got %d", code)
	}
	newMediaDir := filepath.Join(defaultDir, "p-renamed")
	if _, err := os.Stat(newMediaDir); os.IsNotExist(err) {
		t.Errorf("expected renamed media dir to exist at %s", newMediaDir)
	}
}
