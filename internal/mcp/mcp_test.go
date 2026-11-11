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
	toplevel  string
	status    string
	failCmd   string
	commitMsg string
}

func (m *mockGitRunner) Run(_ context.Context, cwd string, args ...string) (int, string, string) {
	if len(args) > 0 && args[0] == m.failCmd {
		if m.failCmd == "commit" && m.commitMsg != "" {
			return 1, m.commitMsg, ""
		}
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

func callToolInvalidJSON(t *testing.T, srv *Server, name string) {
	t.Helper()
	paramsBytes, err := json.Marshal(CallToolParams{
		Name:      name,
		Arguments: json.RawMessage(`"not-an-object"`),
	})
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	resp := srv.HandleRequest(context.Background(), Request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`1`),
		Method:  "tools/call",
		Params:  paramsBytes,
	})
	if resp == nil || resp.Error != nil {
		t.Fatalf("expected tool result error for %s, got %+v", name, resp)
	}
	res := resp.Result.(CallToolResult)
	if !res.IsError {
		t.Errorf("expected IsError=true on invalid JSON args for %s", name)
	}
}

func TestProtocolLifecycleAndMethods(t *testing.T) {
	srv, _, _ := newTestServer(t)

	// Default version fallback in NewServer
	srvDefaultVer := NewServer(srv.Store, srv.ConfigDir, nil, "")
	if srvDefaultVer.Version != "1.0.0" {
		t.Errorf("expected default version 1.0.0, got %s", srvDefaultVer.Version)
	}

	// objectSchema with nil map
	sNil := objectSchema(nil)
	if sNil["type"] != "object" {
		t.Errorf("expected object schema")
	}

	// 1. Initialize with 2025-03-26 and fallback version
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

	initFallback := srv.HandleRequest(context.Background(), Request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`"init-2"`),
		Method:  "initialize",
		Params:  json.RawMessage(`{"protocolVersion":"1999-01-01"}`),
	})
	if initFallback.Result.(map[string]interface{})["protocolVersion"] != DefaultProtocolVersion {
		t.Errorf("expected DefaultProtocolVersion fallback")
	}

	// 2. Notifications for all methods return nil
	for _, m := range []string{
		"notifications/initialized",
		"notifications/cancelled",
		"initialized",
		"initialize",
		"ping",
		"tools/list",
		"resources/list",
		"prompts/list",
		"tools/call",
		"unknown/method",
	} {
		if r := srv.HandleRequest(context.Background(), Request{JSONRPC: "2.0", Method: m}); r != nil {
			t.Errorf("expected nil response for notification %s, got %+v", m, r)
		}
	}
	if r := srv.HandleRequest(context.Background(), Request{JSONRPC: "1.0", Method: "ping"}); r != nil {
		t.Errorf("expected nil for notification with invalid jsonrpc")
	}

	// 3. Ping, Tools, Resources, Prompts
	pingResp := srv.HandleRequest(context.Background(), Request{JSONRPC: "2.0", ID: json.RawMessage(`2`), Method: "ping"})
	if pingResp == nil || pingResp.Error != nil {
		t.Fatalf("ping failed: %+v", pingResp)
	}

	toolsResp := srv.HandleRequest(context.Background(), Request{JSONRPC: "2.0", ID: json.RawMessage(`3`), Method: "tools/list"})
	toolsSlice := toolsResp.Result.(map[string]interface{})["tools"].([]Tool)
	if len(toolsSlice) != 38 {
		t.Errorf("expected 38 tools registered, got %d", len(toolsSlice))
	}

	resList := srv.HandleRequest(context.Background(), Request{JSONRPC: "2.0", ID: json.RawMessage(`4`), Method: "resources/list"})
	if resList == nil || resList.Error != nil {
		t.Errorf("resources/list failed: %+v", resList)
	}
	promptList := srv.HandleRequest(context.Background(), Request{JSONRPC: "2.0", ID: json.RawMessage(`5`), Method: "prompts/list"})
	if promptList == nil || promptList.Error != nil {
		t.Errorf("prompts/list failed: %+v", promptList)
	}

	// 4. Unknown method, invalid jsonrpc version, invalid tools/call params, unknown tool
	unknownResp := srv.HandleRequest(context.Background(), Request{JSONRPC: "2.0", ID: json.RawMessage(`6`), Method: "nonexistent/method"})
	if unknownResp == nil || unknownResp.Error == nil || unknownResp.Error.Code != ErrCodeMethodNotFound {
		t.Errorf("expected MethodNotFound error, got %+v", unknownResp)
	}

	badVerResp := srv.HandleRequest(context.Background(), Request{JSONRPC: "1.0", ID: json.RawMessage(`7`), Method: "ping"})
	if badVerResp == nil || badVerResp.Error == nil || badVerResp.Error.Code != ErrCodeInvalidRequest {
		t.Errorf("expected InvalidRequest error, got %+v", badVerResp)
	}

	badCallParams := srv.HandleRequest(context.Background(), Request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`8`),
		Method:  "tools/call",
		Params:  json.RawMessage(`{}`),
	})
	if badCallParams.Error == nil || badCallParams.Error.Code != ErrCodeInvalidParams {
		t.Errorf("expected InvalidParams error for empty tool name")
	}

	unknownToolResp := srv.HandleRequest(context.Background(), Request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`9`),
		Method:  "tools/call",
		Params:  json.RawMessage(`{"name":"no_such_tool"}`),
	})
	if unknownToolResp.Error == nil || unknownToolResp.Error.Code != ErrCodeInvalidParams {
		t.Errorf("expected InvalidParams error for unknown tool")
	}

	// Register a custom string-returning tool to test string switch branch and null arguments
	srv.registerTool("echo_str", "test string return", objectSchema(nil), func(_ context.Context, _ json.RawMessage) (interface{}, error) {
		return "hello-plain-string", nil
	})
	echoResp := srv.HandleRequest(context.Background(), Request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`10`),
		Method:  "tools/call",
		Params:  json.RawMessage(`{"name":"echo_str","arguments":null}`),
	})
	if echoResp.Result.(CallToolResult).Content[0].Text != "hello-plain-string" {
		t.Errorf("unexpected echo_str result")
	}
}

type nonFlusherWriter struct {
	header http.Header
	code   int
	body   bytes.Buffer
}

func (n *nonFlusherWriter) Header() http.Header {
	if n.header == nil {
		n.header = make(http.Header)
	}
	return n.header
}
func (n *nonFlusherWriter) Write(b []byte) (int, error) { return n.body.Write(b) }
func (n *nonFlusherWriter) WriteHeader(code int)        { n.code = code }

func TestTransportsHTTPAndStdio(t *testing.T) {
	srv, _, _ := newTestServer(t)

	// HTTP OPTIONS
	reqOpt := httptest.NewRequest(http.MethodOptions, "/mcp", nil)
	wOpt := httptest.NewRecorder()
	srv.ServeHTTP(wOpt, reqOpt)
	if wOpt.Code != http.StatusNoContent {
		t.Errorf("expected 204 for OPTIONS, got %d", wOpt.Code)
	}

	// HTTP PUT -> 405 Method Not Allowed
	reqPut := httptest.NewRequest(http.MethodPut, "/mcp", nil)
	wPut := httptest.NewRecorder()
	srv.ServeHTTP(wPut, reqPut)
	if wPut.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405 for PUT, got %d", wPut.Code)
	}

	// HTTP GET status
	reqGet := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	wGet := httptest.NewRecorder()
	srv.ServeHTTP(wGet, reqGet)
	if wGet.Code != http.StatusOK {
		t.Errorf("expected 200 for GET /mcp, got %d", wGet.Code)
	}

	// HTTP POST empty, invalid JSON, invalid batch, notification-only batch
	for _, body := range []string{"   ", "{invalid", "[]", "[invalid"} {
		reqBad := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
		wBad := httptest.NewRecorder()
		srv.ServeHTTP(wBad, reqBad)
		if !strings.Contains(wBad.Body.String(), `"error"`) {
			t.Errorf("expected JSON-RPC error response for body %q, got %s", body, wBad.Body.String())
		}
	}

	reqNotifBatch := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`[{"jsonrpc":"2.0","method":"notifications/initialized"}]`))
	wNotifBatch := httptest.NewRecorder()
	srv.ServeHTTP(wNotifBatch, reqNotifBatch)
	if wNotifBatch.Code != http.StatusAccepted {
		t.Errorf("expected 202 for notification batch, got %d", wNotifBatch.Code)
	}

	// HTTP POST single request & notification
	reqPost := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	wPost := httptest.NewRecorder()
	srv.ServeHTTP(wPost, reqPost)
	if wPost.Code != http.StatusOK {
		t.Errorf("expected 200 for POST /mcp, got %d", wPost.Code)
	}

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

	// SSE with non-Flusher writer -> 500
	nf := &nonFlusherWriter{}
	reqNF := httptest.NewRequest(http.MethodGet, "/sse", nil)
	srv.ServeHTTP(nf, reqNF)
	if nf.code != http.StatusInternalServerError {
		t.Errorf("expected 500 for non-flusher writer, got %d", nf.code)
	}

	// HTTP SSE stream + session message forwarding + DELETE session
	ctxSSE, cancelSSE := context.WithCancel(context.Background())
	reqSSE := httptest.NewRequest(http.MethodGet, "/sse", nil).WithContext(ctxSSE)
	wSSE := httptest.NewRecorder()
	doneSSE := make(chan struct{})
	go func() {
		srv.ServeHTTP(wSSE, reqSSE)
		close(doneSSE)
	}()
	time.Sleep(30 * time.Millisecond)

	// Extract session ID from header and forward a POST message to it
	sessID := wSSE.Header().Get("Mcp-Session-Id")
	if sessID != "" {
		reqForward := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":99,"method":"ping"}`))
		reqForward.Header.Set("Mcp-Session-Id", sessID)
		wForward := httptest.NewRecorder()
		srv.ServeHTTP(wForward, reqForward)
		time.Sleep(20 * time.Millisecond)
	}

	cancelSSE()
	<-doneSSE
	sseOut := wSSE.Body.String()
	if !strings.Contains(sseOut, "event: endpoint") || !strings.Contains(sseOut, "event: message") {
		t.Errorf("expected SSE endpoint and message events, got %q", sseOut)
	}

	reqDel := httptest.NewRequest(http.MethodDelete, "/mcp", nil)
	reqDel.Header.Set("Mcp-Session-Id", "test-session")
	wDel := httptest.NewRecorder()
	srv.ServeHTTP(wDel, reqDel)
	if wDel.Code != http.StatusOK {
		t.Errorf("expected 200 for DELETE /mcp, got %d", wDel.Code)
	}

	// Stdio transport including blank lines, invalid JSON, invalid batch, notification batch, and valid requests
	stdioIn := strings.NewReader(
		"\n" +
			"{bad json\n" +
			"[]\n" +
			"[{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}]\n" +
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
	if lines != 4 {
		t.Errorf("expected 4 response lines on stdout (2 errors + 2 responses), got %d", lines)
	}

	// Stdio with canceled context
	ctxCanceled, cancel := context.WithCancel(context.Background())
	cancel()
	_ = srv.ServeStdio(ctxCanceled, strings.NewReader("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n"), &bytes.Buffer{})
}

func TestWorkspacesAndConfigTools(t *testing.T) {
	srv, _, _ := newTestServer(t)

	// Test normalizeWorkspacesSlice with legacy map format and fallback to store
	legacyMap := map[string]interface{}{
		"Alpha": "/path/alpha",
		"Beta": map[string]interface{}{
			"path":       "/path/beta",
			"hidden":     true,
			"fernet_key": "secret-fernet",
		},
	}
	norm := normalizeWorkspacesSlice(legacyMap, srv.Store)
	if len(norm) != 2 {
		t.Errorf("expected 2 normalized entries from map, got %d", len(norm))
	}
	rawSlice := toRawWorkspaceSlice(norm)
	if len(rawSlice) != 2 {
		t.Errorf("expected 2 raw workspace entries")
	}
	fallbackNorm := normalizeWorkspacesSlice(nil, srv.Store)
	if len(fallbackNorm) != 2 {
		t.Errorf("expected fallback to store workspaces, got %d", len(fallbackNorm))
	}

	// isWorkspaceHidden checks
	if srv.isWorkspaceHidden("ExoDeck") {
		t.Errorf("expected ExoDeck help workspace not to be hidden")
	}
	if !srv.isWorkspaceHidden("SecretWS") {
		t.Errorf("expected SecretWS to be hidden")
	}
	if srv.isWorkspaceHidden("NonExistent") {
		t.Errorf("expected NonExistent to return false")
	}

	// 1. list_workspaces & create_workspace & update_workspace & delete_workspace
	text, isErr := callToolHelper(t, srv, "list_workspaces", map[string]interface{}{})
	if isErr {
		t.Fatalf("list_workspaces failed: %s", text)
	}
	var wsList []WorkspaceSummary
	_ = json.Unmarshal([]byte(text), &wsList)
	if len(wsList) != 1 || wsList[0].Name != "Main" {
		t.Errorf("expected only visible workspace 'Main', got %+v", wsList)
	}

	// Validation errors on create_workspace
	for _, badArgs := range []map[string]interface{}{
		{"name": "", "path": "p"},
		{"name": "Valid", "path": ""},
		{"name": "ExoDeck", "path": "p"},
		{"name": "Main", "path": "p"},
	} {
		if _, errFlag := callToolHelper(t, srv, "create_workspace", badArgs); !errFlag {
			t.Errorf("expected create_workspace error for args %+v", badArgs)
		}
	}

	_, isErr = callToolHelper(t, srv, "create_workspace", map[string]interface{}{
		"name":   "Projects",
		"path":   "projects_data",
		"hidden": false,
	})
	if isErr {
		t.Fatalf("create_workspace failed")
	}

	// Validation errors on update_workspace
	emptyStr := ""
	reservedStr := "ExoDeck"
	dupStr := "Main"
	for _, badArgs := range []map[string]interface{}{
		{"name": ""},
		{"name": "NoSuchWS"},
		{"name": "Projects", "new_name": emptyStr},
		{"name": "Projects", "new_name": reservedStr},
		{"name": "Projects", "new_name": dupStr},
		{"name": "Projects", "path": emptyStr},
	} {
		if _, errFlag := callToolHelper(t, srv, "update_workspace", badArgs); !errFlag {
			t.Errorf("expected update_workspace error for args %+v", badArgs)
		}
	}

	_, isErr = callToolHelper(t, srv, "update_workspace", map[string]interface{}{
		"name":     "Projects",
		"new_name": "WorkProjects",
		"path":     "work_projects_data",
		"hidden":   true,
	})
	if isErr {
		t.Fatalf("update_workspace failed")
	}

	// Validation errors on delete_workspace
	for _, badArgs := range []map[string]interface{}{
		{"name": ""},
		{"name": "NoSuchWS"},
	} {
		if _, errFlag := callToolHelper(t, srv, "delete_workspace", badArgs); !errFlag {
			t.Errorf("expected delete_workspace error for args %+v", badArgs)
		}
	}

	_, isErr = callToolHelper(t, srv, "delete_workspace", map[string]interface{}{
		"name": "WorkProjects",
	})
	if isErr {
		t.Fatalf("delete_workspace failed")
	}

	// 6. get_config & update_config (all fields + error validations)
	cfgText, isErr := callToolHelper(t, srv, "get_config", map[string]interface{}{})
	if isErr || !strings.Contains(cfgText, `"theme": "dark"`) {
		t.Fatalf("get_config unexpected output: %s", cfgText)
	}

	for _, badCfg := range []map[string]interface{}{
		{"theme": "neon"},
		{"groupbox_max_width": 0},
		{"font_size_ui": -1},
		{"font_size_note": 0},
		{"font_size_links": 0},
	} {
		if _, errFlag := callToolHelper(t, srv, "update_config", badCfg); !errFlag {
			t.Errorf("expected update_config error for %+v", badCfg)
		}
	}

	updCfgText, isErr := callToolHelper(t, srv, "update_config", map[string]interface{}{
		"theme":              "light",
		"groupbox_max_width": 500,
		"font_size_ui":       15,
		"font_size_note":     17,
		"font_size_links":    15,
		"enable_git_sync":    true,
	})
	if isErr || !strings.Contains(updCfgText, `"theme": "light"`) {
		t.Fatalf("update_config unexpected output: %s", updCfgText)
	}
}

func TestGridPagesGroupsItemsAndSecurity(t *testing.T) {
	srv, mainWSPath, _ := newTestServer(t)

	// Validation errors on create_grid_page
	for _, badArgs := range []map[string]interface{}{
		{"page_name": ""},
		{"page_name": "!!!"},
		{"page_name": "Valid", "workspace": "NoSuchWS"},
		{"page_name": "Valid", "groups": []map[string]interface{}{{"title": ""}}},
		{"page_name": "Valid", "groups": []map[string]interface{}{{"title": "G", "items": []map[string]interface{}{{"title": ""}}}}},
		{"page_name": "Valid", "groups": []map[string]interface{}{{"title": "G", "items": []map[string]interface{}{{"title": "Both", "url": "https://a.com", "markdown": "text"}}}}},
	} {
		if _, errFlag := callToolHelper(t, srv, "create_grid_page", badArgs); !errFlag {
			t.Errorf("expected create_grid_page error for %+v", badArgs)
		}
	}

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
						"title": "Empty Default Note",
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

	// Duplicate create_grid_page error
	if _, errFlag := callToolHelper(t, srv, "create_grid_page", map[string]interface{}{
		"page_name": "Engineering",
		"workspace": "Main",
	}); !errFlag {
		t.Errorf("expected duplicate create_grid_page to fail")
	}

	// 2. update_grid_page (including rename + media directory rename + flags + groups)
	_ = os.MkdirAll(filepath.Join(mainWSPath, "engineering"), 0o755)
	updPageText, isErr := callToolHelper(t, srv, "update_grid_page", map[string]interface{}{
		"slug":        "engineering",
		"workspace":   "Main",
		"page_name":   "Engineering Hub",
		"hidden":      false,
		"custom_sort": true,
	})
	if isErr || !strings.Contains(updPageText, "engineering-hub") {
		t.Fatalf("update_grid_page rename failed: %s", updPageText)
	}
	// Rename back to engineering
	_, isErr = callToolHelper(t, srv, "update_grid_page", map[string]interface{}{
		"slug":      "engineering-hub",
		"workspace": "Main",
		"page_name": "Engineering",
		"groups": []map[string]interface{}{
			{
				"title": "Dev Links",
				"items": []map[string]interface{}{
					{"title": "ExoDeck Repo", "url": "https://github.com/ExoDeck/exodeck", "notes": "Main repository"},
					{"title": "Quick Note", "markdown": "## Architecture\nAll local-first."},
				},
			},
		},
	})
	if isErr {
		t.Fatalf("update_grid_page back to engineering failed")
	}
	if _, errFlag := callToolHelper(t, srv, "update_grid_page", map[string]interface{}{
		"slug":      "engineering",
		"workspace": "Main",
		"page_name": "   ",
	}); !errFlag {
		t.Errorf("expected empty page_name on update_grid_page to fail")
	}

	// 3. add_group & update_group (title + items) & move_group
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
		"items": []map[string]interface{}{
			{"title": "Initial Task", "task_checked": false},
		},
	})
	if isErr {
		t.Fatalf("update_group failed")
	}
	if _, errFlag := callToolHelper(t, srv, "update_group", map[string]interface{}{
		"slug": "engineering", "workspace": "Main", "group_index": 99,
	}); !errFlag {
		t.Errorf("expected out of range group_index to fail")
	}

	// Move group within same page and to another grid page
	_, _ = callToolHelper(t, srv, "create_grid_page", map[string]interface{}{
		"page_name": "Archive",
		"workspace": "Main",
	})
	_, isErr = callToolHelper(t, srv, "move_group", map[string]interface{}{
		"slug":        "engineering",
		"workspace":   "Main",
		"group_index": 1,
		"target_slug": "archive",
	})
	if isErr {
		t.Fatalf("move_group to archive failed")
	}
	// Move it back
	_, isErr = callToolHelper(t, srv, "move_group", map[string]interface{}{
		"slug":        "archive",
		"workspace":   "Main",
		"group_index": 0,
		"target_slug": "engineering",
	})
	if isErr {
		t.Fatalf("move_group back to engineering failed")
	}
	// Delete archive grid page
	_, isErr = callToolHelper(t, srv, "delete_grid_page", map[string]interface{}{
		"slug":      "archive",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("delete_grid_page failed")
	}

	// 4. add_item by group_title (creates new group when not found) & by group_index
	_, isErr = callToolHelper(t, srv, "add_item", map[string]interface{}{
		"slug":         "engineering",
		"workspace":    "Main",
		"group_title":  "Brand New Group",
		"title":        "Write unit tests",
		"task_checked": false,
	})
	if isErr {
		t.Fatalf("add_item with new group_title failed")
	}
	if _, errFlag := callToolHelper(t, srv, "add_item", map[string]interface{}{
		"slug": "engineering", "workspace": "Main", "title": "Orphan Item",
	}); !errFlag {
		t.Errorf("expected add_item without group_index or group_title to fail")
	}

	// 5. update_item (all fields: title, url, notes, markdown, task_checked, task_due_date)
	updItemText, isErr := callToolHelper(t, srv, "update_item", map[string]interface{}{
		"slug":          "engineering",
		"workspace":     "Main",
		"group_index":   0,
		"item_index":    0,
		"title":         "ExoDeck GitHub",
		"url":           "https://github.com/ExoDeck",
		"notes":         "Updated notes",
		"task_checked":  true,
		"task_due_date": "2026-12-31",
	})
	if isErr || !strings.Contains(updItemText, `"task_checked": true`) {
		t.Fatalf("update_item failed: %s", updItemText)
	}
	// Clear url, notes, task_due_date and set markdown instead
	_, isErr = callToolHelper(t, srv, "update_item", map[string]interface{}{
		"slug":          "engineering",
		"workspace":     "Main",
		"group_index":   0,
		"item_index":    0,
		"url":           "",
		"notes":         "",
		"markdown":      "Converted to note",
		"task_due_date": "",
	})
	if isErr {
		t.Fatalf("update_item clear fields failed")
	}
	// Invalid update_item calls
	for _, badUpd := range []map[string]interface{}{
		{"slug": "engineering", "group_index": 0, "item_index": 0, "password": "secret"},
		{"slug": "engineering", "group_index": 99, "item_index": 0},
		{"slug": "engineering", "group_index": 0, "item_index": 99},
		{"slug": "engineering", "group_index": 0, "item_index": 0, "title": "  "},
		{"slug": "engineering", "group_index": 0, "item_index": 0, "url": "https://x.com", "markdown": "both"},
	} {
		if _, errFlag := callToolHelper(t, srv, "update_item", badUpd); !errFlag {
			t.Errorf("expected update_item to fail for %+v", badUpd)
		}
	}

	// 6. move_item & delete_item & delete_group
	if _, errFlag := callToolHelper(t, srv, "move_item", map[string]interface{}{
		"slug": "engineering", "group_index": 0, "item_index": 0, "target_group_index": 0,
	}); !errFlag {
		t.Errorf("expected move_item to same group to fail")
	}
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
		"group_index": 2,
	})
	if isErr {
		t.Fatalf("delete_group failed")
	}

	// 7. Security guardrails: verify existing encrypted/locked items on disk are masked and protected
	pageOnDisk, _, _ := srv.Store.ReadPage("engineering", "Main")
	secretVal := "v1:encrypted-ciphertext"
	userVal := "admin"
	lockedTrue := true
	pageOnDisk.Groups[0].Items = append(pageOnDisk.Groups[0].Items,
		models.Item{
			Title:    "Prod DB",
			Username: &userVal,
			Password: &secretVal,
		},
		models.Item{
			Title:  "Locked Note",
			Locked: &lockedTrue,
		},
	)
	_, _ = srv.Store.WritePage("engineering", pageOnDisk, "Main")

	if !pageContainsSensitiveItems(pageOnDisk) {
		t.Errorf("expected pageContainsSensitiveItems to return true")
	}

	maskedRead, isErr := callToolHelper(t, srv, "get_grid_page", map[string]interface{}{
		"slug":      "engineering",
		"workspace": "Main",
	})
	if isErr || strings.Contains(maskedRead, "encrypted-ciphertext") || !strings.Contains(maskedRead, `"locked": true`) {
		t.Fatalf("expected sensitive fields to be masked, got: %s", maskedRead)
	}

	// Reject overwriting groups on page with sensitive items, updating group items, deleting group, moving page, updating/deleting item
	if _, errFlag := callToolHelper(t, srv, "update_grid_page", map[string]interface{}{
		"slug": "engineering", "groups": []map[string]interface{}{},
	}); !errFlag {
		t.Errorf("expected replacing groups on sensitive page to fail")
	}
	if _, errFlag := callToolHelper(t, srv, "update_group", map[string]interface{}{
		"slug": "engineering", "group_index": 0, "items": []map[string]interface{}{},
	}); !errFlag {
		t.Errorf("expected replacing items in sensitive group to fail")
	}
	if _, errFlag := callToolHelper(t, srv, "delete_group", map[string]interface{}{
		"slug": "engineering", "group_index": 0,
	}); !errFlag {
		t.Errorf("expected deleting sensitive group to fail")
	}
	if _, errFlag := callToolHelper(t, srv, "update_item", map[string]interface{}{
		"slug": "engineering", "group_index": 0, "item_index": 1, "title": "Hack",
	}); !errFlag {
		t.Errorf("expected updating sensitive item to fail")
	}
	if _, errFlag := callToolHelper(t, srv, "delete_item", map[string]interface{}{
		"slug": "engineering", "group_index": 0, "item_index": 1,
	}); !errFlag {
		t.Errorf("expected deleting sensitive item to fail")
	}
	if _, errFlag := callToolHelper(t, srv, "move_page", map[string]interface{}{
		"slug": "engineering", "workspace": "Main", "target_workspace": "SecretWS",
	}); !errFlag {
		t.Errorf("expected moving grid page with sensitive items to fail")
	}
}

func TestNotesWhiteboardsBpmnSearchTasksMoveAndSync(t *testing.T) {
	srv, mainWSPath, _ := newTestServer(t)

	// 1. Notes CRUD + media + copyDirectory
	if _, errFlag := callToolHelper(t, srv, "create_note", map[string]interface{}{"content": "   "}); !errFlag {
		t.Errorf("expected empty create_note to fail")
	}
	// Create note with title only
	_, isErr := callToolHelper(t, srv, "create_note", map[string]interface{}{
		"title":     "Title Only Note",
		"content":   "",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("create_note with title only failed")
	}

	noteRes, isErr := callToolHelper(t, srv, "create_note", map[string]interface{}{
		"title":     "Meeting Notes",
		"content":   "Discussed MCP server architecture.",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("create_note failed: %s", noteRes)
	}
	_, isErr = callToolHelper(t, srv, "get_note", map[string]interface{}{
		"slug":      "meeting-notes",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("get_note failed")
	}
	_, _ = callToolHelper(t, srv, "get_note", map[string]interface{}{"slug": "no-such-note", "workspace": "Main"})
	_, _ = callToolHelper(t, srv, "get_note", map[string]interface{}{"slug": "meeting-notes", "workspace": "NoSuchWS"})

	// Update note with append=true and then rename via H1 change
	_, isErr = callToolHelper(t, srv, "update_note", map[string]interface{}{
		"slug":      "meeting-notes",
		"content":   "Action item: ship v1.",
		"append":    true,
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("update_note append failed")
	}
	_, isErr = callToolHelper(t, srv, "update_note", map[string]interface{}{
		"slug":      "meeting-notes",
		"content":   "# Meeting Notes Renamed\n\nUpdated body.",
		"append":    false,
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("update_note rename failed")
	}

	// Create media files & nested subdir for meeting-notes-renamed
	mediaDir := filepath.Join(mainWSPath, "meeting-notes-renamed")
	_ = os.MkdirAll(filepath.Join(mediaDir, "sub"), 0o755)
	_ = os.WriteFile(filepath.Join(mediaDir, "diagram.png"), []byte("pngdata"), 0o644)
	_ = os.WriteFile(filepath.Join(mediaDir, "sub", "nested.txt"), []byte("nested"), 0o644)

	mediaList, isErr := callToolHelper(t, srv, "list_media", map[string]interface{}{
		"slug":      "meeting-notes-renamed",
		"workspace": "Main",
	})
	if isErr || !strings.Contains(mediaList, "diagram.png") {
		t.Fatalf("list_media failed: %s", mediaList)
	}
	if _, errFlag := callToolHelper(t, srv, "list_media", map[string]interface{}{"slug": ".."}); !errFlag {
		t.Errorf("expected invalid slug on list_media to fail")
	}
	if _, errFlag := callToolHelper(t, srv, "delete_media", map[string]interface{}{
		"slug": "meeting-notes-renamed", "filename": "nonexistent.png", "workspace": "Main",
	}); !errFlag {
		t.Errorf("expected deleting nonexistent media to fail")
	}
	if _, errFlag := callToolHelper(t, srv, "delete_media", map[string]interface{}{
		"slug": "about", "filename": "x.png", "workspace": "ExoDeck",
	}); !errFlag {
		t.Errorf("expected delete_media on ExoDeck help workspace to fail")
	}

	// Move note (with media dir & nested dir) to SecretWS, then delete diagram.png
	_, isErr = callToolHelper(t, srv, "move_page", map[string]interface{}{
		"slug":             "meeting-notes-renamed",
		"workspace":        "Main",
		"target_workspace": "SecretWS",
	})
	if isErr {
		t.Fatalf("move_page for note with media failed")
	}
	_, isErr = callToolHelper(t, srv, "delete_media", map[string]interface{}{
		"slug":      "meeting-notes-renamed",
		"filename":  "diagram.png",
		"workspace": "SecretWS",
	})
	if isErr {
		t.Fatalf("delete_media in SecretWS failed")
	}

	// 2. Whiteboards CRUD (with custom content & elements + move_page)
	if _, errFlag := callToolHelper(t, srv, "create_whiteboard", map[string]interface{}{
		"page_name": "Bad WB",
		"content":   "{bad json",
	}); !errFlag {
		t.Errorf("expected invalid Excalidraw JSON to fail")
	}

	_, isErr = callToolHelper(t, srv, "create_whiteboard", map[string]interface{}{
		"page_name": "Default WB",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("create_whiteboard default failed")
	}
	_, _ = callToolHelper(t, srv, "delete_whiteboard", map[string]interface{}{"slug": "default-wb", "workspace": "Main"})

	_, isErr = callToolHelper(t, srv, "create_whiteboard", map[string]interface{}{
		"page_name": "System Sketch",
		"workspace": "Main",
		"content":   `{"type":"excalidraw","version":2,"elements":[]}`,
		"elements":  []map[string]interface{}{{"id": "rect-1", "type": "rectangle"}},
	})
	if isErr {
		t.Fatalf("create_whiteboard failed")
	}
	_, isErr = callToolHelper(t, srv, "get_whiteboard", map[string]interface{}{
		"slug":      "system-sketch",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("get_whiteboard failed")
	}
	_, _ = callToolHelper(t, srv, "get_whiteboard", map[string]interface{}{"slug": "no-such-wb", "workspace": "Main"})
	_, _ = callToolHelper(t, srv, "get_whiteboard", map[string]interface{}{"slug": "system-sketch", "workspace": "NoSuchWS"})
	_, isErr = callToolHelper(t, srv, "update_whiteboard", map[string]interface{}{
		"slug":      "system-sketch",
		"page_name": "System Sketch v2",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("update_whiteboard failed")
	}
	_, isErr = callToolHelper(t, srv, "move_page", map[string]interface{}{
		"slug":             "system-sketch-v2",
		"workspace":        "Main",
		"target_workspace": "SecretWS",
	})
	if isErr {
		t.Fatalf("move_page for whiteboard failed")
	}

	// 3. BPMN CRUD (with custom XML + move_page)
	if _, errFlag := callToolHelper(t, srv, "create_bpmn", map[string]interface{}{"page_name": ""}); !errFlag {
		t.Errorf("expected empty BPMN page_name to fail")
	}
	_, isErr = callToolHelper(t, srv, "create_bpmn", map[string]interface{}{
		"page_name": "Order Flow",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("create_bpmn failed")
	}
	_, isErr = callToolHelper(t, srv, "get_bpmn", map[string]interface{}{
		"slug":      "order-flow",
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("get_bpmn failed")
	}
	_, _ = callToolHelper(t, srv, "get_bpmn", map[string]interface{}{"slug": "no-such-bpmn", "workspace": "Main"})
	_, _ = callToolHelper(t, srv, "get_bpmn", map[string]interface{}{"slug": "order-flow", "workspace": "NoSuchWS"})
	_, isErr = callToolHelper(t, srv, "update_bpmn", map[string]interface{}{
		"slug":      "order-flow",
		"page_name": "Order Flow v2",
		"bpmn_xml":  defaultBpmnXML("Order Flow v2"),
		"workspace": "Main",
	})
	if isErr {
		t.Fatalf("update_bpmn failed")
	}
	_, isErr = callToolHelper(t, srv, "move_page", map[string]interface{}{
		"slug":             "order-flow-v2",
		"workspace":        "Main",
		"target_workspace": "SecretWS",
	})
	if isErr {
		t.Fatalf("move_page for bpmn failed")
	}

	// 4. Move clean grid page + move_page error cases
	_, _ = callToolHelper(t, srv, "create_grid_page", map[string]interface{}{
		"page_name": "Movable Grid",
		"workspace": "Main",
	})
	_, isErr = callToolHelper(t, srv, "move_page", map[string]interface{}{
		"slug":             "movable-grid",
		"workspace":        "Main",
		"target_workspace": "SecretWS",
	})
	if isErr {
		t.Fatalf("move_page for grid page failed")
	}
	for _, badMove := range []map[string]interface{}{
		{"slug": "", "workspace": "Main", "target_workspace": "SecretWS"},
		{"slug": "x", "workspace": "Main", "target_workspace": "Main"},
		{"slug": "about", "workspace": "ExoDeck", "target_workspace": "Main"},
		{"slug": "no-such-page", "workspace": "Main", "target_workspace": "SecretWS"},
	} {
		if _, errFlag := callToolHelper(t, srv, "move_page", badMove); !errFlag {
			t.Errorf("expected move_page error for %+v", badMove)
		}
	}

	// 5. Hidden workspace & page filtering in list_pages, search, list_tasks
	tomorrow := time.Now().UTC().Add(24 * time.Hour).Format("2006-01-02")
	future := time.Now().UTC().Add(72 * time.Hour).Format("2006-01-02")
	_, isErr = callToolHelper(t, srv, "create_grid_page", map[string]interface{}{
		"page_name": "Secret Roadmap",
		"workspace": "SecretWS",
		"groups": []map[string]interface{}{
			{
				"title": "Confidential Tasks",
				"items": []map[string]interface{}{
					{"title": "Overdue Task", "task_checked": false, "task_due_date": "2020-01-01"},
					{"title": "Tomorrow Task", "task_checked": false, "task_due_date": tomorrow},
					{"title": "Future Task", "task_checked": false, "task_due_date": future},
					{"title": "Secret Link", "url": "https://internal.example.com", "notes": "vpn only"},
					{"title": "Secret Note", "markdown": "searchable markdown content"},
				},
			},
		},
	})
	if isErr {
		t.Fatalf("create_grid_page in SecretWS failed")
	}

	// Accessing hidden workspace directly without include_hidden=true fails
	if _, errFlag := callToolHelper(t, srv, "list_pages", map[string]interface{}{
		"workspace": "SecretWS", "include_hidden": false,
	}); !errFlag {
		t.Errorf("expected accessing hidden workspace with include_hidden=false to fail")
	}
	// With include_hidden=true and page_type filter succeeds
	pagesFiltered, isErr := callToolHelper(t, srv, "list_pages", map[string]interface{}{
		"workspace": "SecretWS", "include_hidden": true, "page_type": "grid",
	})
	if isErr || !strings.Contains(pagesFiltered, "secret-roadmap") {
		t.Errorf("expected secret-roadmap in filtered list_pages, got %s", pagesFiltered)
	}

	// Search by note body, URL, notes, markdown, and filters
	if _, errFlag := callToolHelper(t, srv, "search", map[string]interface{}{"query": "  "}); !errFlag {
		t.Errorf("expected empty search query to fail")
	}
	for _, q := range []string{"Updated body", "internal.example.com", "vpn only", "searchable markdown"} {
		res, errFlag := callToolHelper(t, srv, "search", map[string]interface{}{
			"query": q, "include_hidden": true,
		})
		if errFlag || (!strings.Contains(res, "secret-roadmap") && !strings.Contains(res, "meeting-notes-renamed")) {
			t.Errorf("expected search for %q to match, got %s", q, res)
		}
	}

	// list_tasks with filter=all and filter=due, include_hidden=false and true
	if _, errFlag := callToolHelper(t, srv, "list_tasks", map[string]interface{}{"filter": "bad"}); !errFlag {
		t.Errorf("expected invalid task filter to fail")
	}
	_, _ = callToolHelper(t, srv, "list_tasks", map[string]interface{}{"filter": "all", "include_hidden": false})
	_, _ = callToolHelper(t, srv, "list_tasks", map[string]interface{}{"filter": "due", "include_hidden": false})
	tasksAllHidden, _ := callToolHelper(t, srv, "list_tasks", map[string]interface{}{"filter": "all", "include_hidden": true})
	if !strings.Contains(tasksAllHidden, "Future Task") {
		t.Errorf("expected Future Task in filter=all, got %s", tasksAllHidden)
	}
	tasksDueHidden, _ := callToolHelper(t, srv, "list_tasks", map[string]interface{}{"filter": "due", "include_hidden": true})
	if !strings.Contains(tasksDueHidden, "Overdue Task") || !strings.Contains(tasksDueHidden, "Tomorrow Task") {
		t.Errorf("expected Overdue and Tomorrow tasks in filter=due, got %s", tasksDueHidden)
	}

	// Delete note, whiteboard, bpmn
	_, _ = callToolHelper(t, srv, "delete_note", map[string]interface{}{"slug": "meeting-notes-renamed", "workspace": "SecretWS"})
	_, _ = callToolHelper(t, srv, "delete_whiteboard", map[string]interface{}{"slug": "system-sketch-v2", "workspace": "SecretWS"})
	_, _ = callToolHelper(t, srv, "delete_bpmn", map[string]interface{}{"slug": "order-flow-v2", "workspace": "SecretWS"})

	// 6. Git sync status & sync (including error/edge branches)
	_, _ = callToolHelper(t, srv, "list_workspaces", map[string]interface{}{"include_hidden": true})
	syncStAll, isErr := callToolHelper(t, srv, "git_sync_status", map[string]interface{}{})
	if isErr || !strings.Contains(syncStAll, `"uncommitted": true`) {
		t.Fatalf("git_sync_status all failed: %s", syncStAll)
	}
	syncStSingle, isErr := callToolHelper(t, srv, "git_sync_status", map[string]interface{}{"workspace": "Main"})
	if isErr || !strings.Contains(syncStSingle, `"uncommitted": true`) {
		t.Fatalf("git_sync_status single failed: %s", syncStSingle)
	}
	syncStHelp, _ := callToolHelper(t, srv, "git_sync_status", map[string]interface{}{"workspace": "ExoDeck"})
	if !strings.Contains(syncStHelp, `"enabled": false`) {
		t.Errorf("expected git_sync_status disabled on ExoDeck")
	}

	// Simulate commit returning "nothing to commit" (should still succeed)
	srv.GitRunner = &mockGitRunner{failCmd: "commit", commitMsg: "nothing to commit, working tree clean"}
	syncNothing, isErr := callToolHelper(t, srv, "git_sync", map[string]interface{}{"workspace": "Main"})
	if isErr || !strings.Contains(syncNothing, `"status": "success"`) {
		t.Errorf("expected git_sync with 'nothing to commit' to succeed, got %s", syncNothing)
	}

	// Simulate push failure
	srv.GitRunner = &mockGitRunner{failCmd: "push"}
	if _, errFlag := callToolHelper(t, srv, "git_sync", map[string]interface{}{"workspace": "Main"}); !errFlag {
		t.Errorf("expected git_sync push failure to return error")
	}

	// Simulate non-matching toplevel directory
	srv.GitRunner = &mockGitRunner{toplevel: "/some/parent/dir"}
	stNotRoot, _ := callToolHelper(t, srv, "git_sync_status", map[string]interface{}{"workspace": "Main"})
	if !strings.Contains(stNotRoot, "Not the root") {
		t.Errorf("expected Not the root error, got %s", stNotRoot)
	}
	if _, errFlag := callToolHelper(t, srv, "git_sync", map[string]interface{}{"workspace": "Main"}); !errFlag {
		t.Errorf("expected git_sync on non-root to fail")
	}

	// Simulate rev-parse failure (not a git repo)
	srv.GitRunner = &mockGitRunner{failCmd: "rev-parse"}
	stNotRepo, _ := callToolHelper(t, srv, "git_sync_status", map[string]interface{}{"workspace": "Main"})
	if !strings.Contains(stNotRepo, "Not a git repository") {
		t.Errorf("expected Not a git repository, got %s", stNotRepo)
	}
	if _, errFlag := callToolHelper(t, srv, "git_sync", map[string]interface{}{"workspace": "Main"}); !errFlag {
		t.Errorf("expected git_sync on non-repo to fail")
	}

	// Test defaultGitRunner when GitRunner is nil
	srv.GitRunner = nil
	runner := srv.getGitRunner()
	_, _, _ = runner.Run(context.Background(), t.TempDir(), "--version")
	_, _, _ = runner.Run(context.Background(), t.TempDir(), "rev-parse", "--git-dir")

	// Disable git sync in config and test git_sync_status / git_sync
	_, _ = callToolHelper(t, srv, "update_config", map[string]interface{}{"enable_git_sync": false})
	stDisabled, _ := callToolHelper(t, srv, "git_sync_status", map[string]interface{}{"workspace": "Main"})
	if !strings.Contains(stDisabled, `"enabled": false`) {
		t.Errorf("expected enabled=false when git sync disabled")
	}
	if _, errFlag := callToolHelper(t, srv, "git_sync", map[string]interface{}{"workspace": "Main"}); !errFlag {
		t.Errorf("expected git_sync to fail when disabled")
	}

	// decodeMarkdownText fallback for non-base64 text
	if got := decodeMarkdownText("not-valid-base64!!!"); got != "not-valid-base64!!!" {
		t.Errorf("expected raw string fallback, got %s", got)
	}
	if got := decodeMarkdownText(""); got != "" {
		t.Errorf("expected empty string, got %s", got)
	}

	// Exercise invalid JSON unmarshal branch across tools
	for _, toolName := range []string{
		"list_workspaces", "create_workspace", "update_workspace", "delete_workspace",
		"update_config", "list_pages", "search", "list_tasks", "move_page",
		"git_sync_status", "git_sync",
		"get_grid_page", "create_grid_page", "update_grid_page", "delete_grid_page",
		"add_group", "update_group", "delete_group", "move_group",
		"add_item", "update_item", "delete_item", "move_item",
		"get_note", "create_note", "update_note", "delete_note",
		"list_media", "delete_media",
		"get_whiteboard", "create_whiteboard", "update_whiteboard", "delete_whiteboard",
		"get_bpmn", "create_bpmn", "update_bpmn", "delete_bpmn",
	} {
		callToolInvalidJSON(t, srv, toolName)
	}
}
