package handlers

import (
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/jpeg"
	"image/png"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"golang.org/x/image/draw"

	"github.com/ExoDeck/exodeck/internal/storage"
)

// serveMedia handles requests for static files within the data locations.
func (s *Server) serveMedia(w http.ResponseWriter, r *http.Request) {
	location := r.URL.Query().Get("location")
	_, locPath, status, errMsg := s.Store.ResolveWorkspace(location)
	if status != 0 {
		http.Error(w, errMsg, status)
		return
	}

	subPath := chi.URLParam(r, "*")
	if subPath == "" {
		http.Error(w, "missing file path", http.StatusBadRequest)
		return
	}

	// Prevent directory traversal
	cleanPath := filepath.Clean("/" + subPath)
	fullPath := filepath.Join(locPath, cleanPath)

	if filepath.ToSlash(cleanPath) == "/.icon.svg" {
		w.Header().Set("Cache-Control", "no-cache")
	}

	http.ServeFile(w, r, fullPath)
}

// uploadMedia handles uploading an image to the {slug} subfolder.
func (s *Server) uploadMedia(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")
	_, locPath, status, errMsg := s.Store.ResolveWorkspace(location)
	if status != 0 {
		http.Error(w, errMsg, status)
		return
	}

	if slug == "" || slug == "." || slug == ".." {
		http.Error(w, "invalid slug", http.StatusBadRequest)
		return
	}

	err := r.ParseMultipartForm(10 << 20) // 10MB limit
	if err != nil {
		http.Error(w, "error parsing form: "+err.Error(), http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "no file provided", http.StatusBadRequest)
		return
	}
	defer func() { _ = file.Close() }()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if ext != ".jpg" && ext != ".jpeg" && ext != ".png" && ext != ".gif" {
		http.Error(w, "only .jpg, .jpeg, .png, and .gif are allowed", http.StatusBadRequest)
		return
	}

	filename := storage.SanitizeFilename(filepath.Base(header.Filename))
	fullRes := r.FormValue("full_res") == "true"

	dirPath := filepath.Join(locPath, slug)
	if err := os.MkdirAll(dirPath, 0o755); err != nil {
		http.Error(w, fmt.Sprintf("failed to create directory: %v", err), http.StatusInternalServerError)
		return
	}

	outFile, err := os.Create(filepath.Join(dirPath, filename))
	if err != nil {
		http.Error(w, "failed to save file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer func() { _ = outFile.Close() }()

	if fullRes {
		if _, err := io.Copy(outFile, file); err != nil {
			http.Error(w, "failed to write file: "+err.Error(), http.StatusInternalServerError)
			return
		}
	} else {
		writeOptimizedImage(outFile, file)
	}

	sendJSON(w, map[string]string{
		"filename": filename,
		"url":      fmt.Sprintf("/api/v1/media/%s/%s", slug, filename),
	})
}

// uploadLocationIcon handles uploading an SVG icon to the workspace root.
func (s *Server) uploadLocationIcon(w http.ResponseWriter, r *http.Request) {
	location := r.URL.Query().Get("location")
	_, locPath, status, errMsg := s.Store.ResolveWorkspace(location)
	if status != 0 {
		http.Error(w, errMsg, status)
		return
	}

	err := r.ParseMultipartForm(1 << 20) // 1MB limit for icon
	if err != nil {
		http.Error(w, "error parsing form: "+err.Error(), http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "no file provided", http.StatusBadRequest)
		return
	}
	defer func() { _ = file.Close() }()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if ext != ".svg" {
		http.Error(w, "only .svg is allowed", http.StatusBadRequest)
		return
	}

	outFile, err := os.Create(filepath.Join(locPath, ".icon.svg"))
	if err != nil {
		http.Error(w, "failed to save file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer func() { _ = outFile.Close() }()

	if _, err := io.Copy(outFile, file); err != nil {
		http.Error(w, "failed to write file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	sendJSON(w, map[string]string{
		"status": "ok",
		"url":    fmt.Sprintf("/api/v1/media/.icon.svg?location=%s", location),
	})
}

// deleteLocationIcon removes the .icon.svg for a workspace
func (s *Server) deleteLocationIcon(w http.ResponseWriter, r *http.Request) {
	location := r.URL.Query().Get("location")
	_, locPath, status, errMsg := s.Store.ResolveWorkspace(location)
	if status != 0 {
		http.Error(w, errMsg, status)
		return
	}

	iconPath := filepath.Join(locPath, ".icon.svg")
	err := os.Remove(iconPath)
	if err != nil && !os.IsNotExist(err) {
		http.Error(w, "failed to delete icon: "+err.Error(), http.StatusInternalServerError)
		return
	}

	sendJSON(w, map[string]string{"status": "ok"})
}

// writeOptimizedImage decodes, resizes if necessary, and encodes the image to outFile.
// Falls back to a verbatim copy when decoding or encoding fails.
func writeOptimizedImage(outFile *os.File, file io.ReadSeeker) {
	file.Seek(0, 0) //nolint:errcheck
	img, format, err := image.Decode(file)
	if err != nil {
		file.Seek(0, 0)        //nolint:errcheck
		io.Copy(outFile, file) //nolint:errcheck
		return
	}
	img = resizeImageIfNeeded(img)
	if encodeImage(outFile, img, format) != nil {
		file.Seek(0, 0)        //nolint:errcheck
		outFile.Seek(0, 0)     //nolint:errcheck
		io.Copy(outFile, file) //nolint:errcheck
	}
}

// resizeImageIfNeeded scales img down to fit within 1920×1080, preserving aspect ratio.
func resizeImageIfNeeded(img image.Image) image.Image {
	const maxWidth, maxHeight = 1920, 1080
	bounds := img.Bounds()
	if bounds.Dx() <= maxWidth && bounds.Dy() <= maxHeight {
		return img
	}
	ratio := float64(bounds.Dx()) / float64(bounds.Dy())
	newW, newH := bounds.Dx(), bounds.Dy()
	if newW > maxWidth {
		newW = maxWidth
		newH = int(float64(maxWidth) / ratio)
	}
	if newH > maxHeight {
		newH = maxHeight
		newW = int(float64(maxHeight) * ratio)
	}
	dst := image.NewRGBA(image.Rect(0, 0, newW, newH))
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), img, bounds, draw.Over, nil)
	return dst
}

// encodeImage writes img to w in the given format (png or jpeg).
func encodeImage(w io.Writer, img image.Image, format string) error {
	if format == "png" {
		return png.Encode(w, img)
	}
	// gif loses animation on resize — fall back to jpeg encoding
	return jpeg.Encode(w, img, &jpeg.Options{Quality: 80})
}

// listMedia returns a list of files inside the page's subfolder
func (s *Server) listMedia(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	location := r.URL.Query().Get("location")
	_, locPath, status, errMsg := s.Store.ResolveWorkspace(location)
	if status != 0 {
		http.Error(w, errMsg, status)
		return
	}

	dirPath := filepath.Join(locPath, slug)
	entries, err := os.ReadDir(dirPath)

	type MediaItem struct {
		Filename string `json:"filename"`
		Size     int64  `json:"size"`
	}
	var items []MediaItem

	if err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			info, err := e.Info()
			if err == nil {
				items = append(items, MediaItem{
					Filename: e.Name(),
					Size:     info.Size(),
				})
			}
		}
	}

	if items == nil {
		items = []MediaItem{}
	}

	sendJSON(w, items)
}

// deleteMedia removes a specific file in the subfolder
func (s *Server) deleteMedia(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	filename := chi.URLParam(r, "filename")
	location := r.URL.Query().Get("location")
	_, locPath, status, errMsg := s.Store.ResolveWorkspace(location)
	if status != 0 {
		http.Error(w, errMsg, status)
		return
	}

	cleanFilename := filepath.Base(filename)
	fullPath := filepath.Join(locPath, slug, cleanFilename)

	if err := os.Remove(fullPath); err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		http.Error(w, "failed to delete file", http.StatusInternalServerError)
		return
	}

	sendJSON(w, map[string]string{"status": "deleted"})
}

func sendJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		http.Error(w, fmt.Sprintf("error encoding json: %v", err), http.StatusInternalServerError)
	}
}
