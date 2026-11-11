package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/ExoDeck/exodeck/internal/storage"
)

const (
	// DefaultProtocolVersion is the default MCP protocol version negotiated with clients.
	DefaultProtocolVersion = "2024-11-05"
	// LatestProtocolVersion is the Streamable HTTP MCP protocol version.
	LatestProtocolVersion = "2025-03-26"

	// Standard JSON-RPC 2.0 error codes.
	ErrCodeParseError     = -32700
	ErrCodeInvalidRequest = -32600
	ErrCodeMethodNotFound = -32601
	ErrCodeInvalidParams  = -32602
	ErrCodeInternalError  = -32603
)

// GitRunner executes git commands in a directory.
type GitRunner interface {
	Run(ctx context.Context, cwd string, args ...string) (rc int, stdout, stderr string)
}

// Request represents a JSON-RPC 2.0 request or notification.
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Response represents a JSON-RPC 2.0 response.
type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *ErrorObject    `json:"error,omitempty"`
}

// ErrorObject represents a JSON-RPC 2.0 error object.
type ErrorObject struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

// Tool describes an MCP tool exposed by the server.
type Tool struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"inputSchema"`
}

// CallToolParams represents the parameters for tools/call.
type CallToolParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

// ContentBlock represents one block of content in a CallToolResult.
type ContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// CallToolResult represents the result returned by tools/call.
type CallToolResult struct {
	Content []ContentBlock `json:"content"`
	IsError bool           `json:"isError,omitempty"`
}

// ToolHandler executes a single MCP tool call.
type ToolHandler func(ctx context.Context, args json.RawMessage) (interface{}, error)

// Server implements the Model Context Protocol server for ExoDeck.
type Server struct {
	Store       *storage.Store
	ConfigDir   string
	GitRunner   GitRunner
	Version     string
	tools       []Tool
	handlers    map[string]ToolHandler
	sseSessions sync.Map // sessionID string -> chan []byte
}

// NewServer creates and initializes an MCP Server with all ExoDeck tools registered.
func NewServer(store *storage.Store, configDir string, gitRunner GitRunner, version string) *Server {
	if version == "" {
		version = "1.0.0"
	}
	s := &Server{
		Store:     store,
		ConfigDir: configDir,
		GitRunner: gitRunner,
		Version:   version,
		tools:     make([]Tool, 0, 40),
		handlers:  make(map[string]ToolHandler, 40),
	}
	s.registerAllTools()
	return s
}

func (s *Server) registerTool(name, description string, schema map[string]interface{}, handler ToolHandler) {
	s.tools = append(s.tools, Tool{
		Name:        name,
		Description: description,
		InputSchema: schema,
	})
	s.handlers[name] = handler
}

// HandleRequest processes a single JSON-RPC 2.0 request.
// Returns nil if the request is a notification (no ID).
func (s *Server) HandleRequest(ctx context.Context, req Request) *Response {
	isNotification := len(req.ID) == 0 || string(req.ID) == "null"

	if req.JSONRPC != "2.0" {
		if isNotification {
			return nil
		}
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error: &ErrorObject{
				Code:    ErrCodeInvalidRequest,
				Message: "invalid jsonrpc version; expected \"2.0\"",
			},
		}
	}

	switch req.Method {
	case "notifications/initialized", "notifications/cancelled", "initialized":
		return nil

	case "initialize":
		if isNotification {
			return nil
		}
		protoVer := DefaultProtocolVersion
		var initParams struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		if len(req.Params) > 0 && json.Unmarshal(req.Params, &initParams) == nil {
			if initParams.ProtocolVersion == LatestProtocolVersion || initParams.ProtocolVersion == DefaultProtocolVersion {
				protoVer = initParams.ProtocolVersion
			}
		}
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"protocolVersion": protoVer,
				"capabilities": map[string]interface{}{
					"tools": map[string]interface{}{
						"listChanged": false,
					},
				},
				"serverInfo": map[string]interface{}{
					"name":    "exodeck-mcp",
					"version": s.Version,
				},
			},
		}

	case "ping":
		if isNotification {
			return nil
		}
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  map[string]interface{}{},
		}

	case "tools/list":
		if isNotification {
			return nil
		}
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"tools": s.tools,
			},
		}

	case "resources/list":
		if isNotification {
			return nil
		}
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"resources": []interface{}{},
			},
		}

	case "prompts/list":
		if isNotification {
			return nil
		}
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"prompts": []interface{}{},
			},
		}

	case "tools/call":
		if isNotification {
			return nil
		}
		return s.handleToolCall(ctx, req)

	default:
		if isNotification {
			return nil
		}
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error: &ErrorObject{
				Code:    ErrCodeMethodNotFound,
				Message: fmt.Sprintf("method not found: %s", req.Method),
			},
		}
	}
}

func (s *Server) handleToolCall(ctx context.Context, req Request) *Response {
	var params CallToolParams
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Name == "" {
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error: &ErrorObject{
				Code:    ErrCodeInvalidParams,
				Message: "invalid tools/call params: 'name' is required",
			},
		}
	}

	handler, ok := s.handlers[params.Name]
	if !ok {
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error: &ErrorObject{
				Code:    ErrCodeInvalidParams,
				Message: fmt.Sprintf("unknown tool: %s", params.Name),
			},
		}
	}

	args := params.Arguments
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage(`{}`)
	}

	res, err := handler(ctx, args)
	if err != nil {
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: CallToolResult{
				Content: []ContentBlock{
					{
						Type: "text",
						Text: err.Error(),
					},
				},
				IsError: true,
			},
		}
	}

	var text string
	switch v := res.(type) {
	case string:
		text = v
	default:
		b, marshalErr := json.MarshalIndent(v, "", "  ")
		if marshalErr != nil {
			text = fmt.Sprintf("%v", v)
		} else {
			text = string(b)
		}
	}

	return &Response{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result: CallToolResult{
			Content: []ContentBlock{
				{
					Type: "text",
					Text: text,
				},
			},
		},
	}
}

// Schema builder helpers

func objectSchema(props map[string]interface{}, required ...string) map[string]interface{} {
	if props == nil {
		props = map[string]interface{}{}
	}
	schema := map[string]interface{}{
		"type":       "object",
		"properties": props,
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func stringProp(desc string) map[string]interface{} {
	return map[string]interface{}{
		"type":        "string",
		"description": desc,
	}
}

func stringEnumProp(desc string, enum ...string) map[string]interface{} {
	return map[string]interface{}{
		"type":        "string",
		"description": desc,
		"enum":        enum,
	}
}

func boolProp(desc string) map[string]interface{} {
	return map[string]interface{}{
		"type":        "boolean",
		"description": desc,
	}
}

func intProp(desc string) map[string]interface{} {
	return map[string]interface{}{
		"type":        "integer",
		"description": desc,
	}
}

func arrayProp(desc string, items map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"type":        "array",
		"description": desc,
		"items":       items,
	}
}
