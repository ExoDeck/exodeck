package handlers_test

import (
	"net/http"
	"strings"
	"testing"
)

func TestCORSLocalhostAllowedOrigins(t *testing.T) {
	ts, _, _ := newTestServer(t)

	origins := []string{
		"http://localhost:8000",
		"http://127.0.0.1:6274",
		"http://[::1]:8000",
	}

	for _, origin := range origins {
		// Standard CORS GET
		reqGet, err := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/pages", nil)
		if err != nil {
			t.Fatal(err)
		}
		reqGet.Header.Set("Origin", origin)
		respGet, err := http.DefaultClient.Do(reqGet)
		if err != nil {
			t.Fatal(err)
		}
		_ = respGet.Body.Close()

		if respGet.StatusCode != http.StatusOK {
			t.Errorf("GET with Origin %q: status = %d, want 200", origin, respGet.StatusCode)
		}
		if got := respGet.Header.Get("Access-Control-Allow-Origin"); got != origin {
			t.Errorf("GET with Origin %q: ACAO = %q, want %q", origin, got, origin)
		}

		// CORS Preflight OPTIONS
		reqOpt, err := http.NewRequest(http.MethodOptions, ts.URL+"/api/v1/pages", nil)
		if err != nil {
			t.Fatal(err)
		}
		reqOpt.Header.Set("Origin", origin)
		reqOpt.Header.Set("Access-Control-Request-Method", http.MethodPost)
		respOpt, err := http.DefaultClient.Do(reqOpt)
		if err != nil {
			t.Fatal(err)
		}
		_ = respOpt.Body.Close()

		if respOpt.StatusCode != http.StatusOK && respOpt.StatusCode != http.StatusNoContent {
			t.Errorf("OPTIONS preflight with Origin %q: status = %d, want 200 or 204", origin, respOpt.StatusCode)
		}
		if got := respOpt.Header.Get("Access-Control-Allow-Origin"); got != origin {
			t.Errorf("OPTIONS preflight with Origin %q: ACAO = %q, want %q", origin, got, origin)
		}
	}
}

func TestCORSExternalOriginsRejected(t *testing.T) {
	ts, store, _ := newTestServer(t)

	badOrigins := []string{
		"https://evil.com",
		"http://localhost.evil.com",
		"null",
	}

	for _, origin := range badOrigins {
		// GET
		reqGet, err := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/pages", nil)
		if err != nil {
			t.Fatal(err)
		}
		reqGet.Header.Set("Origin", origin)
		respGet, err := http.DefaultClient.Do(reqGet)
		if err != nil {
			t.Fatal(err)
		}
		_ = respGet.Body.Close()
		if respGet.StatusCode != http.StatusForbidden {
			t.Errorf("GET Origin %q: status = %d, want 403", origin, respGet.StatusCode)
		}
		if got := respGet.Header.Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("GET Origin %q: expected empty ACAO, got %q", origin, got)
		}

		// POST must not mutate state
		reqPost, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/pages", strings.NewReader(`{"page-name":"Pwned"}`))
		if err != nil {
			t.Fatal(err)
		}
		reqPost.Header.Set("Origin", origin)
		reqPost.Header.Set("Content-Type", "application/json")
		respPost, err := http.DefaultClient.Do(reqPost)
		if err != nil {
			t.Fatal(err)
		}
		_ = respPost.Body.Close()
		if respPost.StatusCode != http.StatusForbidden {
			t.Errorf("POST Origin %q: status = %d, want 403", origin, respPost.StatusCode)
		}
		if got := respPost.Header.Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("POST Origin %q: expected empty ACAO, got %q", origin, got)
		}

		// OPTIONS preflight
		reqOpt, err := http.NewRequest(http.MethodOptions, ts.URL+"/api/v1/pages", nil)
		if err != nil {
			t.Fatal(err)
		}
		reqOpt.Header.Set("Origin", origin)
		reqOpt.Header.Set("Access-Control-Request-Method", http.MethodPost)
		respOpt, err := http.DefaultClient.Do(reqOpt)
		if err != nil {
			t.Fatal(err)
		}
		_ = respOpt.Body.Close()
		if respOpt.StatusCode != http.StatusForbidden {
			t.Errorf("OPTIONS Origin %q: status = %d, want 403", origin, respOpt.StatusCode)
		}
		if got := respOpt.Header.Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("OPTIONS Origin %q: expected empty ACAO, got %q", origin, got)
		}
	}

	pages, status, errMsg := store.ListPages("default")
	if status != 0 {
		t.Fatalf("ListPages error: %d %s", status, errMsg)
	}
	if len(pages) != 0 {
		t.Errorf("expected no pages created by rejected external origins, found %d", len(pages))
	}
}

func TestHostHeaderLocalhostValidation(t *testing.T) {
	ts, _, _ := newTestServer(t)

	for _, badHost := range []string{"evil.com:8000", "192.168.1.5:8000", "localhost.evil.com:8000"} {
		req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/pages", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = badHost
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("Host %q: status = %d, want 403", badHost, resp.StatusCode)
		}
	}

	for _, goodHost := range []string{"localhost:8000", "127.0.0.1:8000", "[::1]:8000"} {
		req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/pages", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = goodHost
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("Host %q: status = %d, want 200", goodHost, resp.StatusCode)
		}
	}
}

func TestSecFetchSiteCrossSiteHandling(t *testing.T) {
	ts, _, _ := newTestServer(t)

	blockedCases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/v1/pages", ""},
		{http.MethodGet, "/mcp", ""},
		{http.MethodPost, "/api/v1/pages", `{"page-name":"CSRF"}`},
	}

	for _, tc := range blockedCases {
		var req *http.Request
		var err error
		if tc.body != "" {
			req, err = http.NewRequest(tc.method, ts.URL+tc.path, strings.NewReader(tc.body))
		} else {
			req, err = http.NewRequest(tc.method, ts.URL+tc.path, nil)
		}
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("%s %s with Sec-Fetch-Site=cross-site: status = %d, want 403", tc.method, tc.path, resp.StatusCode)
		}
	}

	// Top-level GET navigation to static frontend should still succeed
	reqNav, err := http.NewRequest(http.MethodGet, ts.URL+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	reqNav.Header.Set("Sec-Fetch-Site", "cross-site")
	respNav, err := http.DefaultClient.Do(reqNav)
	if err != nil {
		t.Fatal(err)
	}
	_ = respNav.Body.Close()
	if respNav.StatusCode != http.StatusOK {
		t.Errorf("GET / with Sec-Fetch-Site=cross-site: status = %d, want 200", respNav.StatusCode)
	}
}

func TestRequestsWithoutOriginNoWildcardACAO(t *testing.T) {
	ts, _, _ := newTestServer(t)

	for _, path := range []string{"/api/v1/pages", "/mcp"} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("GET %s without Origin: status = %d, want 200", path, resp.StatusCode)
		}
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("GET %s without Origin: expected empty ACAO, got %q", path, got)
		}
	}
}
