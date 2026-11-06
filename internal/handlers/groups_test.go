package handlers_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"testing/fstest"
	"time"

	"github.com/ExoDeck/exodeck/internal/handlers"
	"github.com/ExoDeck/exodeck/internal/models"
	"github.com/ExoDeck/exodeck/internal/storage"
	"github.com/ExoDeck/exodeck/internal/vault"
)

// --------------------------------------------------------------------------
// Group CRUD
// --------------------------------------------------------------------------

func TestGroupAddUpdateDelete(t *testing.T) {
	ts, store, _ := newTestServer(t)

	// Seed a page
	store.WritePage("my-page", models.Page{PageName: "My Page", Groups: []models.Group{}}, "") //nolint:errcheck

	// Add group
	group := models.Group{Title: "New Group", Items: []models.Item{}}
	code, body := post(t, ts, "/api/v1/pages/my-page/groups", group)
	if code != http.StatusCreated {
		t.Fatalf("POST group: %d %v", code, body)
	}
	gIdx, _ := body["group_index"].(float64)
	if int(gIdx) != 0 {
		t.Errorf("group_index = %v, want 0", gIdx)
	}

	// Update group
	updated := models.Group{Title: "Updated Group", Items: []models.Item{}}
	code, _ = put(t, ts, "/api/v1/pages/my-page/groups/0", updated)
	if code != http.StatusOK {
		t.Fatalf("PUT group: %d", code)
	}

	// Delete group
	code = del(t, ts, "/api/v1/pages/my-page/groups/0")
	if code != http.StatusNoContent {
		t.Fatalf("DELETE group: %d", code)
	}
}

func TestGroupIndexOutOfRangeReturns422(t *testing.T) {
	ts, store, _ := newTestServer(t)
	store.WritePage("p", models.Page{PageName: "P", Groups: []models.Group{}}, "") //nolint:errcheck

	code, _ := put(t, ts, "/api/v1/pages/p/groups/10", models.Group{Title: "X"})
	if code != 422 {
		t.Errorf("PUT out-of-range group: %d, want 422", code)
	}

	code = del(t, ts, "/api/v1/pages/p/groups/10")
	if code != 422 {
		t.Errorf("DELETE out-of-range group: %d, want 422", code)
	}
}

func TestGroupMissingPageReturns404(t *testing.T) {
	ts, _, _ := newTestServer(t)

	code, _ := post(t, ts, "/api/v1/pages/missing/groups", models.Group{Title: "X"})
	if code != http.StatusNotFound {
		t.Errorf("POST group on missing page: %d", code)
	}

	code, _ = put(t, ts, "/api/v1/pages/missing/groups/0", models.Group{Title: "X"})
	if code != http.StatusNotFound {
		t.Errorf("PUT group on missing page: %d", code)
	}

	code = del(t, ts, "/api/v1/pages/missing/groups/0")
	if code != http.StatusNotFound {
		t.Errorf("DELETE group on missing page: %d", code)
	}
}

func TestGroupLocationSupport(t *testing.T) {
	ts, store, _, _ := newTestServerMultiLocation(t)

	store.WritePage("p", models.Page{PageName: "P", Groups: []models.Group{}}, "work") //nolint:errcheck

	code, body := post(t, ts, "/api/v1/pages/p/groups?location=work", models.Group{Title: "G"})
	if code != http.StatusCreated {
		t.Fatalf("POST group to work: %d %v", code, body)
	}
}

func TestMoveGroup(t *testing.T) {
	ts, store, _ := newTestServer(t)

	// Seed source page with 2 groups and target page with 0 groups
	store.WritePage("page-a", models.Page{
		PageName: "Page A",
		Groups: []models.Group{
			{Title: "Group 0", Items: []models.Item{{Title: "Item 0"}}},
			{Title: "Group 1", Items: []models.Item{{Title: "Item 1"}}},
		},
	}, "")
	store.WritePage("page-b", models.Page{
		PageName: "Page B",
		Groups:   []models.Group{},
	}, "")

	// Invalid target page
	reqBad := models.MoveGroupRequest{TargetSlug: "nonexistent"}
	code, _ := post(t, ts, "/api/v1/pages/page-a/groups/0/move", reqBad)
	if code != 422 {
		t.Errorf("move to nonexistent page: got %d, want 422", code)
	}

	// Out of range group index
	reqValid := models.MoveGroupRequest{TargetSlug: "page-b"}
	code, _ = post(t, ts, "/api/v1/pages/page-a/groups/99/move", reqValid)
	if code != 422 {
		t.Errorf("move out of range group: got %d, want 422", code)
	}

	// Valid move
	code, body := post(t, ts, "/api/v1/pages/page-a/groups/0/move", reqValid)
	if code != http.StatusOK {
		t.Fatalf("move group: got %d %v", code, body)
	}

	// Verify source page now has 1 group and target page has 1 group
	pageA, _, _ := store.ReadPage("page-a", "")
	if len(pageA.Groups) != 1 || pageA.Groups[0].Title != "Group 1" {
		t.Errorf("unexpected pageA groups: %+v", pageA.Groups)
	}
	pageB, _, _ := store.ReadPage("page-b", "")
	if len(pageB.Groups) != 1 || pageB.Groups[0].Title != "Group 0" {
		t.Errorf("unexpected pageB groups: %+v", pageB.Groups)
	}
}

func TestMoveGroupCrossLocationWithEncryption(t *testing.T) {
	defaultDir := t.TempDir()
	workDir := t.TempDir()
	configDir := t.TempDir()

	store := storage.New(fstest.MapFS{}, os.TempDir())
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: defaultDir},
		"work":    {Path: workDir},
	}, []string{"default", "work"})

	v := vault.New(15 * time.Minute)
	srv := &handlers.Server{
		Store:      store,
		Vault:      v,
		ConfigDir:  configDir,
		FrontendFS: stubFrontendFS,
	}
	ts := httptest.NewServer(handlers.NewRouter(srv))
	defer ts.Close()

	// Setup vaults for both workspaces
	post(t, ts, "/api/v1/workspaces/default/vault/setup", map[string]string{"password": "PassDefault123!"})
	post(t, ts, "/api/v1/workspaces/work/vault/setup", map[string]string{"password": "PassWork123!"})

	// Create source page with sensitive item in default
	pw := "SecretPassword"
	store.WritePage("sec-src", models.Page{
		PageName: "SecSrc",
		Groups: []models.Group{
			{Title: "Secrets", Items: []models.Item{}},
		},
	}, "default")
	post(t, ts, "/api/v1/pages/sec-src/groups/0/items?location=default", models.Item{
		Title:    "Admin",
		Password: &pw,
	})

	// Create destination page in work
	store.WritePage("sec-dst", models.Page{
		PageName: "SecDst",
		Groups:   []models.Group{},
	}, "work")

	// 1. Move to invalid target location returns 404
	badLoc := "invalid-ws"
	reqBadLoc := models.MoveGroupRequest{
		TargetSlug:     "sec-dst",
		TargetLocation: &badLoc,
	}
	code, _ := post(t, ts, "/api/v1/pages/sec-src/groups/0/move?location=default", reqBadLoc)
	if code != 422 {
		t.Errorf("expected 422 for invalid target location, got %d", code)
	}

	// 2. Lock target workspace -> returns 423 Locked because group has sensitive items
	post(t, ts, "/api/v1/workspaces/work/vault/lock", nil)
	targetLoc := "work"
	reqWork := models.MoveGroupRequest{
		TargetSlug:     "sec-dst",
		TargetLocation: &targetLoc,
	}
	code, _ = post(t, ts, "/api/v1/pages/sec-src/groups/0/move?location=default", reqWork)
	if code != http.StatusLocked {
		t.Errorf("expected 423 when target vault locked, got %d", code)
	}

	// 3. Unlock target workspace -> successful cross-location move with re-encryption
	post(t, ts, "/api/v1/workspaces/work/vault/unlock", map[string]string{"password": "PassWork123!"})
	code, _ = post(t, ts, "/api/v1/pages/sec-src/groups/0/move?location=default", reqWork)
	if code != http.StatusOK {
		t.Fatalf("expected 200 for moving group across locations, got %d", code)
	}

	// 4. Verify password in target workspace decrypts properly with work's vault
	code, body := get(t, ts, "/api/v1/pages/sec-dst?location=work")
	if code != http.StatusOK {
		t.Fatalf("get target page: %d", code)
	}
	p := mapToPage(body)
	if len(p.Groups) != 1 || len(p.Groups[0].Items) != 1 {
		t.Fatalf("unexpected target page structure: %+v", p)
	}
	if p.Groups[0].Items[0].Password == nil || *p.Groups[0].Items[0].Password != pw {
		t.Errorf("expected decrypted password %q in target workspace, got %v", pw, p.Groups[0].Items[0].Password)
	}
}

func TestGroupErrorBranches(t *testing.T) {
	defaultDir := t.TempDir()
	configDir := t.TempDir()

	docsFS := fstest.MapFS{
		"docs/p-docs.grid": &fstest.MapFile{
			Data: []byte(`{"page-name":"PDocs","groups":[{"title":"G0","items":[]}]}`),
		},
	}
	store := storage.New(docsFS, os.TempDir())
	store.SetWorkspaces(map[string]storage.WorkspaceConfig{
		"default": {Path: defaultDir},
	}, []string{"default"})

	v := vault.New(15 * time.Minute)
	srv := &handlers.Server{
		Store:      store,
		Vault:      v,
		ConfigDir:  configDir,
		FrontendFS: stubFrontendFS,
	}
	ts := httptest.NewServer(handlers.NewRouter(srv))
	defer ts.Close()

	// Seed page in default
	store.WritePage("p", models.Page{
		PageName: "P",
		Groups:   []models.Group{{Title: "G0", Items: []models.Item{}}},
	}, "default")

	// 1. Invalid location -> 400
	code, _ := post(t, ts, "/api/v1/pages/p/groups?location=invalid-loc", models.Group{Title: "G"})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for addGroup invalid location, got %d", code)
	}
	code, _ = put(t, ts, "/api/v1/pages/p/groups/0?location=invalid-loc", models.Group{Title: "G"})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for updateGroup invalid location, got %d", code)
	}
	code = del(t, ts, "/api/v1/pages/p/groups/0?location=invalid-loc")
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for deleteGroup invalid location, got %d", code)
	}

	// 2. Read-only docs workspace -> 403
	code, _ = post(t, ts, "/api/v1/pages/pdocs/groups?location=docs", models.Group{Title: "G"})
	if code != http.StatusForbidden {
		t.Errorf("expected 403 for addGroup on docs, got %d", code)
	}
	code, _ = put(t, ts, "/api/v1/pages/pdocs/groups/0?location=docs", models.Group{Title: "G"})
	if code != http.StatusForbidden {
		t.Errorf("expected 403 for updateGroup on docs, got %d", code)
	}
	code = del(t, ts, "/api/v1/pages/pdocs/groups/0?location=docs")
	if code != http.StatusForbidden {
		t.Errorf("expected 403 for deleteGroup on docs, got %d", code)
	}
	code, _ = post(t, ts, "/api/v1/pages/pdocs/groups/0/move?location=docs", models.MoveGroupRequest{TargetSlug: "p"})
	if code != http.StatusForbidden {
		t.Errorf("expected 403 for moveGroup on docs, got %d", code)
	}

	// 3. Non-integer groupIndex -> 422
	code, _ = put(t, ts, "/api/v1/pages/p/groups/not-an-int?location=default", models.Group{Title: "G"})
	if code != 422 {
		t.Errorf("expected 422 for non-int groupIndex on update, got %d", code)
	}
	code = del(t, ts, "/api/v1/pages/p/groups/not-an-int?location=default")
	if code != 422 {
		t.Errorf("expected 422 for non-int groupIndex on delete, got %d", code)
	}
	code, _ = post(t, ts, "/api/v1/pages/p/groups/not-an-int/move?location=default", models.MoveGroupRequest{TargetSlug: "p"})
	if code != 422 {
		t.Errorf("expected 422 for non-int groupIndex on move, got %d", code)
	}

	// 4. Locked vault with sensitive items -> 423
	post(t, ts, "/api/v1/workspaces/default/vault/setup", map[string]string{"password": "MasterPassword123!"})
	post(t, ts, "/api/v1/workspaces/default/vault/lock", nil)
	pw := "secret"
	sensGroup := models.Group{
		Title: "Sens",
		Items: []models.Item{{Title: "Item", Password: &pw}},
	}
	code, _ = post(t, ts, "/api/v1/pages/p/groups?location=default", sensGroup)
	if code != http.StatusLocked {
		t.Errorf("expected 423 for addGroup with sensitive item when locked, got %d", code)
	}
	code, _ = put(t, ts, "/api/v1/pages/p/groups/0?location=default", sensGroup)
	if code != http.StatusLocked {
		t.Errorf("expected 423 for updateGroup with sensitive item when locked, got %d", code)
	}
}
