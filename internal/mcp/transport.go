package mcp

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
)

const maxStdioMessageSize = 16 * 1024 * 1024 // 16 MB

// ServeHTTP handles MCP requests over Streamable HTTP (POST/GET/DELETE /mcp)
// as well as legacy HTTP+SSE (GET /mcp/sse, POST /mcp/message?sessionId=...).
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Access-Control-Expose-Headers", "Mcp-Session-Id")

	switch r.Method {
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
		return

	case http.MethodDelete:
		sessionID := r.Header.Get("Mcp-Session-Id")
		if sessionID == "" {
			sessionID = r.URL.Query().Get("sessionId")
		}
		if sessionID != "" {
			s.sseSessions.Delete(sessionID)
		}
		w.WriteHeader(http.StatusOK)
		return

	case http.MethodGet:
		accept := r.Header.Get("Accept")
		if strings.HasSuffix(r.URL.Path, "/sse") || strings.Contains(accept, "text/event-stream") {
			s.handleSSE(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"name":      "exodeck-mcp",
			"version":   s.Version,
			"status":    "ok",
			"transport": "streamable-http",
			"tools":     len(s.tools),
		})
		return

	case http.MethodPost:
		s.handleHTTPPost(w, r)
		return

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	sessionID := generateSessionID()
	msgCh := make(chan []byte, 32)
	s.sseSessions.Store(sessionID, msgCh)
	defer s.sseSessions.Delete(sessionID)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Mcp-Session-Id", sessionID)
	w.WriteHeader(http.StatusOK)

	basePath := strings.TrimSuffix(r.URL.Path, "/sse")
	if basePath == "" {
		basePath = "/mcp"
	}
	endpointURL := fmt.Sprintf("%s?sessionId=%s", basePath, sessionID)
	_, _ = fmt.Fprintf(w, "event: endpoint\ndata: %s\n\n", endpointURL)
	flusher.Flush()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, open := <-msgCh:
			if !open {
				return
			}
			_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n\n", string(msg))
			flusher.Flush()
		}
	}
}

func (s *Server) handleHTTPPost(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxStdioMessageSize))
	if err != nil {
		writeJSONRPCError(w, nil, ErrCodeParseError, "failed to read request body")
		return
	}

	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		writeJSONRPCError(w, nil, ErrCodeInvalidRequest, "empty request body")
		return
	}

	sessionID := r.URL.Query().Get("sessionId")
	if sessionID == "" {
		sessionID = r.Header.Get("Mcp-Session-Id")
	}

	// Check if batch request
	if trimmed[0] == '[' {
		var reqs []Request
		if err := json.Unmarshal(trimmed, &reqs); err != nil || len(reqs) == 0 {
			writeJSONRPCError(w, nil, ErrCodeParseError, "invalid JSON-RPC batch")
			return
		}
		var resps []*Response
		for _, req := range reqs {
			if resp := s.HandleRequest(r.Context(), req); resp != nil {
				resps = append(resps, resp)
			}
		}
		if len(resps) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		payload, _ := json.Marshal(resps)
		s.forwardToSSESession(sessionID, payload)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
		return
	}

	var req Request
	if err := json.Unmarshal(trimmed, &req); err != nil {
		writeJSONRPCError(w, nil, ErrCodeParseError, "invalid JSON: "+err.Error())
		return
	}

	resp := s.HandleRequest(r.Context(), req)
	if resp == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}

	payload, _ := json.Marshal(resp)
	s.forwardToSSESession(sessionID, payload)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload)
}

func (s *Server) forwardToSSESession(sessionID string, payload []byte) {
	if sessionID == "" {
		return
	}
	if chAny, ok := s.sseSessions.Load(sessionID); ok {
		if ch, ok := chAny.(chan []byte); ok {
			select {
			case ch <- payload:
			default:
			}
		}
	}
}

func writeJSONRPCError(w http.ResponseWriter, id json.RawMessage, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	resp := Response{
		JSONRPC: "2.0",
		ID:      id,
		Error: &ErrorObject{
			Code:    code,
			Message: message,
		},
	}
	_ = json.NewEncoder(w).Encode(resp)
}

func generateSessionID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ServeStdio runs the MCP server over newline-delimited JSON-RPC 2.0 on in/out.
func (s *Server) ServeStdio(ctx context.Context, in io.Reader, out io.Writer) error {
	scanner := bufio.NewScanner(in)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, maxStdioMessageSize)

	var writeMu sync.Mutex
	writeLine := func(data []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		if _, err := out.Write(append(data, '\n')); err != nil {
			return err
		}
		return nil
	}

	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}

		if line[0] == '[' {
			var reqs []Request
			if err := json.Unmarshal(line, &reqs); err != nil || len(reqs) == 0 {
				errResp, _ := json.Marshal(Response{
					JSONRPC: "2.0",
					Error: &ErrorObject{
						Code:    ErrCodeParseError,
						Message: "invalid JSON-RPC batch",
					},
				})
				_ = writeLine(errResp)
				continue
			}
			var resps []*Response
			for _, req := range reqs {
				if resp := s.HandleRequest(ctx, req); resp != nil {
					resps = append(resps, resp)
				}
			}
			if len(resps) > 0 {
				outBytes, _ := json.Marshal(resps)
				_ = writeLine(outBytes)
			}
			continue
		}

		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			errResp, _ := json.Marshal(Response{
				JSONRPC: "2.0",
				Error: &ErrorObject{
					Code:    ErrCodeParseError,
					Message: "parse error: " + err.Error(),
				},
			})
			_ = writeLine(errResp)
			continue
		}

		resp := s.HandleRequest(ctx, req)
		if resp != nil {
			outBytes, _ := json.Marshal(resp)
			if err := writeLine(outBytes); err != nil {
				return err
			}
		}
	}

	return scanner.Err()
}
