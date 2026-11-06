package models

// Item represents a single entry in a group. Fields are pointers so that
// omitempty omits nil values from JSON (mirrors Pydantic's exclude_none=True).
type Item struct {
	Title       string  `json:"title"`
	URL         *string `json:"url,omitempty"`
	Notes       *string `json:"notes,omitempty"`        // link items — plain-text notes
	Text        *string `json:"text,omitempty"`         // Base64-encoded Markdown
	EncText     *string `json:"enc_text,omitempty"`     // Fernet-encrypted Markdown
	Username    *string `json:"username,omitempty"`     // password items
	Password    *string `json:"password,omitempty"`     // password items — Fernet token on disk
	OTPSecret   *string `json:"otp_secret,omitempty"`   // password items — Fernet token on disk and TOTP generator
	PwURL       *string `json:"pw_url,omitempty"`       // password items website URL
	PwNotes     *string `json:"pw_notes,omitempty"`     // password items plain-text notes
	TaskChecked *bool   `json:"task_checked,omitempty"` // presence discriminates task items
	TaskDueDate *string `json:"task_due_date,omitempty"`
	TaskCreated *string `json:"task_created,omitempty"`
	CreatedAt   *string `json:"created_at,omitempty"`
	ModifiedAt  *string `json:"modified_at,omitempty"`
	Locked      *bool   `json:"locked,omitempty"`
}

// ItemType returns the discriminated type of the item.
func (it *Item) ItemType() string {
	if it.URL != nil {
		return "link"
	}
	if it.Password != nil || it.OTPSecret != nil {
		return "password"
	}
	if it.EncText != nil {
		return "enc_note"
	}
	if it.TaskChecked != nil {
		return "task"
	}
	return "note"
}

// Group is a named collection of items.
type Group struct {
	Title string `json:"title"`
	Items []Item `json:"items"`
}

// Page is the top-level document stored as one JSON file in the data directory.
type Page struct {
	PageName   string  `json:"page-name"`
	Hidden     bool    `json:"hidden"`
	CustomSort bool    `json:"custom_sort"`
	Groups     []Group `json:"groups"`
}

// PageMeta is the lightweight summary returned by GET /api/v1/pages.
type PageMeta struct {
	Slug       string `json:"slug"`
	PageName   string `json:"page_name"`
	Hidden     bool   `json:"hidden"`
	CustomSort bool   `json:"custom_sort"`
	PageType   string `json:"page_type"` // "grid", "note", "whiteboard", or "bpmn"
	Location   string `json:"location"`
	TaskStatus string `json:"task_status"` // "", "overdue", or "due_soon"
	FileName   string `json:"file_name"`
	CreatedAt  *string `json:"created_at,omitempty"`
	ModifiedAt *string `json:"modified_at,omitempty"`
}

// MoveGroupRequest is the body for POST /pages/{slug}/groups/{idx}/move.
type MoveGroupRequest struct {
	TargetSlug     string  `json:"target_slug"`
	TargetLocation *string `json:"target_location,omitempty"`
}

// MoveItemRequest is the body for POST /pages/{slug}/groups/{idx}/items/{idx}/move.
type MoveItemRequest struct {
	TargetGroupIndex int `json:"target_group_index"`
}

// SearchResult is one item returned by GET /api/v1/search.
type SearchResult struct {
	Location   *string `json:"location,omitempty"`
	Slug       string  `json:"slug"`
	PageName   string  `json:"page_name"`
	GroupIndex int     `json:"group_index"`
	ItemIndex  int     `json:"item_index"`
	Title      string  `json:"title"`
	URL        *string `json:"url,omitempty"`
	ItemType   string  `json:"item_type"`
}

// DueTask represents a single task item that is due or overdue across workspaces.
type DueTask struct {
	Location   string `json:"location"`
	Slug       string `json:"slug"`
	PageName   string `json:"page_name"`
	GroupTitle string `json:"group_title"`
	GroupIndex int    `json:"group_index"`
	ItemIndex  int    `json:"item_index"`
	Title      string `json:"title"`
	DueDate    string `json:"due_date"`
	DueStatus  string `json:"due_status"` // "overdue" or "due_soon"
}

// TaskIndexItem represents an unchecked task item indexed in memory.
type TaskIndexItem struct {
	Location    string `json:"location"`
	Slug        string `json:"slug"`
	PageName    string `json:"page_name"`
	GroupTitle  string `json:"group_title"`
	GroupIndex  int    `json:"group_index"`
	ItemIndex   int    `json:"item_index"`
	Title       string `json:"title"`
	TaskDueDate string `json:"task_due_date"`
	TaskChecked bool   `json:"task_checked"`
	TaskCreated string `json:"task_created,omitempty"`
	CreatedAt   string `json:"created_at,omitempty"`
}

// Task represents a single task item across workspaces.
type Task struct {
	Location    string `json:"location"`
	Slug        string `json:"slug"`
	PageName    string `json:"page_name"`
	GroupTitle  string `json:"group_title"`
	GroupIndex  int    `json:"group_index"`
	ItemIndex   int    `json:"item_index"`
	Title       string `json:"title"`
	DueDate     string `json:"due_date"`
	DueStatus   string `json:"due_status"` // "overdue", "due_soon", "upcoming", or ""
	CreatedAt   string `json:"created_at,omitempty"`
	TaskCreated string `json:"task_created,omitempty"`
}

// ConfigModel holds the application configuration persisted to config.json.
type ConfigModel struct {
	Theme            string      `json:"theme"`
	GroupboxMaxWidth int         `json:"groupbox_max_width"`
	FontSizeUI       int         `json:"font_size_ui"`
	FontSizeNote     int         `json:"font_size_note"`
	FontSizeLinks    int         `json:"font_size_links"`
	Port             int         `json:"port"`
	Workspaces       interface{} `json:"workspaces"` // null | map[string]any
	EnableGitSync    bool        `json:"enable_git_sync"`
	LogLevel         string      `json:"log_level,omitempty"`
	LogFile          string      `json:"log_file,omitempty"`
}
