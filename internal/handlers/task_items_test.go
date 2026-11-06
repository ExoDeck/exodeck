package handlers_test

import (
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"github.com/ExoDeck/exodeck/internal/models"
)

// --------------------------------------------------------------------------
// Task items
// --------------------------------------------------------------------------

func TestCreateTaskItemReturns201(t *testing.T) {
	ts, store, _ := newTestServer(t)
	store.WritePage("p", models.Page{
		PageName: "P",
		Groups:   []models.Group{{Title: "G", Items: []models.Item{}}},
	}, "") //nolint:errcheck

	item := models.Item{
		Title:       "Finish implementation",
		TaskChecked: ptrB(false),
		TaskDueDate: ptrS("2026-12-31"),
		TaskCreated: ptrS("2026-01-01T00:00:00"),
	}
	code, body := post(t, ts, "/api/v1/pages/p/groups/0/items", item)
	if code != http.StatusCreated {
		t.Fatalf("POST task item: %d %v", code, body)
	}
}

func TestTaskItemPersistedWithCorrectFields(t *testing.T) {
	ts, store, _ := newTestServer(t)
	store.WritePage("p", models.Page{
		PageName: "P",
		Groups:   []models.Group{{Title: "G", Items: []models.Item{}}},
	}, "") //nolint:errcheck

	item := models.Item{
		Title:       "My Todo",
		TaskChecked: ptrB(false),
		TaskDueDate: ptrS("2026-06-15"),
	}
	post(t, ts, "/api/v1/pages/p/groups/0/items", item) //nolint:errcheck

	resp, err := http.Get(ts.URL + "/api/v1/pages/p")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var pageResp map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&pageResp)

	groups := pageResp["groups"].([]interface{})
	items := groups[0].(map[string]interface{})["items"].([]interface{})
	taskItem := items[0].(map[string]interface{})

	if taskItem["title"] != "My Todo" {
		t.Errorf("title = %v", taskItem["title"])
	}
	if taskItem["task_checked"] != false {
		t.Errorf("task_checked = %v", taskItem["task_checked"])
	}
	if taskItem["task_due_date"] != "2026-06-15" {
		t.Errorf("task_due_date = %v", taskItem["task_due_date"])
	}
}

func TestTaskNullFieldsAbsentFromDiskJSON(t *testing.T) {
	_, store, dataDir := newTestServer(t)
	store.WritePage("p", models.Page{
		PageName: "P",
		Groups:   []models.Group{{Title: "G", Items: []models.Item{}}},
	}, "") //nolint:errcheck

	item := models.Item{
		Title:       "Minimal Todo",
		TaskChecked: ptrB(false),
	}
	store.WritePage("p", models.Page{
		PageName: "P",
		Groups:   []models.Group{{Title: "G", Items: []models.Item{item}}},
	}, "") //nolint:errcheck

	raw, err := os.ReadFile(dataDir + "/p.grid")
	if err != nil {
		t.Fatal(err)
	}

	// url, password, task_due_date should not appear in JSON with omitempty
	for _, absent := range []string{`"url"`, `"password"`, `"task_due_date"`} {
		if containsPlaintext(raw, absent) {
			t.Errorf("JSON should not contain %q: %s", absent, raw)
		}
	}
}

func TestTaskCheckedToggle(t *testing.T) {
	ts, store, _ := newTestServer(t)
	store.WritePage("p", models.Page{
		PageName: "P",
		Groups:   []models.Group{{Title: "G", Items: []models.Item{{Title: "Task", TaskChecked: ptrB(false)}}}},
	}, "") //nolint:errcheck

	toggled := models.Item{Title: "Task", TaskChecked: ptrB(true)}
	code, _ := put(t, ts, "/api/v1/pages/p/groups/0/items/0", toggled)
	if code != http.StatusOK {
		t.Fatalf("PUT toggle: %d", code)
	}

	resp, err := http.Get(ts.URL + "/api/v1/pages/p")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var pageResp map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&pageResp)
	groups := pageResp["groups"].([]interface{})
	items := groups[0].(map[string]interface{})["items"].([]interface{})
	checked := items[0].(map[string]interface{})["task_checked"].(bool)
	if !checked {
		t.Error("task_checked should be true after toggle")
	}
}

func TestMixedItemTypesInGroup(t *testing.T) {
	ts, store, _ := newTestServer(t)
	store.WritePage("p", models.Page{
		PageName: "P",
		Groups: []models.Group{{Title: "G", Items: []models.Item{
			{Title: "Link", URL: ptrS("https://x.com")},
			{Title: "Task", TaskChecked: ptrB(false)},
			{Title: "Note", Text: ptrS("SGVsbG8=")},
		}}},
	}, "") //nolint:errcheck

	code, _ := get(t, ts, "/api/v1/pages/p")
	if code != http.StatusOK {
		t.Fatalf("GET page with mixed items: %d", code)
	}
}

func TestDeleteTaskItem(t *testing.T) {
	ts, store, _ := newTestServer(t)
	store.WritePage("p", models.Page{
		PageName: "P",
		Groups:   []models.Group{{Title: "G", Items: []models.Item{{Title: "Task", TaskChecked: ptrB(false)}}}},
	}, "") //nolint:errcheck

	code := del(t, ts, "/api/v1/pages/p/groups/0/items/0")
	if code != http.StatusNoContent {
		t.Fatalf("DELETE task item: %d", code)
	}
}
