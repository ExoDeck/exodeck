package handlers_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/ExoDeck/exodeck/internal/models"
)

const sampleBpmnXML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1">
  <bpmn:process id="Process_1" name="Order Processing" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1"/>
  </bpmn:process>
</bpmn:definitions>`

const bpmnContent = `{"page-name":"Order Processing","bpmn_xml":"` + `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<bpmn:definitions xmlns:bpmn=\"http://www.omg.org/spec/BPMN/20100524/MODEL\" id=\"Definitions_1\"><bpmn:process id=\"Process_1\" name=\"Order Processing\" isExecutable=\"false\"><bpmn:startEvent id=\"StartEvent_1\"/></bpmn:process></bpmn:definitions>` + `"}`
const bpmnContentRenamed = `{"page-name":"Renamed Process","bpmn_xml":"` + `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<bpmn:definitions xmlns:bpmn=\"http://www.omg.org/spec/BPMN/20100524/MODEL\" id=\"Definitions_1\"><bpmn:process id=\"Process_1\" name=\"Renamed Process\" isExecutable=\"false\"><bpmn:startEvent id=\"StartEvent_1\"/></bpmn:process></bpmn:definitions>` + `"}`

// --------------------------------------------------------------------------
// Business Process (BPMN) page CRUD
// --------------------------------------------------------------------------

func TestCreateBpmn(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/bpmn", byteReader(bpmnContent))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST bpmn: %d", resp.StatusCode)
	}

	content, err := os.ReadFile(filepath.Join(dataDir, "Order Processing.bpmn"))
	if err != nil {
		t.Fatal(".bpmn file not created:", err)
	}
	if !bytes.Contains(content, []byte("<bpmn:definitions")) {
		t.Errorf("expected XML in .bpmn file, got: %s", string(content))
	}
}

func TestGetBpmn(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "Order Processing.bpmn"), []byte(sampleBpmnXML), 0o644)
	store.InitCache()

	resp, err := http.Get(ts.URL + "/api/v1/bpmn/order-processing")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET bpmn: %d", resp.StatusCode)
	}
	var data map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		t.Fatal(err)
	}
	if data["page-name"] != "Order Processing" {
		t.Errorf("expected page-name 'Order Processing', got %q", data["page-name"])
	}
	if data["bpmn_xml"] != sampleBpmnXML {
		t.Errorf("xml mismatch")
	}
}

func TestGetBpmnNotFound(t *testing.T) {
	ts, store, _ := newTestServer(t)
	_ = store

	resp, err := http.Get(ts.URL + "/api/v1/bpmn/nonexistent")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("GET nonexistent bpmn: %d, want 404", resp.StatusCode)
	}
}

func TestUpdateBpmn(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "Order Processing.bpmn"), []byte(sampleBpmnXML), 0o644)
	store.InitCache()

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/bpmn/order-processing", byteReader(bpmnContent))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT bpmn: %d", resp.StatusCode)
	}
}

func TestUpdateBpmnRename(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "Order Processing.bpmn"), []byte(sampleBpmnXML), 0o644)
	store.InitCache()

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/bpmn/order-processing", byteReader(bpmnContentRenamed))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT rename bpmn: %d", resp.StatusCode)
	}

	if _, err := os.Stat(filepath.Join(dataDir, "Order Processing.bpmn")); !os.IsNotExist(err) {
		t.Error("old .bpmn file should be gone")
	}
	if _, err := os.Stat(filepath.Join(dataDir, "Renamed Process.bpmn")); err != nil {
		t.Error("new .bpmn file should exist:", err)
	}
}

func TestUpdateBpmnRenameUpdatesInternalLinks(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "Order Processing.bpmn"), []byte(sampleBpmnXML), 0o644)
	_ = os.WriteFile(filepath.Join(dataDir, "Note Links.md"), []byte("# Note Links\n\n[Flow](/order-processing)"), 0o644)

	url := "/order-processing"
	gridPage := models.Page{
		PageName: "Grid Links",
		Groups: []models.Group{
			{Title: "Links", Items: []models.Item{{Title: "Flow", URL: &url}}},
		},
	}
	store.WritePage("grid-links", gridPage, "default")
	store.InitCache()

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/bpmn/order-processing", byteReader(bpmnContentRenamed))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT rename bpmn: %d", resp.StatusCode)
	}

	noteContent, _ := os.ReadFile(filepath.Join(dataDir, "Note Links.md"))
	if !bytes.Contains(noteContent, []byte("](/renamed-process)")) {
		t.Errorf("note link was not updated: %s", noteContent)
	}

	gridJSON, _ := os.ReadFile(filepath.Join(dataDir, "grid-links.grid"))
	if !bytes.Contains(gridJSON, []byte("/renamed-process")) {
		t.Errorf("grid link was not updated: %s", gridJSON)
	}
}

func TestDeleteBpmn(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "to-delete.bpmn"), []byte(sampleBpmnXML), 0o644)
	store.InitCache()

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/v1/bpmn/order-processing", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE bpmn: %d", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "to-delete.bpmn")); !os.IsNotExist(err) {
		t.Error("file should be deleted")
	}
}

func TestDeleteBpmnNotFound(t *testing.T) {
	ts, store, _ := newTestServer(t)
	_ = store

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/v1/bpmn/nonexistent", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("DELETE nonexistent bpmn: %d, want 404", resp.StatusCode)
	}
}

func TestCreateDuplicateBpmnReturns409(t *testing.T) {
	ts, store, _ := newTestServer(t)
	_ = store

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/bpmn", byteReader(bpmnContent))
	req.Header.Set("Content-Type", "application/json")
	resp1, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp1.Body.Close()
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("first POST bpmn: %d", resp1.StatusCode)
	}

	req2, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/bpmn", byteReader(bpmnContent))
	req2.Header.Set("Content-Type", "application/json")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp2.Body.Close()
	if resp2.StatusCode != http.StatusConflict {
		t.Errorf("duplicate POST bpmn: got %d, want 409", resp2.StatusCode)
	}
}

func TestListPagesIncludesBpmn(t *testing.T) {
	ts, store, dataDir := newTestServer(t)
	_ = store

	_ = os.WriteFile(filepath.Join(dataDir, "Order Processing.bpmn"), []byte(sampleBpmnXML), 0o644)
	store.InitCache()

	resp, err := http.Get(ts.URL + "/api/v1/pages")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	var pages []models.PageMeta
	_ = json.NewDecoder(resp.Body).Decode(&pages)

	found := false
	for _, p := range pages {
		if p.Slug == "order-processing" && p.PageType == "bpmn" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("BPMN page not listed in /pages: %+v", pages)
	}
}

func TestCreateBpmnInvalidJSON(t *testing.T) {
	ts, store, _ := newTestServer(t)
	_ = store

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/bpmn", byteReader("not json"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("POST invalid JSON: got %d, want 400", resp.StatusCode)
	}
}

// --------------------------------------------------------------------------
// Move BPMN to another location
// --------------------------------------------------------------------------

func TestMoveBpmnToLocation(t *testing.T) {
	ts, store, defaultDir, workDir := newTestServerMultiLocation(t)
	_ = store

	_ = os.WriteFile(filepath.Join(defaultDir, "Order Processing.bpmn"), []byte(sampleBpmnXML), 0o644)
	store.InitCache()

	code, _ := post(t, ts, "/api/v1/bpmn/order-processing/move-to?location=default", map[string]string{"target_location": "work"})
	if code != http.StatusNoContent {
		t.Fatalf("move bpmn: %d", code)
	}

	resp, _ := http.Get(ts.URL + "/api/v1/bpmn/order-processing?location=default")
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("bpmn should be removed from source, got %d", resp.StatusCode)
	}

	resp2, _ := http.Get(ts.URL + "/api/v1/bpmn/order-processing?location=work")
	if resp2.StatusCode != http.StatusOK {
		t.Errorf("bpmn should exist in target, got %d", resp2.StatusCode)
	}

	if _, err := os.Stat(filepath.Join(workDir, "Order Processing.bpmn")); err != nil {
		t.Errorf("file should exist in target directory: %v", err)
	}
	if _, err := os.Stat(filepath.Join(defaultDir, "Order Processing.bpmn")); !os.IsNotExist(err) {
		t.Error("file should not exist in source directory")
	}
}

func TestMoveBpmnToLocationConflictReturns409(t *testing.T) {
	ts, store, defaultDir, workDir := newTestServerMultiLocation(t)
	_ = store

	_ = os.WriteFile(filepath.Join(defaultDir, "Order Processing.bpmn"), []byte(sampleBpmnXML), 0o644)
	_ = os.WriteFile(filepath.Join(workDir, "Order Processing.bpmn"), []byte(sampleBpmnXML), 0o644)
	store.InitCache()

	code, _ := post(t, ts, "/api/v1/bpmn/order-processing/move-to?location=default", map[string]string{"target_location": "work"})
	if code != http.StatusConflict {
		t.Fatalf("expected 409 on conflict, got %d", code)
	}
}

func TestBpmnReadOnlyDocs(t *testing.T) {
	ts, store, _ := newTestServer(t)
	_ = store

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/bpmn?location=docs", byteReader(bpmnContent))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("POST bpmn in docs should be 403, got %d", resp.StatusCode)
	}
}

func TestBpmnErrorCases(t *testing.T) {
	ts, _, _ := newTestServer(t)

	// 1. Move bpmn empty target_location -> 400
	code, _ := post(t, ts, "/api/v1/bpmn/my-bpmn/move-to", map[string]string{})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for empty target_location, got %d", code)
	}

	// 2. Move nonexistent bpmn -> 404
	code, _ = post(t, ts, "/api/v1/bpmn/nonexistent/move-to", map[string]string{"target_location": "work"})
	if code != http.StatusNotFound {
		t.Errorf("expected 404 for moving nonexistent bpmn, got %d", code)
	}

	// 3. Update nonexistent bpmn -> 404
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/bpmn/nonexistent", byteReader(bpmnContent))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for updating nonexistent bpmn, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 4. Delete nonexistent bpmn -> 404
	req, _ = http.NewRequest(http.MethodDelete, ts.URL+"/api/v1/bpmn/nonexistent", nil)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for deleting nonexistent bpmn, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 5. Get nonexistent bpmn -> 404
	resp, _ = http.Get(ts.URL + "/api/v1/bpmn/nonexistent")
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for getting nonexistent bpmn, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
}
