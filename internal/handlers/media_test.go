package handlers_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestMediaHandlers(t *testing.T) {
	ts, _, dataDir, _ := newTestServerFull(t) // returns ts, store, dataDir, configDir
	client := ts.Client()

	// 1. Upload a file
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "test.png")
	_, _ = part.Write([]byte("fake image data"))
	_ = writer.Close()

	req, _ := http.NewRequest("POST", ts.URL+"/api/v1/pages/test-page/media", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("POST media failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200, got %d. body: %s", resp.StatusCode, string(b))
	}

	var parsedResp map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&parsedResp)
	if parsedResp["filename"] != "test.png" {
		t.Errorf("expected filename 'test.png', got %s", parsedResp["filename"])
	}

	// 2. List media
	respList, err := client.Get(ts.URL + "/api/v1/pages/test-page/media")
	if err != nil || respList.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, GET failed")
	}
	defer func() { _ = respList.Body.Close() }()

	var items []map[string]interface{}
	_ = json.NewDecoder(respList.Body).Decode(&items)
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	if items[0]["filename"] != "test.png" {
		t.Errorf("expected test.png in list, got %v", items[0]["filename"])
	}

	// 3. Serve media
	respServe, err := client.Get(ts.URL + "/api/v1/media/test-page/test.png")
	if err != nil || respServe.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 GET media")
	}
	defer func() { _ = respServe.Body.Close() }()
	serveBody, _ := io.ReadAll(respServe.Body)
	if string(serveBody) != "fake image data" {
		t.Errorf("unexpected content served: %s", string(serveBody))
	}

	// 4. Delete media
	reqDel, _ := http.NewRequest("DELETE", ts.URL+"/api/v1/pages/test-page/media/test.png", nil)
	respDel, err := client.Do(reqDel)
	if err != nil || respDel.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 DELETE media")
	}
	_ = respDel.Body.Close()

	// Verify deletion
	respList2, err := client.Get(ts.URL + "/api/v1/pages/test-page/media")
	if err != nil {
		t.Fatalf("GET media list after deletion: %v", err)
	}
	defer func() { _ = respList2.Body.Close() }()
	var items2 []map[string]interface{}
	_ = json.NewDecoder(respList2.Body).Decode(&items2)
	if len(items2) != 0 {
		t.Errorf("expected 0 items after deletion, got %d", len(items2))
	}

	// Verify file is gone from disk
	if _, err := os.Stat(filepath.Join(dataDir, "test-page", "test.png")); !os.IsNotExist(err) {
		t.Errorf("expected file to be deleted from disk")
	}
}

func TestMediaFilenamesSanitized(t *testing.T) {
	ts, _, dataDir, _ := newTestServerFull(t)
	client := ts.Client()

	testCases := []struct {
		input    string
		expected string
	}{
		{"my image.png", "my-image.png"},
		{"file@name#$%.png", "file-name.png"},
		{"  spaces  everywhere  .jpg", "spaces-everywhere.jpg"},
		{"UPPERCASE.PNG", "uppercase.png"},
		{"test_underscore.gif", "test_underscore.gif"},
		{"multiple   spaces.jpeg", "multiple-spaces.jpeg"},
		{"special!@#$%^&*().png", "special.png"},
	}

	for _, tc := range testCases {
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		part, _ := writer.CreateFormFile("file", tc.input)
		_, _ = part.Write([]byte("fake image data"))
		_ = writer.Close()

		req, _ := http.NewRequest("POST", ts.URL+"/api/v1/pages/test-page/media", body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("POST media failed for %q: %v", tc.input, err)
		}

		var parsedResp map[string]string
		_ = json.NewDecoder(resp.Body).Decode(&parsedResp)
		_ = resp.Body.Close()

		if parsedResp["filename"] != tc.expected {
			t.Errorf("input %q: expected %q, got %q", tc.input, tc.expected, parsedResp["filename"])
		}

		// Verify file exists on disk with sanitized name
		if _, err := os.Stat(filepath.Join(dataDir, "test-page", tc.expected)); os.IsNotExist(err) {
			t.Errorf("sanitized file %q not found on disk for input %q", tc.expected, tc.input)
		}
	}
}

func TestLocationIcon(t *testing.T) {
	ts, _, dataDir, _ := newTestServerFull(t)
	client := ts.Client()

	// 1. Upload .icon.svg
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "test.svg")
	_, _ = part.Write([]byte("<svg>test</svg>"))
	_ = writer.Close()

	req, _ := http.NewRequest("POST", ts.URL+"/api/v1/locations/icon", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("POST icon failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200, got %d. body: %s", resp.StatusCode, string(b))
	}

	// Verify file is on disk
	iconPath := filepath.Join(dataDir, ".icon.svg")
	if _, err := os.Stat(iconPath); os.IsNotExist(err) {
		t.Fatalf("expected .icon.svg to exist on disk")
	}

	// 2. Delete .icon.svg
	reqDel, _ := http.NewRequest("DELETE", ts.URL+"/api/v1/locations/icon", nil)
	respDel, err := client.Do(reqDel)
	if err != nil || respDel.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 DELETE icon")
	}
	_ = respDel.Body.Close()

	// Verify file is gone from disk
	if _, err := os.Stat(iconPath); !os.IsNotExist(err) {
		t.Errorf("expected .icon.svg to be deleted from disk")
	}
}

func TestMediaImageOptimization(t *testing.T) {
	ts, _, _, _ := newTestServerFull(t)
	client := ts.Client()

	// 1. Upload a large PNG (>1920x1080) to trigger resizeImageIfNeeded & encodeImage
	largeImg := image.NewRGBA(image.Rect(0, 0, 2000, 1200))
	pngBuf := &bytes.Buffer{}
	_ = png.Encode(pngBuf, largeImg)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "large.png")
	_, _ = part.Write(pngBuf.Bytes())
	_ = writer.Close()

	req, _ := http.NewRequest("POST", ts.URL+"/api/v1/pages/opt-page/media", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for large PNG upload: %v", err)
	}
	_ = resp.Body.Close()

	// 2. Upload a tall JPEG (>1080) to trigger vertical resize
	tallImg := image.NewRGBA(image.Rect(0, 0, 800, 1500))
	jpegBuf := &bytes.Buffer{}
	_ = jpeg.Encode(jpegBuf, tallImg, &jpeg.Options{Quality: 90})

	body = &bytes.Buffer{}
	writer = multipart.NewWriter(body)
	part, _ = writer.CreateFormFile("file", "tall.jpeg")
	_, _ = part.Write(jpegBuf.Bytes())
	_ = writer.Close()

	req, _ = http.NewRequest("POST", ts.URL+"/api/v1/pages/opt-page/media", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for tall JPEG upload: %v", err)
	}
	_ = resp.Body.Close()
}

func TestMediaEdgeCases(t *testing.T) {
	ts, _, dataDir, _ := newTestServerFull(t)
	client := ts.Client()

	// 1. Upload with full_res=true
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "raw.png")
	_, _ = part.Write([]byte("raw uncompressed bytes"))
	_ = writer.WriteField("full_res", "true")
	_ = writer.Close()

	req, _ := http.NewRequest("POST", ts.URL+"/api/v1/pages/my-page/media", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for full_res upload, got %v %v", resp, err)
	}
	_ = resp.Body.Close()
	rawOnDisk, _ := os.ReadFile(filepath.Join(dataDir, "my-page", "raw.png"))
	if string(rawOnDisk) != "raw uncompressed bytes" {
		t.Errorf("expected uncompressed bytes saved for full_res=true")
	}

	// 2. Upload with invalid extension
	body = &bytes.Buffer{}
	writer = multipart.NewWriter(body)
	part, _ = writer.CreateFormFile("file", "bad.exe")
	_, _ = part.Write([]byte("bad"))
	_ = writer.Close()
	req, _ = http.NewRequest("POST", ts.URL+"/api/v1/pages/my-page/media", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for bad extension, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 3. Upload with invalid slug
	body = &bytes.Buffer{}
	writer = multipart.NewWriter(body)
	part, _ = writer.CreateFormFile("file", "test.png")
	_, _ = part.Write([]byte("img"))
	_ = writer.Close()
	req, _ = http.NewRequest("POST", ts.URL+"/api/v1/pages/../media", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid slug, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 4. Upload with no file in multipart form
	body = &bytes.Buffer{}
	writer = multipart.NewWriter(body)
	_ = writer.Close()
	req, _ = http.NewRequest("POST", ts.URL+"/api/v1/pages/my-page/media", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for missing file, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 5. Upload icon with non-svg
	body = &bytes.Buffer{}
	writer = multipart.NewWriter(body)
	part, _ = writer.CreateFormFile("file", "icon.png")
	_, _ = part.Write([]byte("not svg"))
	_ = writer.Close()
	req, _ = http.NewRequest("POST", ts.URL+"/api/v1/locations/icon", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for non-svg icon, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 6. Delete media not found
	req, _ = http.NewRequest("DELETE", ts.URL+"/api/v1/pages/my-page/media/nonexistent.png", nil)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for deleting non-existent media, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 7. Invalid workspace location on endpoints
	resp, _ = client.Get(ts.URL + "/api/v1/media/my-page/test.png?location=invalid")
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid location on serveMedia, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 8. Serve media /.icon.svg sets Cache-Control: no-cache
	_ = os.WriteFile(filepath.Join(dataDir, ".icon.svg"), []byte("<svg></svg>"), 0o644)
	resp, err = client.Get(ts.URL + "/api/v1/media/.icon.svg")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for serveMedia /.icon.svg: %v", err)
	}
	if resp.Header.Get("Cache-Control") != "no-cache" {
		t.Errorf("expected Cache-Control: no-cache for /.icon.svg, got %q", resp.Header.Get("Cache-Control"))
	}
	_ = resp.Body.Close()

	// 9. Upload GIF image (exercises GIF handling / JPEG fallback in encodeImage)
	gifBytes := []byte("GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;")
	body = &bytes.Buffer{}
	writer = multipart.NewWriter(body)
	part, _ = writer.CreateFormFile("file", "anim.gif")
	_, _ = part.Write(gifBytes)
	_ = writer.Close()
	req, _ = http.NewRequest("POST", ts.URL+"/api/v1/pages/my-page/media", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for GIF upload: %v", err)
	}
	_ = resp.Body.Close()

	// 10. uploadMedia with invalid location
	body = &bytes.Buffer{}
	writer = multipart.NewWriter(body)
	part, _ = writer.CreateFormFile("file", "test.png")
	_, _ = part.Write([]byte("data"))
	_ = writer.Close()
	req, _ = http.NewRequest("POST", ts.URL+"/api/v1/pages/my-page/media?location=invalid-loc", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for uploadMedia with invalid location, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 11. uploadMedia with broken multipart form
	req, _ = http.NewRequest("POST", ts.URL+"/api/v1/pages/my-page/media", bytes.NewReader([]byte("not-multipart")))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=missing-boundary")
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for broken multipart upload, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 12. uploadLocationIcon with invalid location
	body = &bytes.Buffer{}
	writer = multipart.NewWriter(body)
	part, _ = writer.CreateFormFile("file", "icon.svg")
	_, _ = part.Write([]byte("<svg></svg>"))
	_ = writer.Close()
	req, _ = http.NewRequest("POST", ts.URL+"/api/v1/locations/icon?location=invalid-loc", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for uploadLocationIcon with invalid location, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 13. uploadLocationIcon with missing file
	body = &bytes.Buffer{}
	writer = multipart.NewWriter(body)
	_ = writer.Close()
	req, _ = http.NewRequest("POST", ts.URL+"/api/v1/locations/icon", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for uploadLocationIcon missing file, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 14. uploadLocationIcon with broken multipart
	req, _ = http.NewRequest("POST", ts.URL+"/api/v1/locations/icon", bytes.NewReader([]byte("broken")))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=bad")
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for uploadLocationIcon broken multipart, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 15. deleteLocationIcon with invalid location
	req, _ = http.NewRequest("DELETE", ts.URL+"/api/v1/locations/icon?location=invalid-loc", nil)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for deleteLocationIcon invalid location, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 16. listMedia with invalid location
	resp, _ = client.Get(ts.URL + "/api/v1/pages/my-page/media?location=invalid-loc")
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for listMedia invalid location, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// 17. listMedia with subdirectory inside page dir (should be skipped)
	subDirPath := filepath.Join(dataDir, "my-page", "nested-subdir")
	_ = os.MkdirAll(subDirPath, 0o755)
	respListSub, err := client.Get(ts.URL + "/api/v1/pages/my-page/media")
	if err != nil || respListSub.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for listMedia with subdir: %v", err)
	}
	defer func() { _ = respListSub.Body.Close() }()
	var listedItems []map[string]interface{}
	_ = json.NewDecoder(respListSub.Body).Decode(&listedItems)
	for _, it := range listedItems {
		if it["filename"] == "nested-subdir" {
			t.Errorf("expected subdirectory to be skipped in listMedia, but found it")
		}
	}

	// 18. deleteMedia with invalid location
	req, _ = http.NewRequest("DELETE", ts.URL+"/api/v1/pages/my-page/media/test.png?location=invalid-loc", nil)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for deleteMedia with invalid location, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
}
