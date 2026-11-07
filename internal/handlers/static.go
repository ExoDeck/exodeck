package handlers

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// serveStatic serves files from the embedded frontend FS.
// Unknown paths fall back to index.html (SPA routing).
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	upath := r.URL.Path
	if !strings.HasPrefix(upath, "/") {
		upath = "/" + upath
	}

	// Clean path to prevent directory traversal
	cleaned := path.Clean(upath)
	fpath := strings.TrimPrefix(cleaned, "/")
	if fpath == "" || fpath == "." {
		fpath = "index.html"
	}

	// Reject paths attempting directory traversal or invalid FS paths
	if !fs.ValidPath(fpath) || strings.HasPrefix(fpath, "..") {
		http.NotFound(w, r)
		return
	}

	// Try to open from frontend sub-FS
	fsys, err := fs.Sub(s.FrontendFS, "frontend")
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	f, err := fsys.Open(fpath)
	if err != nil {
		// Handle preload scanner issues where relative paths are fetched before the <base> tag is applied
		parts := strings.Split(fpath, "/")
		for i := 1; i < len(parts); i++ {
			fallbackPath := path.Clean(strings.Join(parts[i:], "/"))
			if !fs.ValidPath(fallbackPath) || strings.HasPrefix(fallbackPath, "..") {
				continue
			}
			if f2, err2 := fsys.Open(fallbackPath); err2 == nil {
				_ = f2.Close()
				r2 := r.Clone(r.Context())
				r2.URL.Path = "/" + fallbackPath
				http.FileServer(http.FS(fsys)).ServeHTTP(w, r2)
				return
			}
		}

		// SPA fallback: serve index.html for unknown paths
		// (but only for paths without a file extension to avoid masking real 404s)
		if !strings.Contains(fpath, ".") {
			indexHTML, err := fs.ReadFile(fsys, "index.html")
			if err == nil {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.WriteHeader(http.StatusOK)
				writeRaw(w, indexHTML)
				return
			}
		}
		http.NotFound(w, r)
		return
	}
	_ = f.Close()

	r2 := r.Clone(r.Context())
	if fpath == "index.html" && upath == "/" {
		r2.URL.Path = "/"
	} else {
		r2.URL.Path = cleaned
	}
	http.FileServer(http.FS(fsys)).ServeHTTP(w, r2)
}
