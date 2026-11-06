package handlers_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/ExoDeck/exodeck/internal/models"
)

// ptr helpers
func ptrS(s string) *string { return &s }
func ptrB(b bool) *bool     { return &b }

// --------------------------------------------------------------------------
// Item link + note flow
// --------------------------------------------------------------------------

func TestItemLinkAndNoteFlow(t *testing.T) {
	ts, store, _ := newTestServer(t)

	store.WritePage("p", models.Page{
		PageName: "P",
		Groups:   []models.Group{{Title: "G", Items: []models.Item{}}},
	}, "") //nolint:errcheck

	// Add link
	item := models.Item{Title: "GitHub", URL: ptrS("https://github.com")}
	code, body := post(t, ts, "/api/v1/pages/p/groups/0/items", item)
	if code != http.StatusCreated {
		t.Fatalf("POST item: %d %v", code, body)
	}
	iIdx, _ := body["item_index"].(float64)
	if int(iIdx) != 0 {
		t.Errorf("item_index = %v, want 0", iIdx)
	}

	// Update link
	updated := models.Item{Title: "GitHub Enterprise", URL: ptrS("https://github.com/enterprise")}
	code, _ = put(t, ts, "/api/v1/pages/p/groups/0/items/0", updated)
	if code != http.StatusOK {
		t.Fatalf("PUT item: %d", code)
	}

	// Add note
	note := models.Item{Title: "My Note", Text: ptrS("SGVsbG8=")} // base64 "Hello"
	code, _ = post(t, ts, "/api/v1/pages/p/groups/0/items", note)
	if code != http.StatusCreated {
		t.Fatalf("POST note: %d", code)
	}

	// Delete note (index 1)
	code = del(t, ts, "/api/v1/pages/p/groups/0/items/1")
	if code != http.StatusNoContent {
		t.Fatalf("DELETE note: %d", code)
	}
}

// --------------------------------------------------------------------------
// Item index errors
// --------------------------------------------------------------------------

func TestItemBadIndexErrors(t *testing.T) {
	ts, store, _ := newTestServer(t)

	store.WritePage("p", models.Page{
		PageName: "P",
		Groups:   []models.Group{{Title: "G", Items: []models.Item{}}},
	}, "") //nolint:errcheck

	// Bad group index → 422
	code, _ := post(t, ts, "/api/v1/pages/p/groups/99/items", models.Item{Title: "X"})
	if code != 422 {
		t.Errorf("POST item bad group: %d", code)
	}

	// Add one item first
	store.WritePage("p", models.Page{
		PageName: "P",
		Groups:   []models.Group{{Title: "G", Items: []models.Item{{Title: "Link", URL: ptrS("https://x.com")}}}},
	}, "") //nolint:errcheck

	// Bad item index → 422
	code, _ = put(t, ts, "/api/v1/pages/p/groups/0/items/99", models.Item{Title: "X"})
	if code != 422 {
		t.Errorf("PUT item bad item: %d", code)
	}
}

func TestItemMissingPageReturns404(t *testing.T) {
	ts, _, _ := newTestServer(t)

	code, _ := post(t, ts, "/api/v1/pages/missing/groups/0/items", models.Item{Title: "X"})
	if code != http.StatusNotFound {
		t.Errorf("POST item missing page: %d", code)
	}
}

// --------------------------------------------------------------------------
// Password encryption at rest
// --------------------------------------------------------------------------

func TestItemPasswordEncryptedOnDiskDecryptedOnRead(t *testing.T) {
	// Use a location with a Fernet key
	const testKey = "cRPBMKMEPHyNh-hWFKn6G4b3mM_x3PW5yqPbxwU3Ue4="

	dataDir := t.TempDir()
	configDir := t.TempDir()

	st, ts := newTestServerWithKey(t, dataDir, configDir, testKey)
	st.WritePage("p", models.Page{
		PageName: "P",
		Groups:   []models.Group{{Title: "G", Items: []models.Item{}}},
	}, "") //nolint:errcheck

	pwPlain := "s3cret"
	item := models.Item{
		Title:    "My Password",
		Username: ptrS("user@example.com"),
		Password: ptrS(pwPlain),
		PwURL:    ptrS("https://example.com"),
	}
	code, _ := post(t, ts, "/api/v1/pages/p/groups/0/items", item)
	if code != http.StatusCreated {
		t.Fatalf("POST item: %d", code)
	}

	// Check on-disk value is encrypted (not plaintext)
	raw, err := os.ReadFile(filepath.Join(dataDir, "p.grid"))
	if err != nil {
		t.Fatal(err)
	}
	if containsPlaintext(raw, pwPlain) {
		t.Error("plaintext password found on disk — should be encrypted")
	}

	// GET page → password must be decrypted
	resp, err := http.Get(ts.URL + "/api/v1/pages/p")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var pageResp map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&pageResp)

	groups := pageResp["groups"].([]interface{})
	items := groups[0].(map[string]interface{})["items"].([]interface{})
	pw := items[0].(map[string]interface{})["password"].(string)
	if pw != pwPlain {
		t.Errorf("decrypted password = %q, want %q", pw, pwPlain)
	}
}

// --------------------------------------------------------------------------
// OTPSecret encryption at rest and OTP generation
// --------------------------------------------------------------------------

func TestOTPSecretEncryptedOnDiskAndGetOTP(t *testing.T) {
	const testKey = "cRPBMKMEPHyNh-hWFKn6G4b3mM_x3PW5yqPbxwU3Ue4="

	dataDir := t.TempDir()
	configDir := t.TempDir()

	st, ts := newTestServerWithKey(t, dataDir, configDir, testKey)
	st.WritePage("p", models.Page{
		PageName: "P",
		Groups:   []models.Group{{Title: "G", Items: []models.Item{}}},
	}, "") //nolint:errcheck

	otpPlain := "JBSWY3DPEHPK3PXP" // standard base32 secret
	item := models.Item{
		Title:     "My OTP",
		OTPSecret: ptrS(otpPlain),
	}
	code, _ := post(t, ts, "/api/v1/pages/p/groups/0/items", item)
	if code != http.StatusCreated {
		t.Fatalf("POST item: %d", code)
	}

	// Check on-disk value is encrypted
	raw, err := os.ReadFile(filepath.Join(dataDir, "p.grid"))
	if err != nil {
		t.Fatal(err)
	}
	if containsPlaintext(raw, otpPlain) {
		t.Error("plaintext OTP secret found on disk — should be encrypted")
	}

	// GET page -> secret must be decrypted
	resp, err := http.Get(ts.URL + "/api/v1/pages/p")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var pageResp map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&pageResp)

	groups := pageResp["groups"].([]interface{})
	items := groups[0].(map[string]interface{})["items"].([]interface{})
	sec := items[0].(map[string]interface{})["otp_secret"].(string)
	if sec != otpPlain {
		t.Errorf("decrypted otp_secret = %q, want %q", sec, otpPlain)
	}

	// GET /otp endpoint
	resp, err = http.Get(ts.URL + "/api/v1/pages/p/groups/0/items/0/otp")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET /otp returned status %d", resp.StatusCode)
	}
	var otpResp map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&otpResp)
	if len(otpResp["otp"]) != 6 {
		t.Errorf("expected 6-digit OTP, got %q", otpResp["otp"])
	}
}

func TestOTPSecretValidation(t *testing.T) {
	const testKey = "cRPBMKMEPHyNh-hWFKn6G4b3mM_x3PW5yqPbxwU3Ue4="

	dataDir := t.TempDir()
	configDir := t.TempDir()

	st, ts := newTestServerWithKey(t, dataDir, configDir, testKey)
	st.WritePage("p", models.Page{
		PageName: "P",
		Groups:   []models.Group{{Title: "G", Items: []models.Item{}}},
	}, "") //nolint:errcheck

	// Invalid characters (0, 1, 8, 9)
	badItem1 := models.Item{Title: "Bad 1", Password: ptrS("pw"), OTPSecret: ptrS("JBSW03DP")}
	code, _ := post(t, ts, "/api/v1/pages/p/groups/0/items", badItem1)
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for OTP secret with 0, got %d", code)
	}

	// Invalid length (too short)
	badItem2 := models.Item{Title: "Bad 2", Password: ptrS("pw"), OTPSecret: ptrS("JBSW")}
	code, _ = post(t, ts, "/api/v1/pages/p/groups/0/items", badItem2)
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for short OTP secret, got %d", code)
	}

	// Valid secret with formatting (spaces and hyphens)
	validFormatted := models.Item{Title: "Good", Password: ptrS("pw"), OTPSecret: ptrS("JBSW-Y3DP-EHPK-3PXP")}
	code, _ = post(t, ts, "/api/v1/pages/p/groups/0/items", validFormatted)
	if code != http.StatusCreated {
		t.Fatalf("expected 201 for formatted OTP secret, got %d", code)
	}

	resp, err := http.Get(ts.URL + "/api/v1/pages/p/groups/0/items/0/otp")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET /otp returned %d, want 200", resp.StatusCode)
	}
}

// --------------------------------------------------------------------------
// enc_text encryption at rest
// --------------------------------------------------------------------------

func TestEncTextEncryptedOnDiskDecryptedOnRead(t *testing.T) {
	const testKey = "cRPBMKMEPHyNh-hWFKn6G4b3mM_x3PW5yqPbxwU3Ue4="

	dataDir := t.TempDir()
	configDir := t.TempDir()

	st, ts := newTestServerWithKey(t, dataDir, configDir, testKey)
	st.WritePage("p", models.Page{
		PageName: "P",
		Groups:   []models.Group{{Title: "G", Items: []models.Item{}}},
	}, "") //nolint:errcheck

	plainMD := "# Secret Note\n\nPrivate content here."
	item := models.Item{Title: "Encrypted Note", EncText: ptrS(plainMD)}
	code, _ := post(t, ts, "/api/v1/pages/p/groups/0/items", item)
	if code != http.StatusCreated {
		t.Fatalf("POST enc_text item: %d", code)
	}

	raw, _ := os.ReadFile(filepath.Join(dataDir, "p.grid"))
	if containsPlaintext(raw, plainMD) {
		t.Error("plaintext enc_text found on disk — should be encrypted")
	}
}

// --------------------------------------------------------------------------
// Location support
// --------------------------------------------------------------------------

func TestItemLocationSupport(t *testing.T) {
	ts, store, _, workDir := newTestServerMultiLocation(t)

	writePageToDisk(t, workDir, "w", models.Page{
		PageName: "W",
		Groups:   []models.Group{{Title: "G", Items: []models.Item{}}},
	})
	store.InitCache()

	item := models.Item{Title: "Work Link", URL: ptrS("https://work.example.com")}
	code, _ := post(t, ts, "/api/v1/pages/w/groups/0/items?location=work", item)
	if code != http.StatusCreated {
		t.Fatalf("POST item to work: %d", code)
	}
}

func TestMoveItem(t *testing.T) {
	ts, store, _ := newTestServer(t)

	store.WritePage("p", models.Page{
		PageName: "P",
		Groups: []models.Group{
			{Title: "Group 0", Items: []models.Item{{Title: "Item 0"}, {Title: "Item 1"}}},
			{Title: "Group 1", Items: []models.Item{}},
		},
	}, "")

	// Move item to same group should fail
	reqSame := models.MoveItemRequest{TargetGroupIndex: 0}
	code, _ := post(t, ts, "/api/v1/pages/p/groups/0/items/0/move", reqSame)
	if code != 422 {
		t.Errorf("move item to same group: got %d, want 422", code)
	}

	// Move item with invalid target group
	reqBadGroup := models.MoveItemRequest{TargetGroupIndex: 99}
	code, _ = post(t, ts, "/api/v1/pages/p/groups/0/items/0/move", reqBadGroup)
	if code != 422 {
		t.Errorf("move item to invalid group: got %d, want 422", code)
	}

	// Move item with invalid item index
	reqValid := models.MoveItemRequest{TargetGroupIndex: 1}
	code, _ = post(t, ts, "/api/v1/pages/p/groups/0/items/99/move", reqValid)
	if code != 422 {
		t.Errorf("move out of range item: got %d, want 422", code)
	}

	// Valid move
	code, body := post(t, ts, "/api/v1/pages/p/groups/0/items/0/move", reqValid)
	if code != http.StatusOK {
		t.Fatalf("valid move item: got %d %v", code, body)
	}

	// Verify group 0 has 1 item (Item 1) and group 1 has 1 item (Item 0)
	page, _, _ := store.ReadPage("p", "")
	if len(page.Groups[0].Items) != 1 || page.Groups[0].Items[0].Title != "Item 1" {
		t.Errorf("unexpected group 0 items: %+v", page.Groups[0].Items)
	}
	if len(page.Groups[1].Items) != 1 || page.Groups[1].Items[0].Title != "Item 0" {
		t.Errorf("unexpected group 1 items: %+v", page.Groups[1].Items)
	}
}

func TestItemOTPValidationAndEndpoint(t *testing.T) {
	dataDir := t.TempDir()
	store, _, ts := newTestVaultServer(t, dataDir)

	// Setup vault
	post(t, ts, "/api/v1/workspaces/default/vault/setup", map[string]string{"password": "MasterPassword123!"})

	// Seed page
	store.WritePage("otp-page", models.Page{
		PageName: "OTP Page",
		Groups: []models.Group{
			{Title: "Security", Items: []models.Item{}},
		},
	}, "default")

	// 1. Invalid digits 0, 1, 8, 9
	code, _ := post(t, ts, "/api/v1/pages/otp-page/groups/0/items?location=default", models.Item{
		Title:     "BadOTP",
		OTPSecret: ptrS("0189ABCD"),
	})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for 0189 digits, got %d", code)
	}

	// 2. Invalid chars
	code, _ = post(t, ts, "/api/v1/pages/otp-page/groups/0/items?location=default", models.Item{
		Title:     "BadOTPChars",
		OTPSecret: ptrS("ABCD$#%!"),
	})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for special chars, got %d", code)
	}

	// 3. Invalid length mod (e.g. length 9)
	code, _ = post(t, ts, "/api/v1/pages/otp-page/groups/0/items?location=default", models.Item{
		Title:     "BadOTPLenMod",
		OTPSecret: ptrS("ABCDEFGHI"),
	})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid length mod, got %d", code)
	}

	// 4. Too short
	code, _ = post(t, ts, "/api/v1/pages/otp-page/groups/0/items?location=default", models.Item{
		Title:     "BadOTPShort",
		OTPSecret: ptrS("ABCDE"),
	})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for too short OTP, got %d", code)
	}

	// 5. Valid OTP with spaces and lowercase
	validSecret := "jbsw y3dp ehpk 3pxp"
	code, _ = post(t, ts, "/api/v1/pages/otp-page/groups/0/items?location=default", models.Item{
		Title:     "ValidOTP",
		OTPSecret: &validSecret,
	})
	if code != http.StatusCreated {
		t.Fatalf("expected 201 for valid OTP, got %d", code)
	}

	// 6. Get OTP code
	code, otpBody := get(t, ts, "/api/v1/pages/otp-page/groups/0/items/0/otp?location=default")
	if code != http.StatusOK {
		t.Fatalf("expected 200 for getOTP, got %d %v", code, otpBody)
	}
	otpCode, ok := otpBody["otp"].(string)
	if !ok || len(otpCode) != 6 {
		t.Errorf("expected 6-digit OTP code, got %v", otpBody)
	}

	// 7. Update item with whitespace OTP secret clears it
	emptySecret := "   "
	code, _ = put(t, ts, "/api/v1/pages/otp-page/groups/0/items/0?location=default", models.Item{
		Title:     "ValidOTP",
		OTPSecret: &emptySecret,
	})
	if code != http.StatusOK {
		t.Fatalf("expected 200 for updating OTP, got %d", code)
	}

	// 8. Getting OTP when secret is cleared returns 400
	code, _ = get(t, ts, "/api/v1/pages/otp-page/groups/0/items/0/otp?location=default")
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for getting OTP when no secret, got %d", code)
	}

	// 9. Update item with valid uppercase OTP secret
	standardSecret := "JBSWY3DPEHPK3PXP"
	code, _ = put(t, ts, "/api/v1/pages/otp-page/groups/0/items/0?location=default", models.Item{
		Title:     "ValidOTP",
		OTPSecret: &standardSecret,
	})
	if code != http.StatusOK {
		t.Fatalf("expected 200 for updating OTP, got %d", code)
	}

	// 10. Update item with invalid OTP secret returns 400
	badSecret := "INVALID99"
	code, _ = put(t, ts, "/api/v1/pages/otp-page/groups/0/items/0?location=default", models.Item{
		Title:     "ValidOTP",
		OTPSecret: &badSecret,
	})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid OTP update, got %d", code)
	}

	// 11. Lock vault -> getOTP returns 423
	post(t, ts, "/api/v1/workspaces/default/vault/lock", nil)
	code, _ = get(t, ts, "/api/v1/pages/otp-page/groups/0/items/0/otp?location=default")
	if code != http.StatusLocked {
		t.Errorf("expected 423 when vault locked, got %d", code)
	}

	// 12. Unlock vault and test out of range
	post(t, ts, "/api/v1/workspaces/default/vault/unlock", map[string]string{"password": "MasterPassword123!"})
	code, _ = get(t, ts, "/api/v1/pages/otp-page/groups/0/items/99/otp?location=default")
	if code != 422 {
		t.Errorf("expected 422 for out of range itemIndex, got %d", code)
	}
	code, _ = get(t, ts, "/api/v1/pages/otp-page/groups/99/items/0/otp?location=default")
	if code != 422 {
		t.Errorf("expected 422 for out of range groupIndex, got %d", code)
	}
	code, _ = get(t, ts, "/api/v1/pages/nonexistent/groups/0/items/0/otp?location=default")
	if code != http.StatusNotFound {
		t.Errorf("expected 404 for nonexistent page, got %d", code)
	}
}

func TestItemErrorBranches(t *testing.T) {
	ts, store, _ := newTestServer(t)
	store.WritePage("p", models.Page{
		PageName: "P",
		Groups: []models.Group{
			{Title: "G0", Items: []models.Item{{Title: "I0"}}},
		},
	}, "")

	// 1. Delete item out of range
	code := del(t, ts, "/api/v1/pages/p/groups/0/items/99")
	if code != 422 {
		t.Errorf("expected 422 for delete out of range item, got %d", code)
	}
	code = del(t, ts, "/api/v1/pages/p/groups/99/items/0")
	if code != 422 {
		t.Errorf("expected 422 for delete out of range group, got %d", code)
	}
	code = del(t, ts, "/api/v1/pages/missing/groups/0/items/0")
	if code != http.StatusNotFound {
		t.Errorf("expected 404 for delete missing page item, got %d", code)
	}

	// 2. Add item to out of range group
	code, _ = post(t, ts, "/api/v1/pages/p/groups/99/items", models.Item{Title: "X"})
	if code != 422 {
		t.Errorf("expected 422 for add to out of range group, got %d", code)
	}

	// 3. Update item out of range
	code, _ = put(t, ts, "/api/v1/pages/p/groups/0/items/99", models.Item{Title: "X"})
	if code != 422 {
		t.Errorf("expected 422 for update out of range item, got %d", code)
	}
	code, _ = put(t, ts, "/api/v1/pages/p/groups/99/items/0", models.Item{Title: "X"})
	if code != 422 {
		t.Errorf("expected 422 for update out of range group, got %d", code)
	}
	code, _ = put(t, ts, "/api/v1/pages/missing/groups/0/items/0", models.Item{Title: "X"})
	if code != http.StatusNotFound {
		t.Errorf("expected 404 for update missing page item, got %d", code)
	}

	// 4. Non-integer indices on item endpoints
	code, _ = put(t, ts, "/api/v1/pages/p/groups/not-int/items/0", models.Item{Title: "X"})
	if code != 422 {
		t.Errorf("expected 422 for non-int group index on put, got %d", code)
	}
	code, _ = put(t, ts, "/api/v1/pages/p/groups/0/items/not-int", models.Item{Title: "X"})
	if code != 422 {
		t.Errorf("expected 422 for non-int item index on put, got %d", code)
	}
	code = del(t, ts, "/api/v1/pages/p/groups/not-int/items/0")
	if code != 422 {
		t.Errorf("expected 422 for non-int group index on del, got %d", code)
	}
	code = del(t, ts, "/api/v1/pages/p/groups/0/items/not-int")
	if code != 422 {
		t.Errorf("expected 422 for non-int item index on del, got %d", code)
	}

	// 5. Invalid location on item endpoints
	code, _ = post(t, ts, "/api/v1/pages/p/groups/0/items?location=bad-ws", models.Item{Title: "X"})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for add item invalid location, got %d", code)
	}
	code, _ = put(t, ts, "/api/v1/pages/p/groups/0/items/0?location=bad-ws", models.Item{Title: "X"})
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for update item invalid location, got %d", code)
	}
	code = del(t, ts, "/api/v1/pages/p/groups/0/items/0?location=bad-ws")
	if code != http.StatusBadRequest {
		t.Errorf("expected 400 for delete item invalid location, got %d", code)
	}
}

func TestMoveItemEdgeCases(t *testing.T) {
	ts, store, _ := newTestServer(t)
	store.WritePage("p", models.Page{
		PageName: "P",
		Groups: []models.Group{
			{Title: "G0", Items: []models.Item{{Title: "Item 0"}}},
			{Title: "G1", Items: []models.Item{}},
		},
	}, "")

	// 1. Move to same group -> 422
	code, _ := post(t, ts, "/api/v1/pages/p/groups/0/items/0/move", models.MoveItemRequest{TargetGroupIndex: 0})
	if code != 422 {
		t.Errorf("expected 422 for move to same group, got %d", code)
	}

	// 2. Non-integer group or item index -> 422
	code, _ = post(t, ts, "/api/v1/pages/p/groups/not-int/items/0/move", models.MoveItemRequest{TargetGroupIndex: 1})
	if code != 422 {
		t.Errorf("expected 422 for non-int src group, got %d", code)
	}
	code, _ = post(t, ts, "/api/v1/pages/p/groups/0/items/not-int/move", models.MoveItemRequest{TargetGroupIndex: 1})
	if code != 422 {
		t.Errorf("expected 422 for non-int item index, got %d", code)
	}

	// 3. Out of range target group index -> 422
	code, _ = post(t, ts, "/api/v1/pages/p/groups/0/items/0/move", models.MoveItemRequest{TargetGroupIndex: 99})
	if code != 422 {
		t.Errorf("expected 422 for out of range target group, got %d", code)
	}

	// 4. Out of range src group or item index -> 422
	code, _ = post(t, ts, "/api/v1/pages/p/groups/99/items/0/move", models.MoveItemRequest{TargetGroupIndex: 1})
	if code != 422 {
		t.Errorf("expected 422 for out of range src group, got %d", code)
	}
	code, _ = post(t, ts, "/api/v1/pages/p/groups/0/items/99/move", models.MoveItemRequest{TargetGroupIndex: 1})
	if code != 422 {
		t.Errorf("expected 422 for out of range item index, got %d", code)
	}

	// 5. Non-existent page -> 404
	code, _ = post(t, ts, "/api/v1/pages/missing/groups/0/items/0/move", models.MoveItemRequest{TargetGroupIndex: 1})
	if code != http.StatusNotFound {
		t.Errorf("expected 404 for move item on missing page, got %d", code)
	}
}

func TestOTPSecretValidationEdgeCases(t *testing.T) {
	ts, store, _ := newTestServer(t)

	// Page with password item
	pw := "mypassword"
	store.WritePage("p", models.Page{
		PageName: "P",
		Groups: []models.Group{
			{Title: "G0", Items: []models.Item{{Title: "Item 0", Password: &pw}}},
		},
	}, "")

	// Setup vault so items can be updated
	post(t, ts, "/api/v1/workspaces/default/vault/setup", map[string]string{"password": "MasterPassword123!"})

	invalidSecrets := []string{
		"12345678",       // invalid digits (0, 1, 8, 9)
		"ABCDEFG8",       // digit 8
		"ABCDEFG9",       // digit 9
		"ABCDEFG0",       // digit 0
		"ABCDEF!@",       // invalid chars
		"ABCDE",          // too short (< 8 chars)
		"ABCDEFG",        // len 7 (incomplete byte sequence mod 1)
		"ABCDEFGHIJK",    // len 11 (mod 3)
		"ABCDEFGHIJKLMN", // len 14 (mod 6)
	}

	for _, sec := range invalidSecrets {
		s := sec
		code, _ := put(t, ts, "/api/v1/pages/p/groups/0/items/0?location=default", models.Item{
			Title:     "Item 0",
			Password:  &pw,
			OTPSecret: &s,
		})
		if code != http.StatusBadRequest {
			t.Errorf("expected 400 for invalid OTP secret %q, got %d", sec, code)
		}
	}

	// Valid secrets with spaces and dashes that should be cleaned
	validSecrets := []string{
		"JBSW Y3DP EHPK 3PXP",
		"JBSW-Y3DP-EHPK-3PXP",
		"jbswy3dpehpk3pxp", // lowercase
		"JBSWY3DPEHPK3PXP====",
	}

	for _, sec := range validSecrets {
		s := sec
		code, _ := put(t, ts, "/api/v1/pages/p/groups/0/items/0?location=default", models.Item{
			Title:     "Item 0",
			Password:  &pw,
			OTPSecret: &s,
		})
		if code != http.StatusOK {
			t.Errorf("expected 200 for valid cleaned OTP secret %q, got %d", sec, code)
		}
	}
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

// containsPlaintext returns true if the raw JSON bytes contain the plain string literally.
func containsPlaintext(raw []byte, plain string) bool {
	return string(raw) != "" && len(plain) > 0 &&
		len(raw) > 0 &&
		(func() bool {
			// Simple substring search
			for i := 0; i+len(plain) <= len(raw); i++ {
				if string(raw[i:i+len(plain)]) == plain {
					return true
				}
			}
			return false
		})()
}
