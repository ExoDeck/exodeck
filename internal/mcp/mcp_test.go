package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/ExoDeck/exodeck/internal/config"
	"github.com/ExoDeck/exodeck/internal/models"
	"github.com/ExoDeck/exodeck/internal/storage"
)

type mockGitRunner struct {
	toplevel string
	status   string
	failCmd  string
}

func (m *mockGitRunner) Run(_ context.Context, cwd string, args ...string) (int, string, string) {
	if len(args) > 0 && args[0] == m.failCmd {
		return 1, "", "simulated git failure"
	}
	if len(args) >= 2 && args[0] == "rev-parse" && args[1] == "--show-toplevel" {
		if m.toplevel != "" {
			return 0, m.toplevel + "\n", ""
		}
		return 0, cwd + "\n", ""
	}
	if len(args) >= 1 && args[0] == "status" {
		return 0, m.status, ""
	}
	return 0, "ok\n", ""
}

func newTestServer(t *testing.T) (*Server, string, string) {
	t.Helper()
	configDir := t.TempDir()
	mainWSPath := filepath.Join(configDir, "data")
	hiddenWSPath := filepath.Join(configDir, "secret")
	if err := os.MkdirAll(mainWSPath, 0o755); err != nil {
		t.Fatalf("mkdir main: %v", err)
	}
	if err := os.MkdirAll(hiddenWSPath, 0o755); err != nil {
		t.Fatalf("mkdir hidden: %v", err)
	}

	cfg := config.Defaults()
	cfg.EnableGitSync = true
	cfg.Workspaces = []interface{}{
		map[string]interface{}{
			"name":   "Main",
			"path":   mainWSPath,
			"hidden": false,
		},
		map[string]interface{}{
			"name":   "SecretWS",
			"path":   hiddenWSPath,
			"hidden": true,
		},
	}
	if err := config.Save(configDir, cfg); err != nil {
		t.Fatalf("saving config: %v", err)
	}

	locs, order, err := storage.ParseWorkspaces(cfg.Workspaces, mainWSPath, configDir)
	if err != nil {
		t.Fatalf("parsing workspaces: %v", err)
	}

	docsFS := fstest.MapFS{
		"docs/About.md": &fstest.MapFile{Data: []byte("# About\n\nWelcome to ExoDeck.")},
	}
	store := storage.New(docsFS, configDir)
	store.SetWorkspaces(locs, order)

	gitRunner := &mockGitRunner{status: " M test.grid\n"}
	srv := NewServer(store, configDir, gitRunner, "1.2.3-test")
	return srv, mainWSPath, hiddenWSPath
}

func callToolHelper(t *testing.T, srv *Server, name string, args map[string]interface{}) (string, bool) {
	t.Helper()
	argBytes, err := json.Marshal(args)
	if err != nil {
		t.Fatalf("marshal args: %v", err)
	}
	paramsBytes, _ := json.Marshal(CallToolParams{
		Name:      name,
		Arguments: argBytes,
	})
	resp := srv.HandleRequest(context.Background(), Request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`1`),
		Method:  "tools/call",
		Params:  paramsBytes,
	})
	if resp == nil {
		t.Fatalf("expected non-nil response for tools/call %s", name)
	}
	if resp.Error != nil {
		t.Fatalf("unexpected protocol error for %s: %+v", name, resp.Error)
	}
	res, ok := resp.Result.(CallToolResult)
	if !ok {
		t.Fatalf("expected CallToolResult, got %T", resp.Result)
	}
	if len(res.Content) == 0 {
		t.Fatalf("expected non-empty content for %s", name)
	}
	return res.Content[0].Text, res.IsError
}

func TestProtocolLifecycleAndMethods(t *testing.T) {
	srv, _, _ := newTestServer(t)

	// 1. Initialize with 2025-03-26
	initResp := srv.HandleRequest(context.Background(), Request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`"init-1"`),
		Method:  "initialize",
		Params:  json.RawMessage(`{"protocolVersion":"2025-03-26"}`),
	})
	if initResp == nil || initResp.Error != nil {
		t.Fatalf("initialize failed: %+v", initResp)
	}
	initMap := initResp.Result.(map[string]interface{})
	if initMap["protocolVersion"] != LatestProtocolVersion {
		t.Errorf("expected protocolVersion %s, got %v", LatestProtocolVersion, initMap["protocolVersion"])
	}

	// 2. Notification returns nil
	notifResp := srv.HandleRequest(context.Background(), Request{
		JSONRPC: "2.0",
		Method:  "notifications/initialized",
	})
	if notifResp != nil {
		t.Errorf("expected nil response for notification, got %+v", notifResp)
	}

	// 3. Ping
	pingResp := srv.HandleRequest(context.Background(), Request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`2`),
		Method:  "ping",
	})
	if pingResp == nil || pingResp.Error != nil {
		t.Fatalf("ping failed: %+v", pingResp)
	}

	// 4. Tools list
	toolsResp := srv.HandleRequest(context.Background(), Request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`3`),
		Method:  "tools/list",
	})
	if toolsResp == nil || toolsResp.Error != nil {
		t.Fatalf("tools/list failed: %+v", toolsResp)
	}
	toolsMap := toolsResp.Result.(map[string]interface{})
	toolsSlice := toolsMap["tools"].([]Tool)
	if len(toolsSlice) != 38 {
		t.Errorf("expected 38 tools registered, got %d", len(toolsSlice))
	}

	// 5. Resources & Prompts list
	resList := srv.HandleRequest(context.Background(), Request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`4`),
		Method:  "resources/list",
	})
	if resList == nil || resList.Error != nil {
		t.Errorf("resources/list failed: %+v", resList)
	}
	promptList := srv.HandleRequest(context.Background(), Request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`5`),
		Method:  "prompts/list",
	})
	if promptList == nil || promptList.Error != nil {
		t.Errorf("prompts/list failed: %+v", promptList)
	}

	// 6. Unknown method & invalid jsonrpc version
	unknownResp := srv.HandleRequest(context.Background(), Request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`6`),
		Method:  "nonexistent/method",
	})
	if unknownResp == nil || unknownResp.Error == nil || unknownResp.Error.Code != ErrCodeMethodNotFound {
		t.Errorf("expected MethodNotFound error, got %+v", unknownResp)
	}

	badVerResp := srv.HandleRequest(context.Background(), Request{
		JSONRPC: "1.0",
		ID:      json.RawMessage(`7`),
		Method:  "ping",
	})
	if badVerResp == nil || badVerResp.Error == nil || badVerResp.Error.Code != ErrCodeInvalidRequest {
		t.Errorf("expected InvalidRequest error, got %+v", badVerResp)
	}
}

func TestTransportsHTTPAndStdio(t *testing.T) {
	srv, _, _ := newTestServer(t)

	// HTTP OPTIONS
	reqOpt := httptest.NewRequest(http.MethodOptions, "/mcp", nil)
	wOpt := httptest.NewRecorder()
	srv.ServeHTTP(wOpt, reqOpt)
	if wOpt.Code != http.StatusNoContent {
		t.Errorf("expected 204 for OPTIONS, got %d", wOpt.Code)
	}

	// HTTP GET status
	reqGet := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	wGet := httptest.NewRecorder()
	srv.ServeHTTP(wGet, reqGet)
	if wGet.Code != http.StatusOK {
		t.Errorf("expected 200 for GET /mcp, got %d", wGet.Code)
	}

	// HTTP POST single request
	reqPost := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	wPost := httptest.NewRecorder()
	srv.ServeHTTP(wPost, reqPost)
	if wPost.Code != http.StatusOK {
		t.Errorf("expected 200 for POST /mcp, got %d", wPost.Code)
	}

	// HTTP POST notification -> 202 Accepted
	reqNotif := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	wNotif := httptest.NewRecorder()
	srv.ServeHTTP(wNotif, reqNotif)
	if wNotif.Code != http.StatusAccepted {
		t.Errorf("expected 202 for notification POST /mcp, got %d", wNotif.Code)
	}

	// HTTP POST batch
	reqBatch := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"}]`))
	wBatch := httptest.NewRecorder()
	srv.ServeHTTP(wBatch, reqBatch)
	if wBatch.Code != http.StatusOK {
		t.Errorf("expected 200 for batch POST, got %d", wBatch.Code)
	}

	// HTTP SSE stream + session message forwarding + DELETE session
	ctxSSE, cancelSSE := context.WithCancel(context.Background())
	reqSSE := httptest.NewRequest(http.MethodGet, "/mcp/sse", nil).WithContext(ctxSSE)
	wSSE := httptest.NewRecorder()
	doneSSE := make(chan struct{})
	go func() {
		srv.ServeHTTP(wSSE, reqSSE)
		close(doneSSE)
	}()
	time.Sleep(30 * time.Millisecond)
	cancelSSE()
	<-doneSSE
	sseOut := wSSE.Body.String()
	if !strings.Contains(sseOut, "event: endpoint") {
		t.Errorf("expected SSE endpoint event, got %q", sseOut)
	}

	reqDel := httptest.NewRequest(http.MethodDelete, "/mcp?sessionId=test", nil)
	wDel := httptest.NewRecorder()
	srv.ServeHTTP(wDel, reqDel)
	if wDel.Code != http.StatusOK {
		t.Errorf("expected 200 for DELETE /mcp, got %d", wDel.Code)
	}

	// Stdio transport
	stdioIn := strings.NewReader(
		"{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"ping\"}\n" +
			"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n" +
			"[{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"ping\"}]\n",
	)
	var stdioOut bytes.Buffer
	if err := srv.ServeStdio(context.Background(), stdioIn, &stdioOut); err != nil {
		t.Fatalf("ServeStdio error: %v", err)
	}
	scanner := bufio.NewScanner(&stdioOut)
	lines := 0
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) != "" {
			lines++
		}
	}
	if lines != 2 {
		t.Errorf("expected 2 response lines on stdout, got %d", lines)
	}
}

func TestWorkspacesAndConfigTools(t *testing.T) {
	srv, _, _ := newTestServer(t)

	// 1. list_workspaces (default excludes hidden)
	text, isErr := callToolHelper(t, srv, "list_workspaces", map[string]interface{}{})
	if isErr {
		t.Fatalf("list_workspaces failed: %s", text)
	}
	var wsList []WorkspaceSummary
	_ = json.Unmarshal([]byte(text), &wsList)
	if len(wsList) != 1 || wsList[0].Name != "Main" {
		t.Errorf("expected only visible workspace 'Main', got %+v", wsList)
	}

	// 2. list_workspaces with include_hidden=true
	textAll, isErr := callToolHelper(t, srv, "list_workspaces", map[string]interface{}{"include_hidden": true})
	if isErr {
		t.Fatalf("list_workspaces(include_hidden) failed: %s", textAll)
	}
	_ = json.Unmarshal([]byte(textAll), &wsList)
	if len(wsList) != 2 {
		t.Errorf("expected 2 workspaces with include_hidden=true, got %d", len(wsList))
	}

	// 3. create_workspace
	_, isErr = callToolHelper(t, srv, "create_workspace", map[string]interface{}{
		"name":   "Projects",
		"path":   "projects_data",
		"hidden": false,
	})
	if isErr {
		t.Fatalf("create_workspace failed")
	}

	// 4. update_workspace
	_, isErr = callToolHelper(t, srv, "update_workspace", map[string]interface{}{
		"name":     "Projects",
		"new_name": "WorkProjects",
		"hidden":   true,
	})
	if isErr {
		t.Fatalf("update_workspace failed")
	}

	// 5. delete_workspace
	_, isErr = callToolHelper(t, srv, "delete_workspace", map[string]interface{}{
		"name": "WorkProjects",
	})
	if isErr {
		t.Fatalf("delete_workspace failed")
	}

	// 6. get_config & update_config
	cfgText, isErr := callToolHelper(t, srv, "get_config", map[string]interface{}{})
	if isErr || !strings.Contains(cfgText, `"theme": "dark"`) {
		t.Fatalf("get_config unexpected output: %s", cfgText)
	}

	updCfgText, isErr := callToolHelper(t, srv, "update_config", map[string]interface{}{
		"theme":              "light",
		"groupbox_max_width": 500,
	})
	if isErr || !strings.Contains(updCfgText, `"theme": "light"`) {
		t.Fatalf("update_config unexpected output: %s", updCfgText)
	}
}

func TestGridPagesGroupsItemsAndSecurity(t *testing.T) {
	srv, _, _ := newTestServer(t)

	// 1. create_grid_page
	createText, isErr := callToolHelper(t, srv, "create_grid_page", map[string]interface{}{
		"page_name": "Engineering",
		"workspace": "Main",
		"groups": []map[string]interface{}{
			{
				"title": "Dev Links",
				"items": []map[string]interface{}{
					{
						"title": "ExoDeck Repo",
						"url":   "https://github.com/ExoDeck/exodeck",
						"notes": "Main repository",
					},
					{
						"title":    "Quick Note",
						"markdown": "## Architecture\nAll local-first.",
					},
					{
						"title":         "Ship MCP Server",
						"markdown":      "Implement all tools",
						"task_checked":  false,
						"task_due_date": "2026-11-11",
					},
				},
			},
		},
	})
	if isErr {
		t.Fatalf("create_grid_page failed: %s", createText)
	}

	// 2. get_grid_page -> verify markdown is decoded to plain text
	getText, isErr := callToolHelper(t, srv, "get_grid_page", map[string]interface{}{
		"slug":      "engineering",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("get_grid_page failed: %s", getText)
	}
	if !strings.Contains(getText, "## Architecture") {
		t.Errorf("expected decoded markdown in get_grid_page response, got: %s", getText)
	}

	// 3. add_group & update_group
	_, isErr = callToolHelper(t, srv, "add_group", map[string]interface{}{
		"slug":      "engineering",
		"workspace": "Main",
		"title":     "Backlog",
	})
	if isErr {
		t.Fatalf("add_group failed")
	}

	_, isErr = callToolHelper(t, srv, "update_group", map[string]interface{}{
		"slug":        "engineering",
		"workspace":   "Main",
		"group_index": 1,
		"title":       "Sprint Backlog",
	})
	if isErr {
		t.Fatalf("update_group failed")
	}

	// 4. add_item by group_title (creates group if missing or appends to existing)
	_, isErr = callToolHelper(t, srv, "add_item", map[string]interface{}{
		"slug":        "engineering",
		"workspace":   "Main",
		"group_title": "Sprint Backlog",
		"title":       "Write unit tests",
		"task_checked": false,
	})
	if isErr {
		t.Fatalf("add_item failed")
	}

	// 5. update_item (toggle task_checked)
	updItemText, isErr := callToolHelper(t, srv, "update_item", map[string]interface{}{
		"slug":         "engineering",
		"workspace":    "Main",
		"group_index":  1,
		"item_index":   0,
		"task_checked": true,
	})
	if isErr || !strings.Contains(updItemText, `"task_checked": true`) {
		t.Fatalf("update_item failed: %s", updItemText)
	}

	// 6. move_item & delete_item & delete_group
	_, isErr = callToolHelper(t, srv, "move_item", map[string]interface{}{
		"slug":               "engineering",
		"workspace":          "Main",
		"group_index":        0,
		"item_index":         0,
		"target_group_index": 1,
	})
	if isErr {
		t.Fatalf("move_item failed")
	}

	_, isErr = callToolHelper(t, srv, "delete_item", map[string]interface{}{
		"slug":        "engineering",
		"workspace":   "Main",
		"group_index": 1,
		"item_index":  1,
	})
	if isErr {
		t.Fatalf("delete_item failed")
	}

	_, isErr = callToolHelper(t, srv, "delete_group", map[string]interface{}{
		"slug":        "engineering",
		"workspace":   "Main",
		"group_index": 1,
	})
	if isErr {
		t.Fatalf("delete_group failed")
	}

	// 7. Security guardrails: reject creating password / encrypted items via MCP
	errText, isErr := callToolHelper(t, srv, "add_item", map[string]interface{}{
		"slug":        "engineering",
		"workspace":   "Main",
		"group_index": 0,
		"title":       "Root Password",
		"password":    "super-secret",
	})
	if !isErr {
		t.Fatalf("expected add_item with password to be rejected, got: %s", errText)
	}

	// 8. Security guardrails: verify existing encrypted items on disk are masked on read and protected from overwrite/delete
	pageOnDisk, _, _ := srv.Store.ReadPage("engineering", "Main")
	secretVal := "v1:encrypted-ciphertext"
	userVal := "admin"
	pageOnDisk.Groups[0].Items = append(pageOnDisk.Groups[0].Items, models.Item{
		Title:    "Prod DB",
		Username: &userVal,
		Password: &secretVal,
	})
	srv.Store.WritePage("engineering", pageOnDisk, "Main")

	maskedRead, isErr := callToolHelper(t, srv, "get_grid_page", map[string]interface{}{
		"slug":      "engineering",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("get_grid_page failed: %s", maskedRead)
	}
	if strings.Contains(maskedRead, "encrypted-ciphertext") || strings.Contains(maskedRead, "admin") {
		t.Fatalf("expected sensitive fields to be stripped from get_grid_page, got: %s", maskedRead)
	}
	if !strings.Contains(maskedRead, `"locked": true`) {
		t.Errorf("expected locked: true on sensitive item, got: %s", maskedRead)
	}

	// Attempting to update or delete the encrypted item via MCP must be rejected
	_, isErr = callToolHelper(t, srv, "delete_item", map[string]interface{}{
		"slug":        "engineering",
		"workspace":   "Main",
		"group_index": 0,
		"item_index":  len(pageOnDisk.Groups[0].Items) - 1,
	})
	if !isErr {
		t.Errorf("expected deleting encrypted item via MCP to be rejected")
	}
}

func TestNotesWhiteboardsBpmnSearchTasksAndSync(t *testing.T) {
	srv, mainWSPath, _ := newTestServer(t)

	// 1. Notes CRUD + media
	noteRes, isErr := callToolHelper(t, srv, "create_note", map[string]interface{}{
		"title":     "Meeting Notes",
		"content":   "Discussed MCP server architecture.",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("create_note failed: %s", noteRes)
	}

	getNoteRes, isErr := callToolHelper(t, srv, "get_note", map[string]interface{}{
		"slug":      "meeting-notes",
		"workspace": "Main",
	})
	if isErr || !strings.Contains(getNoteRes, "# Meeting Notes") {
		t.Fatalf("get_note failed: %s", getNoteRes)
	}

	_, isErr = callToolHelper(t, srv, "update_note", map[string]interface{}{
		"slug":      "meeting-notes",
		"content":   "Action item: ship v1.",
		"append":    true,
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("update_note append failed")
	}

	// Create dummy media file for meeting-notes
	mediaDir := filepath.Join(mainWSPath, "meeting-notes")
	_ = os.MkdirAll(mediaDir, 0o755)
	_ = os.WriteFile(filepath.Join(mediaDir, "diagram.png"), []byte("pngdata"), 0o644)

	mediaList, isErr := callToolHelper(t, srv, "list_media", map[string]interface{}{
		"slug":      "meeting-notes",
		"workspace": "Main",
	})
	if isErr || !strings.Contains(mediaList, "diagram.png") {
		t.Fatalf("list_media failed: %s", mediaList)
	}

	_, isErr = callToolHelper(t, srv, "delete_media", map[string]interface{}{
		"slug":      "meeting-notes",
		"filename":  "diagram.png",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("delete_media failed")
	}

	// 2. Whiteboards CRUD
	_, isErr = callToolHelper(t, srv, "create_whiteboard", map[string]interface{}{
		"page_name": "System Sketch",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("create_whiteboard failed")
	}

	wbText, isErr := callToolHelper(t, srv, "get_whiteboard", map[string]interface{}{
		"slug":      "system-sketch",
		"workspace": "Main",
	})
	if isErr || !strings.Contains(wbText, "System Sketch") {
		t.Fatalf("get_whiteboard failed: %s", wbText)
	}

	_, isErr = callToolHelper(t, srv, "update_whiteboard", map[string]interface{}{
		"slug":      "system-sketch",
		"page_name": "System Sketch v2",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("update_whiteboard failed")
	}

	// 3. BPMN CRUD
	_, isErr = callToolHelper(t, srv, "create_bpmn", map[string]interface{}{
		"page_name": "Order Flow",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("create_bpmn failed")
	}

	bpmnText, isErr := callToolHelper(t, srv, "get_bpmn", map[string]interface{}{
		"slug":      "order-flow",
		"workspace": "Main",
	})
	if isErr || !strings.Contains(bpmnText, "Order Flow") {
		t.Fatalf("get_bpmn failed: %s", bpmnText)
	}

	_, isErr = callToolHelper(t, srv, "update_bpmn", map[string]interface{}{
		"slug":      "order-flow",
		"page_name": "Order Flow v2",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("update_bpmn failed")
	}

	// 4. Hidden workspace & page filtering in list_pages, search, list_tasks
	_, isErr = callToolHelper(t, srv, "create_grid_page", map[string]interface{}{
		"page_name": "Secret Roadmap",
		"workspace": "SecretWS",
		"groups": []map[string]interface{}{
			{
				"title": "Confidential Tasks",
				"items": []map[string]interface{}{
					{
						"title":         "Hidden Task",
						"task_checked":  false,
						"task_due_date": "2020-01-01",
					},
				},
			},
		},
	})
	if isErr {
		t.Fatalf("create_grid_page in SecretWS failed")
	}

	pagesVisible, _ := callToolHelper(t, srv, "list_pages", map[string]interface{}{})
	if strings.Contains(pagesVisible, "secret-roadmap") {
		t.Errorf("expected secret-roadmap to be excluded when include_hidden=false")
	}

	pagesAll, _ := callToolHelper(t, srv, "list_pages", map[string]interface{}{"include_hidden": true})
	if !strings.Contains(pagesAll, "secret-roadmap") {
		t.Errorf("expected secret-roadmap to be included when include_hidden=true")
	}

	searchVis, _ := callToolHelper(t, srv, "search", map[string]interface{}{"query": "Hidden Task"})
	if strings.Contains(searchVis, "Hidden Task") {
		t.Errorf("expected Hidden Task to be excluded from search when include_hidden=false")
	}

	searchAll, _ := callToolHelper(t, srv, "search", map[string]interface{}{"query": "Hidden Task", "include_hidden": true})
	if !strings.Contains(searchAll, "Hidden Task") {
		t.Errorf("expected Hidden Task in search when include_hidden=true")
	}

	tasksVis, _ := callToolHelper(t, srv, "list_tasks", map[string]interface{}{"filter": "due"})
	if strings.Contains(tasksVis, "Hidden Task") {
		t.Errorf("expected Hidden Task excluded from list_tasks when include_hidden=false")
	}

	tasksAll, _ := callToolHelper(t, srv, "list_tasks", map[string]interface{}{"filter": "due", "include_hidden": true})
	if !strings.Contains(tasksAll, "Hidden Task") {
		t.Errorf("expected Hidden Task included in list_tasks when include_hidden=true")
	}

	// 5. move_page & deletions
	_, isErr = callToolHelper(t, srv, "move_page", map[string]interface{}{
		"slug":             "meeting-notes",
		"workspace":        "Main",
		"target_workspace": "SecretWS",
	})
	if isErr {
		t.Fatalf("move_page failed")
	}

	_, isErr = callToolHelper(t, srv, "delete_note", map[string]interface{}{
		"slug":      "meeting-notes",
		"workspace": "SecretWS",
	})
	if isErr {
		t.Fatalf("delete_note failed")
	}

	_, isErr = callToolHelper(t, srv, "delete_whiteboard", map[string]interface{}{
		"slug":      "system-sketch-v2",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("delete_whiteboard failed")
	}

	_, isErr = callToolHelper(t, srv, "delete_bpmn", map[string]interface{}{
		"slug":      "order-flow-v2",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("delete_bpmn failed")
	}

	// 6. Git sync status & sync
	syncStText, isErr := callToolHelper(t, srv, "git_sync_status", map[string]interface{}{})
	if isErr || !strings.Contains(syncStText, `"uncommitted": true`) {
		t.Fatalf("git_sync_status failed: %s", syncStText)
	}

	syncRunText, isErr := callToolHelper(t, srv, "git_sync", map[string]interface{}{
		"workspace": "Main",
	})
	if isErr || !strings.Contains(syncRunText, `"status": "success"`) {
		t.Fatalf("git_sync failed: %s", syncRunText)
	}
}
