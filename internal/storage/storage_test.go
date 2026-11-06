package storage_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/ExoDeck/exodeck/internal/models"
	"github.com/ExoDeck/exodeck/internal/storage"
)

// makeStore creates a Store wired to a single tmp location named "default".
func makeStore(t *testing.T) (*storage.Store, string) {
	t.Helper()
	dir := t.TempDir()
	store := storage.New(fstest.MapFS{}, os.TempDir())
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: dir},
	}, []string{"default"})
	return store, dir
}

func writeJSON(t *testing.T, path string, v interface{}) {
	t.Helper()
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

// --------------------------------------------------------------------------
// Slugify
// --------------------------------------------------------------------------

func TestSlugifyNormalisesName(t *testing.T) {
	cases := []struct{ in, want string }{
		{" Hello, WORLD! 2026 ", "hello-world-2026"},
		{"Top level/sub page", "top-level-sub-page"},
		{"--foo--", "foo"},
		{"ABC", "abc"},
		{"Äpfel und Öfen", "aepfel-und-oefen"},
		{"Übermäßige Grüße", "uebermaessige-gruesse"},
	}
	for _, c := range cases {
		got := storage.Slugify(c.in)
		if got != c.want {
			t.Errorf("Slugify(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestLogicalToPhysicalPath(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Hello World", "Hello World"},
		{"A / B / C", filepath.Join("A", "B", "C")},
		{"Foo : Bar", "Foo - Bar"},
		{"  Trimmed  /  Spaces  ", filepath.Join("Trimmed", "Spaces")},
		{"Empty // Folders", filepath.Join("Empty", "Folders")},
		{". / ..", filepath.Join("dot", "dot")},
		{"", "Untitled"},
	}
	for _, c := range cases {
		got := storage.LogicalToPhysicalPath(c.in)
		if got != c.want {
			t.Errorf("LogicalToPhysicalPath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSanitizeFilename(t *testing.T) {
	cases := []struct{ in, want string }{
		{"my image.png", "my-image.png"},
		{"file@name#$%.png", "file-name.png"},
		{"  spaces  everywhere  .jpg", "spaces-everywhere.jpg"},
		{"UPPERCASE.PNG", "uppercase.png"},
		{"test_underscore.gif", "test_underscore.gif"},
		{"multiple   spaces.jpeg", "multiple-spaces.jpeg"},
		{"special!@#$%^&*().png", "special.png"},
		{"noextension", "noextension"},
		{"----dashes----.txt", "dashes.txt"},
		{"leading_underscore_file.jpg", "leading_underscore_file.jpg"},
	}
	for _, c := range cases {
		got := storage.SanitizeFilename(c.in)
		if got != c.want {
			t.Errorf("SanitizeFilename(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// --------------------------------------------------------------------------
// ParseWorkspaces
// --------------------------------------------------------------------------

func TestParseWorkspacesNilReturnsEmpty(t *testing.T) {
	locs, _, err := storage.ParseWorkspaces(nil, "/default/data", "/config")
	if err != nil {
		t.Fatalf("ParseWorkspaces: %v", err)
	}
	if len(locs) != 0 {
		t.Errorf("expected empty locs, got %d", len(locs))
	}
}

func TestParseWorkspacesStringValue(t *testing.T) {
	raw := map[string]interface{}{"work": "./docs"}
	locs, _, err := storage.ParseWorkspaces(raw, "/base/data", "/base")
	if err != nil {
		t.Fatalf("ParseWorkspaces: %v", err)
	}
	lc := locs["work"]
	if lc.Path != filepath.Clean("/base/docs") {
		t.Errorf("Path = %q, want %q", lc.Path, filepath.Clean("/base/docs"))
	}
	if lc.FernetKey != "" {
		t.Error("expected no FernetKey for string value")
	}
}

func TestParseWorkspacesObjectValue(t *testing.T) {
	raw := map[string]interface{}{
		"secure": map[string]interface{}{
			"path":       "./data",
			"fernet_key": "mykey123",
		},
	}
	locs, _, err := storage.ParseWorkspaces(raw, "/base/data", "/base")
	if err != nil {
		t.Fatalf("ParseWorkspaces: %v", err)
	}
	lc := locs["secure"]
	if lc.Path != filepath.Clean("/base/data") {
		t.Errorf("Path = %q, want %q", lc.Path, filepath.Clean("/base/data"))
	}
	if lc.FernetKey != "mykey123" {
		t.Errorf("FernetKey = %q, want mykey123", lc.FernetKey)
	}
}

func TestParseWorkspacesEmptyMapReturnsEmpty(t *testing.T) {
	locs, _, err := storage.ParseWorkspaces(map[string]interface{}{}, "/default/data", "/config")
	if err != nil {
		t.Fatalf("ParseWorkspaces: %v", err)
	}
	if len(locs) != 0 {
		t.Errorf("expected empty locs, got %d", len(locs))
	}
}

func TestParseWorkspacesInvalidValueReturnsError(t *testing.T) {
	raw := map[string]interface{}{"bad": 42}
	if _, _, err := storage.ParseWorkspaces(raw, "/base/data", "/base"); err == nil {
		t.Error("expected error for integer value")
	}
}

// --------------------------------------------------------------------------
// JSON page CRUD
// --------------------------------------------------------------------------

func TestJsonPageReadWriteDeleteRoundtrip(t *testing.T) {
	store, _ := makeStore(t)
	page := models.Page{
		PageName: "Test Page",
		Hidden:   false,
		Groups: []models.Group{
			{Title: "G1", Items: []models.Item{{Title: "Link", URL: ptr("https://example.com")}}},
		},
	}

	// Write
	if code, msg := store.WritePage("test-page", page, ""); code != 0 {
		t.Fatalf("WritePage: %d %s", code, msg)
	}

	// Read
	got, code, msg := store.ReadPage("test-page", "")
	if code != 0 {
		t.Fatalf("ReadPage: %d %s", code, msg)
	}
	if got.PageName != "Test Page" {
		t.Errorf("PageName = %q, want Test Page", got.PageName)
	}
	if len(got.Groups) != 1 || len(got.Groups[0].Items) != 1 {
		t.Errorf("unexpected groups/items: %+v", got)
	}

	// Delete
	if code, msg := store.DeletePage("test-page", ""); code != 0 {
		t.Fatalf("DeletePage: %d %s", code, msg)
	}

	// Read after delete → 404
	_, code, _ = store.ReadPage("test-page", "")
	if code != 404 {
		t.Errorf("expected 404 after delete, got %d", code)
	}
}

func TestReadPageMissingReturns404(t *testing.T) {
	store, _ := makeStore(t)
	_, code, _ := store.ReadPage("nonexistent", "")
	if code != 404 {
		t.Errorf("expected 404, got %d", code)
	}
}

func TestDeletePageMissingReturns404(t *testing.T) {
	store, _ := makeStore(t)
	code, _ := store.DeletePage("nonexistent", "")
	if code != 404 {
		t.Errorf("expected 404, got %d", code)
	}
}

// --------------------------------------------------------------------------
// Note page CRUD
// --------------------------------------------------------------------------

func TestNotePageReadWriteRenameDelete(t *testing.T) {
	store, _ := makeStore(t)
	content := "# My Page\n\nHello world."

	newSlug, pageName, code, msg := store.WriteNotePage("", content, "")
	if code != 0 {
		t.Fatalf("WriteNotePage: %d %s", code, msg)
	}
	if newSlug != "my-page" {
		t.Errorf("slug = %q, want my-page", newSlug)
	}
	if pageName != "My Page" {
		t.Errorf("pageName = %q, want My Page", pageName)
	}

	// Read
	got, code, msg := store.ReadNotePage("my-page", "")
	if code != 0 {
		t.Fatalf("ReadNotePage: %d %s", code, msg)
	}
	if got != content {
		t.Errorf("content mismatch")
	}

	// Rename — change H1
	renamed := "# Renamed Page\n\nNew content."
	newSlug2, _, code, msg := store.WriteNotePage("my-page", renamed, "")
	if code != 0 {
		t.Fatalf("WriteNotePage (rename): %d %s", code, msg)
	}
	if newSlug2 != "renamed-page" {
		t.Errorf("renamed slug = %q, want renamed-page", newSlug2)
	}

	// Old slug gone
	_, code, _ = store.ReadNotePage("my-page", "")
	if code != 404 {
		t.Errorf("expected 404 for old slug, got %d", code)
	}

	// Delete
	code, msg = store.DeleteNotePage("renamed-page", "")
	if code != 0 {
		t.Fatalf("DeleteNotePage: %d %s", code, msg)
	}

	// Second delete → 404
	code, _ = store.DeleteNotePage("renamed-page", "")
	if code != 404 {
		t.Errorf("expected 404 for second delete, got %d", code)
	}
}

// --------------------------------------------------------------------------
// ListPages
// --------------------------------------------------------------------------

func TestListPagesMergesJsonAndMarkdown(t *testing.T) {
	store, dir := makeStore(t)

	// Write valid JSON page
	writeJSON(t, filepath.Join(dir, "alpha.grid"), map[string]interface{}{
		"page-name": "Alpha", "hidden": false, "groups": []interface{}{},
	})
	// Write invalid JSON — should be skipped
	_ = os.WriteFile(filepath.Join(dir, "bad.grid"), []byte("not json"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "other.json"), []byte("{\"key\": \"val\"}"), 0o644)
	// Write note page
	_ = os.WriteFile(filepath.Join(dir, "gamma.md"), []byte("# Gamma\n\ncontent"), 0o644)

	// Re-init cache so alpha.json is loaded
	store.InitCache()

	pages, code, msg := store.ListPages("")
	if code != 0 {
		t.Fatalf("ListPages: %d %s", code, msg)
	}

	typeMap := map[string]string{}
	for _, p := range pages {
		typeMap[p.Slug] = p.PageType
	}
	if typeMap["alpha"] != "grid" {
		t.Errorf("alpha should be grid, got %q", typeMap["alpha"])
	}
	if typeMap["gamma"] != "note" {
		t.Errorf("gamma should be note, got %q", typeMap["gamma"])
	}
	if _, ok := typeMap["bad"]; ok {
		t.Error("bad.grid should have been skipped")
	}
	if _, ok := typeMap["other"]; ok {
		t.Error("other.json should not be treated as a page")
	}
}

func TestListPagesReturnsFileName(t *testing.T) {
	store, dir := makeStore(t)

	// Create nested directory structure
	nestedDir := filepath.Join(dir, "folder", "subfolder")
	if err := os.MkdirAll(nestedDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	// Write note page in nested directory
	_ = os.WriteFile(filepath.Join(nestedDir, "nested-note.md"), []byte("# Nested Note\n\ncontent"), 0o644)

	// Re-init cache
	store.InitCache()

	pages, code, msg := store.ListPages("")
	if code != 0 {
		t.Fatalf("ListPages: %d %s", code, msg)
	}

	found := false
	for _, p := range pages {
		if p.Slug == "folder-subfolder-nested-note" {
			found = true
			expectedFileName := filepath.ToSlash(filepath.Join("folder", "subfolder", "nested-note.md"))
			if p.FileName != expectedFileName {
				t.Errorf("expected FileName %q, got %q", expectedFileName, p.FileName)
			}
		}
	}
	if !found {
		t.Error("nested note not found in ListPages output")
	}
}

// --------------------------------------------------------------------------
// SearchItems
// --------------------------------------------------------------------------

func TestSearchItemsFilters(t *testing.T) {
	store, _ := makeStore(t)

	page := models.Page{
		PageName: "My Links",
		Hidden:   false,
		Groups: []models.Group{
			{Title: "G", Items: []models.Item{
				{Title: "GitHub", URL: ptr("https://github.com")},
				{Title: "Google", URL: ptr("https://google.com")},
				{Title: "Unrelated", URL: ptr("https://unrelated.com")},
			}},
		},
	}
	store.WritePage("my-links", page, "") //nolint:errcheck

	results := store.SearchItems("git")
	if len(results) != 1 || results[0].Title != "GitHub" {
		t.Errorf("unexpected search results: %+v", results)
	}
}

// --------------------------------------------------------------------------
// WorkspaceNames / ResolveWorkspace
// --------------------------------------------------------------------------

func TestResolveWorkspaceUnknownReturns400(t *testing.T) {
	store, _ := makeStore(t)
	_, _, code, _ := store.ResolveWorkspace("unknown")
	if code != 400 {
		t.Errorf("expected 400, got %d", code)
	}
}

func TestResolveWorkspaceEmptyDefaultsToFirst(t *testing.T) {
	store, dir := makeStore(t)
	name, path, code, _ := store.ResolveWorkspace("")
	if code != 0 {
		t.Fatalf("ResolveWorkspace: code %d", code)
	}
	if name != "default" {
		t.Errorf("name = %q, want default", name)
	}
	if path != dir {
		t.Errorf("path = %q, want %q", path, dir)
	}
}

// --------------------------------------------------------------------------
// GetPageTaskStatus
// --------------------------------------------------------------------------

func TestGetPageTaskStatus(t *testing.T) {
	// A page with no tasks → ""
	page := models.Page{Groups: []models.Group{{Title: "G", Items: []models.Item{
		{Title: "Link", URL: ptr("https://x.com")},
	}}}}
	if s := storage.GetPageTaskStatus(page); s != "" {
		t.Errorf("expected empty status, got %q", s)
	}
}

func ptr(s string) *string { return &s }

func TestLogicalHierarchyAugmentation(t *testing.T) {
	store, dir := makeStore(t)

	// Case 1: MD file with name hello.md no H1 in folder xxx: xxx -> hello
	_ = os.MkdirAll(filepath.Join(dir, "xxx"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "xxx", "hello.md"), []byte("content without h1"), 0o644)

	// Case 2: MD file with name hello2.md and H1 "# Hello world" in folder xxx: xxx -> Hello world
	_ = os.WriteFile(filepath.Join(dir, "xxx", "hello2.md"), []byte("# Hello world\n\nbody"), 0o644)

	// Case 3: MD file with name hello3.md and H1 "# Hello / world" in folder xxx: Hello -> world
	_ = os.WriteFile(filepath.Join(dir, "xxx", "hello3.md"), []byte("# Hello / world\n\nbody"), 0o644)

	// Case 4: MD file with name hello4.md and H1 "# Hello / world" in root folder: Hello -> world
	_ = os.WriteFile(filepath.Join(dir, "hello4.md"), []byte("# Hello / world\n\nbody"), 0o644)

	store.InitCache()

	pages, _, _ := store.ListPages("default")

	// Create a map for easy lookup by slug
	pageMap := make(map[string]string)
	for _, p := range pages {
		pageMap[p.Slug] = p.PageName
	}

	expected := map[string]string{
		"xxx-hello":       "xxx / hello",
		"xxx-hello-world": "xxx / Hello world",
		"hello-world":     "Hello / world", // from xxx/hello3.md
		"hello-world-1":   "Hello / world", // from hello4.md (collision)
	}

	for slug, want := range expected {
		got, ok := pageMap[slug]
		if !ok {
			t.Errorf("missing page for slug %q", slug)
			continue
		}
		if got != want {
			t.Errorf("slug %q: got %q, want %q", slug, got, want)
		}
	}
}

func TestListPagesExcludesDotfilesAndVault(t *testing.T) {
	store, dir := makeStore(t)

	// Create normal page
	writeJSON(t, filepath.Join(dir, "my-page.grid"), models.Page{PageName: "My Page"})

	// Create .startgrd_vault.json
	_ = os.WriteFile(filepath.Join(dir, ".startgrd_vault.json"), []byte(`{"version":1,"salt":"abc"}`), 0o644)

	// Create another dotfile
	_ = os.WriteFile(filepath.Join(dir, ".hidden.json"), []byte(`{"page-name":"Hidden"}`), 0o644)

	// Create dot-folder with file inside
	dotDir := filepath.Join(dir, ".git")
	_ = os.MkdirAll(dotDir, 0o755)
	_ = os.WriteFile(filepath.Join(dotDir, "config.json"), []byte(`{"page-name":"Git Config"}`), 0o644)

	store.InitCache()

	pages, status, errMsg := store.ListPages("default")
	if status != 0 {
		t.Fatalf("ListPages failed: %s", errMsg)
	}

	if len(pages) != 1 {
		t.Fatalf("expected exactly 1 page, got %d: %+v", len(pages), pages)
	}
	if pages[0].Slug != "my-page" {
		t.Errorf("expected slug 'my-page', got %q", pages[0].Slug)
	}
}

func TestGetDueTasks(t *testing.T) {
	store, dir := makeStore(t)

	today := time.Now().UTC().Truncate(24 * time.Hour)
	yesterdayStr := today.Add(-24 * time.Hour).Format("2006-01-02")
	todayStr := today.Format("2006-01-02")
	tomorrowStr := today.Add(24 * time.Hour).Format("2006-01-02")
	futureStr := today.Add(48 * time.Hour).Format("2006-01-02")

	bFalse := false
	bTrue := true

	page1 := models.Page{
		PageName: "Tasks Page",
		Groups: []models.Group{
			{
				Title: "Work",
				Items: []models.Item{
					{Title: "Overdue yesterday", TaskChecked: &bFalse, TaskDueDate: &yesterdayStr},
					{Title: "Due today", TaskChecked: &bFalse, TaskDueDate: &todayStr},
					{Title: "Due tomorrow", TaskChecked: &bFalse, TaskDueDate: &tomorrowStr},
					{Title: "Due future", TaskChecked: &bFalse, TaskDueDate: &futureStr},
					{Title: "Completed overdue", TaskChecked: &bTrue, TaskDueDate: &yesterdayStr},
				},
			},
		},
	}
	writeJSON(t, filepath.Join(dir, "tasks-page.grid"), page1)

	// Hidden page: tasks should not be included
	pageHidden := models.Page{
		PageName: "Hidden Tasks",
		Hidden:   true,
		Groups: []models.Group{
			{
				Title: "Secret",
				Items: []models.Item{
					{Title: "Hidden overdue", TaskChecked: &bFalse, TaskDueDate: &yesterdayStr},
				},
			},
		},
	}
	writeJSON(t, filepath.Join(dir, "hidden-tasks.grid"), pageHidden)

	store.InitCache()

	dueTasks := store.GetDueTasks()
	if len(dueTasks) != 3 {
		t.Fatalf("expected 3 due tasks, got %d: %+v", len(dueTasks), dueTasks)
	}

	// First two should be overdue, sorted by due date
	if dueTasks[0].Title != "Overdue yesterday" || dueTasks[0].DueStatus != "overdue" {
		t.Errorf("task[0] = %+v, want 'Overdue yesterday' (overdue)", dueTasks[0])
	}
	if dueTasks[1].Title != "Due today" || dueTasks[1].DueStatus != "overdue" {
		t.Errorf("task[1] = %+v, want 'Due today' (overdue)", dueTasks[1])
	}
	// Third should be due_soon
	if dueTasks[2].Title != "Due tomorrow" || dueTasks[2].DueStatus != "due_soon" {
		t.Errorf("task[2] = %+v, want 'Due tomorrow' (due_soon)", dueTasks[2])
	}

	// Update page: mark "Due today" as checked
	page1.Groups[0].Items[1].TaskChecked = &bTrue
	status, errMsg := store.WritePage("tasks-page", page1, "default")
	if status != 0 {
		t.Fatalf("WritePage failed: %s", errMsg)
	}

	dueTasksAfter := store.GetDueTasks()
	if len(dueTasksAfter) != 2 {
		t.Fatalf("expected 2 due tasks after checking, got %d: %+v", len(dueTasksAfter), dueTasksAfter)
	}
	if dueTasksAfter[0].Title != "Overdue yesterday" {
		t.Errorf("expected 'Overdue yesterday', got %q", dueTasksAfter[0].Title)
	}
	if dueTasksAfter[1].Title != "Due tomorrow" {
		t.Errorf("expected 'Due tomorrow', got %q", dueTasksAfter[1].Title)
	}
}

func TestGetAllTasks(t *testing.T) {
	store, dir := makeStore(t)

	today := time.Now().UTC().Truncate(24 * time.Hour)
	yesterdayStr := today.Add(-24 * time.Hour).Format("2006-01-02")
	tomorrowStr := today.Add(24 * time.Hour).Format("2006-01-02")
	futureStr := today.Add(7 * 24 * time.Hour).Format("2006-01-02")

	bFalse := false
	bTrue := true

	created1 := "2026-01-01T10:00:00Z"
	created2 := "2026-01-02T10:00:00Z"
	created3 := "2026-01-03T10:00:00Z"
	created4 := "2026-01-04T10:00:00Z"

	page := models.Page{
		PageName: "All Tasks Page",
		Groups: []models.Group{
			{
				Title: "Work",
				Items: []models.Item{
					{Title: "Task No Due 2", TaskChecked: &bFalse, CreatedAt: &created3},
					{Title: "Task Due Future", TaskChecked: &bFalse, TaskDueDate: &futureStr, CreatedAt: &created4},
					{Title: "Task Due Yesterday", TaskChecked: &bFalse, TaskDueDate: &yesterdayStr, CreatedAt: &created2},
					{Title: "Task Due Tomorrow Earlier", TaskChecked: &bFalse, TaskDueDate: &tomorrowStr, CreatedAt: &created1},
					{Title: "Task Due Tomorrow Later", TaskChecked: &bFalse, TaskDueDate: &tomorrowStr, CreatedAt: &created2},
					{Title: "Task No Due 1", TaskChecked: &bFalse, CreatedAt: &created1},
					{Title: "Task No Due No Created", TaskChecked: &bFalse},
					{Title: "Task Completed", TaskChecked: &bTrue, TaskDueDate: &yesterdayStr, CreatedAt: &created1},
				},
			},
		},
	}
	writeJSON(t, filepath.Join(dir, "all-tasks-page.grid"), page)

	// Hidden page: should not be included
	hiddenPage := models.Page{
		PageName: "Hidden Page",
		Hidden:   true,
		Groups: []models.Group{
			{
				Title: "Secret",
				Items: []models.Item{
					{Title: "Hidden Task", TaskChecked: &bFalse, TaskDueDate: &yesterdayStr},
				},
			},
		},
	}
	writeJSON(t, filepath.Join(dir, "hidden-tasks-page.grid"), hiddenPage)

	store.InitCache()

	allTasks := store.GetAllTasks()
	// Total tasks should be 7 (excluding completed and hidden)
	if len(allTasks) != 7 {
		t.Fatalf("expected 7 tasks, got %d: %+v", len(allTasks), allTasks)
	}

	// Order:
	// 1. Tasks with a due date:
	//    - Task Due Yesterday (yesterday, overdue)
	//    - Task Due Tomorrow Earlier (tomorrow, due_soon, created1)
	//    - Task Due Tomorrow Later (tomorrow, due_soon, created2)
	//    - Task Due Future (future, upcoming, created4)
	// 2. Tasks without a due date:
	//    - Task No Due 1 (created1: 2026-01-01)
	//    - Task No Due 2 (created3: 2026-01-03)
	//    - Task No Due No Created (no date, placed at end)
	expectedTitles := []string{
		"Task Due Yesterday",
		"Task Due Tomorrow Earlier",
		"Task Due Tomorrow Later",
		"Task Due Future",
		"Task No Due 1",
		"Task No Due 2",
		"Task No Due No Created",
	}

	for i, want := range expectedTitles {
		if allTasks[i].Title != want {
			t.Errorf("task[%d] = %q, want %q", i, allTasks[i].Title, want)
		}
	}

	if allTasks[0].DueStatus != "overdue" {
		t.Errorf("task[0] status = %q, want 'overdue'", allTasks[0].DueStatus)
	}
	if allTasks[1].DueStatus != "due_soon" {
		t.Errorf("task[1] status = %q, want 'due_soon'", allTasks[1].DueStatus)
	}
	if allTasks[3].DueStatus != "upcoming" {
		t.Errorf("task[3] status = %q, want 'upcoming'", allTasks[3].DueStatus)
	}
	if allTasks[4].DueStatus != "" {
		t.Errorf("task[4] status = %q, want ''", allTasks[4].DueStatus)
	}
}

func TestWhiteboardStorage(t *testing.T) {
	store, _ := makeStore(t)

	// Invalid content
	_, _, status, _ := store.WriteWhiteboardPage("", "not-json", "default")
	if status != 400 {
		t.Errorf("expected 400 for invalid JSON, got %d", status)
	}
	_, _, status, _ = store.WriteWhiteboardPage("", `{"elements":[]}`, "default")
	if status != 400 {
		t.Errorf("expected 400 for missing page-name, got %d", status)
	}

	// Valid creation
	content := `{"page-name":"Architecture Diagram","elements":[{"type":"rectangle"}]}`
	newSlug, pageName, status, errMsg := store.WriteWhiteboardPage("", content, "default")
	if status != 0 {
		t.Fatalf("WriteWhiteboardPage failed: %d %s", status, errMsg)
	}
	if newSlug != "architecture-diagram" || pageName != "Architecture Diagram" {
		t.Errorf("unexpected slug or name: %s, %s", newSlug, pageName)
	}

	// Read
	readContent, status, errMsg := store.ReadWhiteboardPage(newSlug, "default")
	if status != 0 {
		t.Fatalf("ReadWhiteboardPage failed: %d %s", status, errMsg)
	}
	if !strings.Contains(readContent, "Architecture Diagram") {
		t.Errorf("read content missing page-name: %s", readContent)
	}

	// Read non-existent
	_, status, _ = store.ReadWhiteboardPage("non-existent", "default")
	if status != 404 {
		t.Errorf("expected 404 for non-existent whiteboard, got %d", status)
	}

	// Update / rename
	updatedContent := `{"page-name":"Architecture Diagram V2","elements":[{"type":"rectangle"}]}`
	renamedSlug, _, status, _ := store.WriteWhiteboardPage(newSlug, updatedContent, "default")
	if status != 0 {
		t.Fatalf("WriteWhiteboardPage rename failed: %d", status)
	}
	if renamedSlug != "architecture-diagram-v2" {
		t.Errorf("expected renamed slug, got %s", renamedSlug)
	}

	// Delete
	status, errMsg = store.DeleteWhiteboardPage(renamedSlug, "default")
	if status != 0 {
		t.Fatalf("DeleteWhiteboardPage failed: %d %s", status, errMsg)
	}
	status, _ = store.DeleteWhiteboardPage(renamedSlug, "default")
	if status != 404 {
		t.Errorf("expected 404 on deleting non-existent whiteboard, got %d", status)
	}
}

func TestBpmnStorage(t *testing.T) {
	store, _ := makeStore(t)

	// Invalid content
	_, _, status, _ := store.WriteBpmnPage("", "not-json", "default")
	if status != 400 {
		t.Errorf("expected 400 for non-json, got %d", status)
	}
	_, _, status, _ = store.WriteBpmnPage("", `{"page-name":""}`, "default")
	if status != 400 {
		t.Errorf("expected 400 for empty page-name, got %d", status)
	}
	_, _, status, _ = store.WriteBpmnPage("", `{"page-name":"Order Flow","bpmn_xml":""}`, "default")
	if status != 400 {
		t.Errorf("expected 400 for empty bpmn_xml, got %d", status)
	}

	// Valid creation
	xmlData := `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process id="Process_1" name="Order Processing"/></bpmn:definitions>`
	content := `{"page-name":"Order Process","bpmn_xml":"` + strings.ReplaceAll(xmlData, `"`, `\"`) + `"}`
	newSlug, pageName, status, errMsg := store.WriteBpmnPage("", content, "default")
	if status != 0 {
		t.Fatalf("WriteBpmnPage failed: %d %s", status, errMsg)
	}
	if newSlug != "order-process" || pageName != "Order Process" {
		t.Errorf("unexpected slug or name: %s, %s", newSlug, pageName)
	}

	// Read
	readJSON, status, errMsg := store.ReadBpmnPage(newSlug, "default")
	if status != 0 {
		t.Fatalf("ReadBpmnPage failed: %d %s", status, errMsg)
	}
	if !strings.Contains(readJSON, "Order Process") || !strings.Contains(readJSON, "bpmn_xml") {
		t.Errorf("unexpected read JSON: %s", readJSON)
	}

	// Read non-existent
	_, status, _ = store.ReadBpmnPage("non-existent", "default")
	if status != 404 {
		t.Errorf("expected 404 for non-existent BPMN, got %d", status)
	}

	// Update / rename
	updatedContent := `{"page-name":"Order Process V2","bpmn_xml":"` + strings.ReplaceAll(xmlData, `"`, `\"`) + `"}`
	renamedSlug, _, status, _ := store.WriteBpmnPage(newSlug, updatedContent, "default")
	if status != 0 {
		t.Fatalf("WriteBpmnPage update failed: %d", status)
	}
	if renamedSlug != "order-process-v2" {
		t.Errorf("expected renamed slug, got %s", renamedSlug)
	}

	// Delete
	status, errMsg = store.DeleteBpmnPage(renamedSlug, "default")
	if status != 0 {
		t.Fatalf("DeleteBpmnPage failed: %d %s", status, errMsg)
	}
	status, _ = store.DeleteBpmnPage(renamedSlug, "default")
	if status != 404 {
		t.Errorf("expected 404 on deleting non-existent BPMN, got %d", status)
	}

	// ExtractBpmnNameFromReader
	name := storage.ExtractBpmnNameFromReader(strings.NewReader(xmlData))
	if name != "Order Processing" {
		t.Errorf("ExtractBpmnNameFromReader = %q, want 'Order Processing'", name)
	}
}

func TestUpdateLinksAfterPageRename(t *testing.T) {
	store, _ := makeStore(t)

	// No-op if oldSlug == newSlug
	if err := store.UpdateLinksAfterPageRename("same", "same", "default"); err != nil {
		t.Errorf("expected nil for same slug rename: %v", err)
	}

	// Invalid location
	if err := store.UpdateLinksAfterPageRename("old", "new", "nonexistent"); err == nil {
		t.Error("expected error for invalid location")
	}

	// Create a grid page with internal links to an old page
	oldURL1 := "/default/target-old"
	oldURL2 := "http://localhost:8000/default/target-old"
	gridPage := models.Page{
		PageName: "Overview",
		Groups: []models.Group{
			{
				Title: "Links",
				Items: []models.Item{
					{Title: "Link 1", URL: &oldURL1},
					{Title: "Link 2", URL: &oldURL2},
				},
			},
		},
	}
	store.WritePage("overview", gridPage, "default")

	// Create a note page with internal links
	noteMD := `# Note
Check [Link](http://localhost:8000/default/target-old) and [Bare](/target-old).`
	noteSlug, _, status, _ := store.WriteNotePage("", noteMD, "default")
	if status != 0 {
		t.Fatalf("WriteNotePage failed: %d", status)
	}

	// Perform link update
	if err := store.UpdateLinksAfterPageRename("target-old", "target-new", "default"); err != nil {
		t.Fatalf("UpdateLinksAfterPageRename: %v", err)
	}

	// Verify grid links updated
	updatedGrid, status, _ := store.ReadPage("overview", "default")
	if status != 0 {
		t.Fatalf("ReadPage failed: %d", status)
	}
	if *updatedGrid.Groups[0].Items[0].URL != "/default/target-new" {
		t.Errorf("link 1 not updated: %s", *updatedGrid.Groups[0].Items[0].URL)
	}
	if *updatedGrid.Groups[0].Items[1].URL != "/default/target-new" {
		t.Errorf("link 2 not updated: %s", *updatedGrid.Groups[0].Items[1].URL)
	}

	// Verify note links updated
	updatedNote, status, _ := store.ReadNotePage(noteSlug, "default")
	if status != 0 {
		t.Fatalf("ReadNotePage failed: %d", status)
	}
	if !strings.Contains(updatedNote, "](/default/target-new)") || !strings.Contains(updatedNote, "](/target-new)") {
		t.Errorf("note links not updated properly: %s", updatedNote)
	}
}

func TestWorkspaceMethodsAndHelpers(t *testing.T) {
	dir1 := t.TempDir()
	dir2 := t.TempDir()

	store := storage.New(fstest.MapFS{}, os.TempDir())
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"primary": {Path: dir1, FernetKey: "key1"},
		"hidden":  {Path: dir2, Hidden: true},
	}, []string{"primary", "hidden"})

	// Workspaces()
	ws := store.Workspaces()
	if len(ws) != 2 || ws["primary"].Path != dir1 {
		t.Errorf("Workspaces mismatch: %+v", ws)
	}

	// VisibleWorkspaceNames()
	visible := store.VisibleWorkspaceNames()
	if len(visible) != 1 || visible[0] != "primary" {
		t.Errorf("VisibleWorkspaceNames = %v, want ['primary']", visible)
	}

	// GetWorkspaceFernetKey()
	k := store.GetWorkspaceFernetKey("primary")
	if k != "key1" {
		t.Errorf("GetWorkspaceFernetKey = %q, want 'key1'", k)
	}
	if store.GetWorkspaceFernetKey("nonexistent") != "" {
		t.Error("expected empty key for nonexistent workspace")
	}

	// ReloadCacheForWorkspace()
	store.ReloadCacheForWorkspace("primary")

	// ParseWorkspaces with slice input
	sliceInput := []any{
		map[string]any{"name": "simple-ws", "path": "./simple"},
		map[string]any{"name": "complex-ws", "path": "./rel", "fernet_key": "k2"},
	}
	parsed, ordered, err := storage.ParseWorkspaces(sliceInput, "/base/data", "/base")
	if err != nil {
		t.Fatalf("ParseWorkspaces slice: %v", err)
	}
	if len(parsed) != 2 || len(ordered) != 2 {
		t.Errorf("expected 2 workspaces, got %d", len(parsed))
	}
}

func TestDocsWorkspaceLoading(t *testing.T) {
	docsFS := fstest.MapFS{
		"docs/getting-started.md": &fstest.MapFile{
			Data:    []byte("# Getting Started\nWelcome to StartGRD docs!"),
			Mode:    0o644,
			ModTime: time.Now(),
		},
	}
	store := storage.New(docsFS, os.TempDir())
	store.InitCache()

	// Should list docs note page
	pages, status, errMsg := store.ListPages("docs")
	if status != 0 {
		t.Fatalf("ListPages docs failed: %d %s", status, errMsg)
	}
	if len(pages) != 1 {
		t.Fatalf("expected 1 docs page, got %d: %+v", len(pages), pages)
	}
	if pages[0].PageName != "Getting Started" || pages[0].PageType != "note" {
		t.Errorf("unexpected page meta: %+v", pages[0])
	}

	// Read note from docs
	content, status, errMsg := store.ReadNotePage("getting-started", "docs")
	if status != 0 {
		t.Fatalf("ReadNotePage from docs failed: %d %s", status, errMsg)
	}
	if !strings.Contains(content, "Welcome to StartGRD docs!") {
		t.Errorf("unexpected docs content: %s", content)
	}

	// Docs is read-only
	status, _ = store.DeleteNotePage("getting-started", "docs")
	if status != 403 {
		t.Errorf("expected 403 on DeleteNotePage for docs, got %d", status)
	}
	_, _, status, _ = store.WriteNotePage("getting-started", "content", "docs")
	if status != 403 {
		t.Errorf("expected 403 on WriteNotePage for docs, got %d", status)
	}
}

func TestIndexIgnoresOldJsonPagesInCache(t *testing.T) {
	store, dir := makeStore(t)

	// Pre-seed an index with an old .json entry
	indexDir := filepath.Join(dir, "data")
	_ = os.MkdirAll(indexDir, 0o755)
	oldIndex := storage.IndexData{
		PageEntries: map[storage.CacheKey]storage.PageEntry{
			{Location: "default", Slug: "old-page"}: {
				Meta: models.PageMeta{
					Slug:     "old-page",
					PageName: "Old Page",
					PageType: "grid",
					Location: "default",
					FileName: "old-page.json",
				},
				RelPath: "old-page.json",
			},
		},
		FileModTimes: map[string]int64{
			"default:old-page.json": 12345,
		},
	}
	data, _ := json.Marshal(oldIndex)
	_ = os.WriteFile(filepath.Join(indexDir, ".startgrd_index.json"), data, 0o644)

	// File still exists on disk as .json
	_ = os.WriteFile(filepath.Join(dir, "old-page.json"), []byte("{\"page-name\":\"Old Page\",\"groups\":[]}"), 0o644)

	store.InitCache()

	pages, status, errMsg := store.ListPages("default")
	if status != 0 {
		t.Fatalf("ListPages failed: %d %s", status, errMsg)
	}
	if len(pages) != 0 {
		t.Errorf("expected 0 pages because old-page.json is not .grid, got %d", len(pages))
	}
}

func TestExtractH1AndBpmn(t *testing.T) {
	// ExtractH1
	if got := storage.ExtractH1("# My Page Title\nSome content"); got != "My Page Title" {
		t.Errorf("ExtractH1: got %q, want %q", got, "My Page Title")
	}
	if got := storage.ExtractH1("No heading here"); got != "" {
		t.Errorf("ExtractH1 with no heading: got %q, want empty", got)
	}

	// ExtractH1FromReader
	r1 := strings.NewReader("line 1\n# Heading From Reader\nline 3")
	if got := storage.ExtractH1FromReader(r1); got != "Heading From Reader" {
		t.Errorf("ExtractH1FromReader: got %q, want %q", got, "Heading From Reader")
	}
	r2 := strings.NewReader("no heading")
	if got := storage.ExtractH1FromReader(r2); got != "" {
		t.Errorf("ExtractH1FromReader with no heading: got %q, want empty", got)
	}

	// ExtractBpmnNameFromReader
	bpmnXml1 := `<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" name="Definitions Name"><bpmn:process id="p1" name="Process Name"/></bpmn:definitions>`
	if got := storage.ExtractBpmnNameFromReader(strings.NewReader(bpmnXml1)); got != "Definitions Name" {
		t.Errorf("ExtractBpmnNameFromReader: got %q, want Definitions Name", got)
	}

	bpmnXml2 := `<?xml version="1.0"?><bpmn:process xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" name="Proc Only"/>`
	if got := storage.ExtractBpmnNameFromReader(strings.NewReader(bpmnXml2)); got != "Proc Only" {
		t.Errorf("ExtractBpmnNameFromReader: got %q, want Proc Only", got)
	}

	bpmnXml3 := `<root><process id="p1"/></root>`
	if got := storage.ExtractBpmnNameFromReader(strings.NewReader(bpmnXml3)); got != "" {
		t.Errorf("ExtractBpmnNameFromReader without name: got %q, want empty", got)
	}

	if got := storage.ExtractBpmnNameFromReader(strings.NewReader("invalid xml")); got != "" {
		t.Errorf("ExtractBpmnNameFromReader with invalid xml: got %q, want empty", got)
	}
}

func TestParseWorkspacesErrors(t *testing.T) {
	baseDir := t.TempDir()

	// Non-array, non-map -> error
	_, _, err := storage.ParseWorkspaces(42, baseDir, baseDir)
	if err == nil {
		t.Errorf("expected error for int workspaces, got nil")
	}

	// Slice with non-object
	_, _, err = storage.ParseWorkspaces([]interface{}{"bad"}, baseDir, baseDir)
	if err == nil {
		t.Errorf("expected error for slice with non-object, got nil")
	}

	// Slice with empty name
	_, _, err = storage.ParseWorkspaces([]interface{}{map[string]interface{}{"name": "  ", "path": "p"}}, baseDir, baseDir)
	if err == nil {
		t.Errorf("expected error for slice with empty name, got nil")
	}

	// Slice with empty path
	_, _, err = storage.ParseWorkspaces([]interface{}{map[string]interface{}{"name": "ws", "path": ""}}, baseDir, baseDir)
	if err == nil {
		t.Errorf("expected error for slice with empty path, got nil")
	}

	// Map with non-string, non-object value
	_, _, err = storage.ParseWorkspaces(map[string]interface{}{"ws": 123}, baseDir, baseDir)
	if err == nil {
		t.Errorf("expected error for map with int value, got nil")
	}

	// Map with object missing path
	_, _, err = storage.ParseWorkspaces(map[string]interface{}{"ws": map[string]interface{}{"path": ""}}, baseDir, baseDir)
	if err == nil {
		t.Errorf("expected error for map object missing path, got nil")
	}

	// Valid slice with relative and absolute paths
	absPath := filepath.Join(baseDir, "abs")
	sliceWorkspaces := []interface{}{
		map[string]interface{}{"name": "rel_ws", "path": "sub/data", "hidden": true, "fernet_key": "key1"},
		map[string]interface{}{"name": "abs_ws", "path": absPath},
	}
	res, order, err := storage.ParseWorkspaces(sliceWorkspaces, baseDir, baseDir)
	if err != nil {
		t.Fatalf("unexpected error parsing valid slice: %v", err)
	}
	if len(order) != 2 || res["rel_ws"].Path != filepath.Join(baseDir, "sub", "data") || res["abs_ws"].Path != absPath {
		t.Errorf("unexpected parse result: %+v, order: %+v", res, order)
	}
	if !res["rel_ws"].Hidden || res["rel_ws"].FernetKey != "key1" {
		t.Errorf("unexpected properties on rel_ws: %+v", res["rel_ws"])
	}

	// Valid map with string and object values
	mapWorkspaces := map[string]interface{}{
		"ws1": "sub1",
		"ws2": map[string]interface{}{"path": "sub2", "hidden": false},
	}
	resMap, orderMap, err := storage.ParseWorkspaces(mapWorkspaces, baseDir, baseDir)
	if err != nil {
		t.Fatalf("unexpected error parsing valid map: %v", err)
	}
	if len(orderMap) != 2 || resMap["ws1"].Path != filepath.Join(baseDir, "sub1") {
		t.Errorf("unexpected map result: %+v", resMap)
	}
}

func TestReadFileWithRetry(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "temp.txt")
	_ = os.WriteFile(filePath, []byte("hello retry"), 0o644)

	data, err := storage.ReadFileWithRetry(filePath)
	if err != nil || string(data) != "hello retry" {
		t.Fatalf("ReadFileWithRetry on valid file failed: %v", err)
	}
}

func ptrS(s string) *string {
	return &s
}

func TestWhiteboardAndBpmnDocsAndNotFound(t *testing.T) {
	docsFS := fstest.MapFS{
		"docs/sample.excalidraw": &fstest.MapFile{Data: []byte(`{"page-name":"Sample WB"}`)},
		"docs/sample.bpmn":       &fstest.MapFile{Data: []byte(`<definitions name="Sample BPMN"/>`)},
	}
	store := storage.New(docsFS, t.TempDir())
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: t.TempDir()},
	}, []string{"default"})

	// Read from docs
	wb, status, _ := store.ReadWhiteboardPage("sample-wb", "docs")
	if status != 0 || !strings.Contains(wb, "Sample WB") {
		t.Errorf("expected 200 reading whiteboard from docs, got %d %s", status, wb)
	}

	bpmn, status, _ := store.ReadBpmnPage("sample-bpmn", "docs")
	if status != 0 || !strings.Contains(bpmn, "Sample BPMN") {
		t.Errorf("expected 200 reading bpmn from docs, got %d %s", status, bpmn)
	}

	// Docs read-only checks
	if _, _, status, _ := store.WriteWhiteboardPage("sample", "data", "docs"); status != 403 {
		t.Errorf("expected 403 for WriteWhiteboardPage docs, got %d", status)
	}
	if status, _ := store.DeleteWhiteboardPage("sample", "docs"); status != 403 {
		t.Errorf("expected 403 for DeleteWhiteboardPage docs, got %d", status)
	}
	if _, _, status, _ := store.WriteBpmnPage("sample", "data", "docs"); status != 403 {
		t.Errorf("expected 403 for WriteBpmnPage docs, got %d", status)
	}
	if status, _ := store.DeleteBpmnPage("sample", "docs"); status != 403 {
		t.Errorf("expected 403 for DeleteBpmnPage docs, got %d", status)
	}

	// Not found checks
	if _, status, _ := store.ReadWhiteboardPage("missing", "default"); status != 404 {
		t.Errorf("expected 404 for missing whiteboard, got %d", status)
	}
	if status, _ := store.DeleteWhiteboardPage("missing", "default"); status != 404 {
		t.Errorf("expected 404 for deleting missing whiteboard, got %d", status)
	}
	if _, status, _ := store.ReadBpmnPage("missing", "default"); status != 404 {
		t.Errorf("expected 404 for missing bpmn, got %d", status)
	}
	if status, _ := store.DeleteBpmnPage("missing", "default"); status != 404 {
		t.Errorf("expected 404 for deleting missing bpmn, got %d", status)
	}
}

func TestGetAllTasksVariousDateFormats(t *testing.T) {
	store, _ := makeStore(t)

	checked := false
	due := "2026-11-10"
	p := models.Page{
		PageName: "Dates Page",
		Groups: []models.Group{
			{
				Title: "G",
				Items: []models.Item{
					{Title: "Task Nano", TaskChecked: &checked, TaskDueDate: &due, TaskCreated: ptrS("2026-11-06T08:20:00.123456789Z")},
					{Title: "Task RFC3339", TaskChecked: &checked, TaskDueDate: &due, TaskCreated: ptrS("2026-11-06T08:20:00Z")},
					{Title: "Task DateTime", TaskChecked: &checked, TaskDueDate: &due, TaskCreated: ptrS("2026-11-06T08:20:00")},
					{Title: "Task Date", TaskChecked: &checked, TaskDueDate: &due, TaskCreated: ptrS("2026-11-06")},
					{Title: "Task Bad Date", TaskChecked: &checked, TaskCreated: ptrS("not-a-date")},
					{Title: "Task Empty Date", TaskChecked: &checked, TaskCreated: ptrS("")},
				},
			},
		},
	}

	store.WritePage("dates-page", p, "default")
	tasks := store.GetAllTasks()
	if len(tasks) < 6 {
		t.Errorf("expected at least 6 tasks, got %d", len(tasks))
	}
}
