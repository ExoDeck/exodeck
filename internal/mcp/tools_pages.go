package mcp

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ExoDeck/exodeck/internal/models"
	"github.com/ExoDeck/exodeck/internal/storage"
)

func (s *Server) registerPageTools() {
	itemInputSchema := objectSchema(map[string]interface{}{
		"title":         stringProp("Item title."),
		"url":           stringProp("Bookmark URL (for link items). Cannot be combined with markdown."),
		"notes":         stringProp("Optional plain-text description/notes for link items."),
		"markdown":      stringProp("Plain Markdown content (for note or task items). Automatically Base64-encoded on save."),
		"task_checked":  boolProp("Presence marks the item as a task; true if completed, false if open."),
		"task_due_date": stringProp("Optional task due date in YYYY-MM-DD format."),
	}, "title")

	groupInputSchema := objectSchema(map[string]interface{}{
		"title": stringProp("Group title."),
		"items": arrayProp("Items in this group.", itemInputSchema),
	}, "title")

	// 11. get_grid_page
	s.registerTool(
		"get_grid_page",
		"Read a Grid page (.grid) including all groups and items. Note Markdown is decoded to plain text; encrypted/password items are masked.",
		objectSchema(map[string]interface{}{
			"slug":      stringProp("Page slug."),
			"workspace": stringProp("Optional workspace name (defaults to primary workspace)."),
		}, "slug"),
		s.toolGetGridPage,
	)

	// 12. create_grid_page
	s.registerTool(
		"create_grid_page",
		"Create a new Grid page (.grid) with optional groups and items (links, notes, tasks).",
		objectSchema(map[string]interface{}{
			"page_name":   stringProp("Display name of the page (use 'Folder / Subfolder / Name' for hierarchy)."),
			"workspace":   stringProp("Optional workspace name (defaults to primary workspace)."),
			"hidden":      boolProp("Whether the page is hidden from sidebar navigation (default: false)."),
			"custom_sort": boolProp("Whether groups/items preserve manual order instead of alphabetical sort (default: false)."),
			"groups":      arrayProp("Optional initial groups for the grid page.", groupInputSchema),
		}, "page_name"),
		s.toolCreateGridPage,
	)

	// 13. update_grid_page
	s.registerTool(
		"update_grid_page",
		"Update an existing Grid page's name, hidden/custom_sort flags, or groups.",
		objectSchema(map[string]interface{}{
			"slug":        stringProp("Current slug of the grid page."),
			"workspace":   stringProp("Optional workspace name."),
			"page_name":   stringProp("Optional new page name (renames slug and updates internal links if changed)."),
			"hidden":      boolProp("Optional hidden status."),
			"custom_sort": boolProp("Optional custom_sort status."),
			"groups":      arrayProp("Optional replacement list of groups.", groupInputSchema),
		}, "slug"),
		s.toolUpdateGridPage,
	)

	// 14. delete_grid_page
	s.registerTool(
		"delete_grid_page",
		"Delete a Grid page (.grid) from a workspace.",
		objectSchema(map[string]interface{}{
			"slug":      stringProp("Slug of the grid page to delete."),
			"workspace": stringProp("Optional workspace name."),
		}, "slug"),
		s.toolDeleteGridPage,
	)

	// 15. add_group
	s.registerTool(
		"add_group",
		"Add a new group to a Grid page.",
		objectSchema(map[string]interface{}{
			"slug":      stringProp("Grid page slug."),
			"title":     stringProp("Title of the new group."),
			"workspace": stringProp("Optional workspace name."),
			"items":     arrayProp("Optional initial items in the group.", itemInputSchema),
		}, "slug", "title"),
		s.toolAddGroup,
	)

	// 16. update_group
	s.registerTool(
		"update_group",
		"Update a group's title or items on a Grid page.",
		objectSchema(map[string]interface{}{
			"slug":        stringProp("Grid page slug."),
			"group_index": intProp("Zero-based index of the group to update."),
			"title":       stringProp("Optional new title for the group."),
			"workspace":   stringProp("Optional workspace name."),
			"items":       arrayProp("Optional replacement items for the group.", itemInputSchema),
		}, "slug", "group_index"),
		s.toolUpdateGroup,
	)

	// 17. delete_group
	s.registerTool(
		"delete_group",
		"Delete a group at group_index from a Grid page.",
		objectSchema(map[string]interface{}{
			"slug":        stringProp("Grid page slug."),
			"group_index": intProp("Zero-based index of the group to delete."),
			"workspace":   stringProp("Optional workspace name."),
		}, "slug", "group_index"),
		s.toolDeleteGroup,
	)

	// 18. move_group
	s.registerTool(
		"move_group",
		"Move a group from one Grid page to another Grid page.",
		objectSchema(map[string]interface{}{
			"slug":             stringProp("Source grid page slug."),
			"group_index":      intProp("Zero-based index of the group to move."),
			"target_slug":      stringProp("Destination grid page slug."),
			"workspace":        stringProp("Optional source workspace name."),
			"target_workspace": stringProp("Optional destination workspace name (defaults to source workspace)."),
		}, "slug", "group_index", "target_slug"),
		s.toolMoveGroup,
	)

	// 19. add_item
	s.registerTool(
		"add_item",
		"Add a link, note, or task item to a group on a Grid page (specify either group_index or group_title).",
		objectSchema(map[string]interface{}{
			"slug":          stringProp("Grid page slug."),
			"workspace":     stringProp("Optional workspace name."),
			"group_index":   intProp("Zero-based group index (optional if group_title is provided)."),
			"group_title":   stringProp("Group title to match case-insensitively (if group does not exist on page, it is created automatically)."),
			"title":         stringProp("Item title."),
			"url":           stringProp("URL for link items (cannot be combined with markdown)."),
			"notes":         stringProp("Optional plain-text notes for link items."),
			"markdown":      stringProp("Plain Markdown content for note or task items."),
			"task_checked":  boolProp("Set to false (or true) to create a task item."),
			"task_due_date": stringProp("Optional due date in YYYY-MM-DD format for task items."),
		}, "slug", "title"),
		s.toolAddItem,
	)

	// 20. update_item
	s.registerTool(
		"update_item",
		"Update an existing link, note, or task item on a Grid page. Supports partial updates (e.g. toggling task_checked).",
		objectSchema(map[string]interface{}{
			"slug":          stringProp("Grid page slug."),
			"group_index":   intProp("Zero-based index of the group."),
			"item_index":    intProp("Zero-based index of the item within the group."),
			"workspace":     stringProp("Optional workspace name."),
			"title":         stringProp("Optional new item title."),
			"url":           stringProp("Optional new URL for link items."),
			"notes":         stringProp("Optional new plain-text notes for link items."),
			"markdown":      stringProp("Optional new plain Markdown text for note or task items."),
			"task_checked":  boolProp("Optional task completion state."),
			"task_due_date": stringProp("Optional task due date in YYYY-MM-DD format (pass empty string to clear)."),
		}, "slug", "group_index", "item_index"),
		s.toolUpdateItem,
	)

	// 21. delete_item
	s.registerTool(
		"delete_item",
		"Delete a link, note, or task item from a group on a Grid page.",
		objectSchema(map[string]interface{}{
			"slug":        stringProp("Grid page slug."),
			"group_index": intProp("Zero-based index of the group."),
			"item_index":  intProp("Zero-based index of the item to delete."),
			"workspace":   stringProp("Optional workspace name."),
		}, "slug", "group_index", "item_index"),
		s.toolDeleteItem,
	)

	// 22. move_item
	s.registerTool(
		"move_item",
		"Move an item from one group to another on the same Grid page.",
		objectSchema(map[string]interface{}{
			"slug":               stringProp("Grid page slug."),
			"group_index":        intProp("Source group index."),
			"item_index":         intProp("Source item index."),
			"target_group_index": intProp("Destination group index."),
			"workspace":          stringProp("Optional workspace name."),
		}, "slug", "group_index", "item_index", "target_group_index"),
		s.toolMoveItem,
	)

	// 23. get_note
	s.registerTool(
		"get_note",
		"Read the full Markdown content of a Note page (.md).",
		objectSchema(map[string]interface{}{
			"slug":      stringProp("Note page slug."),
			"workspace": stringProp("Optional workspace name."),
		}, "slug"),
		s.toolGetNote,
	)

	// 24. create_note
	s.registerTool(
		"create_note",
		"Create a new Markdown Note page (.md). Automatically prepends '# <title>' if title is given and content has no H1 heading.",
		objectSchema(map[string]interface{}{
			"content":   stringProp("Markdown content of the note."),
			"title":     stringProp("Optional H1 title for the note (e.g. 'Projects / Architecture')."),
			"workspace": stringProp("Optional workspace name."),
		}, "content"),
		s.toolCreateNote,
	)

	// 25. update_note
	s.registerTool(
		"update_note",
		"Update or append to a Markdown Note page (.md). Renames the file and updates internal links if the H1 heading changes.",
		objectSchema(map[string]interface{}{
			"slug":      stringProp("Note page slug."),
			"content":   stringProp("New Markdown content (or content to append when append=true)."),
			"append":    boolProp("If true, appends content to the end of the existing note instead of replacing it."),
			"workspace": stringProp("Optional workspace name."),
		}, "slug", "content"),
		s.toolUpdateNote,
	)

	// 26. delete_note
	s.registerTool(
		"delete_note",
		"Delete a Markdown Note page (.md) and clean up its referenced media files.",
		objectSchema(map[string]interface{}{
			"slug":      stringProp("Note page slug."),
			"workspace": stringProp("Optional workspace name."),
		}, "slug"),
		s.toolDeleteNote,
	)

	// 27. list_media
	s.registerTool(
		"list_media",
		"List uploaded media files associated with a page slug.",
		objectSchema(map[string]interface{}{
			"slug":      stringProp("Page slug."),
			"workspace": stringProp("Optional workspace name."),
		}, "slug"),
		s.toolListMedia,
	)

	// 28. delete_media
	s.registerTool(
		"delete_media",
		"Delete a media file associated with a page slug.",
		objectSchema(map[string]interface{}{
			"slug":      stringProp("Page slug."),
			"filename":  stringProp("Name of the media file to delete."),
			"workspace": stringProp("Optional workspace name."),
		}, "slug", "filename"),
		s.toolDeleteMedia,
	)

	// 29. get_whiteboard
	s.registerTool(
		"get_whiteboard",
		"Read the Excalidraw JSON content of a Whiteboard page (.excalidraw).",
		objectSchema(map[string]interface{}{
			"slug":      stringProp("Whiteboard page slug."),
			"workspace": stringProp("Optional workspace name."),
		}, "slug"),
		s.toolGetWhiteboard,
	)

	// 30. create_whiteboard
	s.registerTool(
		"create_whiteboard",
		"Create a new Excalidraw Whiteboard page (.excalidraw). Can be initialized with a page_name alone or custom Excalidraw elements/content.",
		objectSchema(map[string]interface{}{
			"page_name": stringProp("Display name of the whiteboard page."),
			"workspace": stringProp("Optional workspace name."),
			"content":   stringProp("Optional full Excalidraw JSON string."),
			"elements":  arrayProp("Optional Excalidraw elements array.", map[string]interface{}{"type": "object"}),
		}, "page_name"),
		s.toolCreateWhiteboard,
	)

	// 31. update_whiteboard
	s.registerTool(
		"update_whiteboard",
		"Update an Excalidraw Whiteboard page (.excalidraw).",
		objectSchema(map[string]interface{}{
			"slug":      stringProp("Whiteboard page slug."),
			"workspace": stringProp("Optional workspace name."),
			"page_name": stringProp("Optional new page name."),
			"content":   stringProp("Optional full Excalidraw JSON string."),
			"elements":  arrayProp("Optional replacement Excalidraw elements array.", map[string]interface{}{"type": "object"}),
		}, "slug"),
		s.toolUpdateWhiteboard,
	)

	// 32. delete_whiteboard
	s.registerTool(
		"delete_whiteboard",
		"Delete an Excalidraw Whiteboard page (.excalidraw).",
		objectSchema(map[string]interface{}{
			"slug":      stringProp("Whiteboard page slug."),
			"workspace": stringProp("Optional workspace name."),
		}, "slug"),
		s.toolDeleteWhiteboard,
	)

	// 33. get_bpmn
	s.registerTool(
		"get_bpmn",
		"Read a BPMN 2.0 Business Process diagram page (.bpmn).",
		objectSchema(map[string]interface{}{
			"slug":      stringProp("BPMN page slug."),
			"workspace": stringProp("Optional workspace name."),
		}, "slug"),
		s.toolGetBpmn,
	)

	// 34. create_bpmn
	s.registerTool(
		"create_bpmn",
		"Create a new BPMN 2.0 diagram page (.bpmn). Generates a starter BPMN 2.0 XML diagram if bpmn_xml is omitted.",
		objectSchema(map[string]interface{}{
			"page_name": stringProp("Display name of the BPMN diagram."),
			"workspace": stringProp("Optional workspace name."),
			"bpmn_xml":  stringProp("Optional BPMN 2.0 XML string."),
		}, "page_name"),
		s.toolCreateBpmn,
	)

	// 35. update_bpmn
	s.registerTool(
		"update_bpmn",
		"Update an existing BPMN 2.0 diagram page (.bpmn).",
		objectSchema(map[string]interface{}{
			"slug":      stringProp("BPMN page slug."),
			"workspace": stringProp("Optional workspace name."),
			"page_name": stringProp("Optional new display name for the BPMN diagram."),
			"bpmn_xml":  stringProp("Optional updated BPMN 2.0 XML string."),
		}, "slug"),
		s.toolUpdateBpmn,
	)

	// 36. delete_bpmn
	s.registerTool(
		"delete_bpmn",
		"Delete a BPMN 2.0 diagram page (.bpmn).",
		objectSchema(map[string]interface{}{
			"slug":      stringProp("BPMN page slug."),
			"workspace": stringProp("Optional workspace name."),
		}, "slug"),
		s.toolDeleteBpmn,
	)
}

// Grid Page types for MCP

// MCPItem is the MCP representation of a Grid item with plain-text Markdown and redacted secrets.
type MCPItem struct {
	Title       string  `json:"title"`
	ItemType    string  `json:"item_type"`
	URL         *string `json:"url,omitempty"`
	Notes       *string `json:"notes,omitempty"`
	Markdown    *string `json:"markdown,omitempty"`
	TaskChecked *bool   `json:"task_checked,omitempty"`
	TaskDueDate *string `json:"task_due_date,omitempty"`
	TaskCreated *string `json:"task_created,omitempty"`
	CreatedAt   *string `json:"created_at,omitempty"`
	ModifiedAt  *string `json:"modified_at,omitempty"`
	Locked      *bool   `json:"locked,omitempty"`
}

// MCPGroup is the MCP representation of a Group.
type MCPGroup struct {
	Title string    `json:"title"`
	Items []MCPItem `json:"items"`
}

// MCPPage is the MCP representation of a Grid Page.
type MCPPage struct {
	Slug       string     `json:"slug"`
	Workspace  string     `json:"workspace"`
	PageName   string     `json:"page_name"`
	Hidden     bool       `json:"hidden"`
	CustomSort bool       `json:"custom_sort"`
	Groups     []MCPGroup `json:"groups"`
}

// MCPItemInput represents input parameters for creating an item.
type MCPItemInput struct {
	Title       string  `json:"title"`
	ItemType    string  `json:"item_type,omitempty"`
	URL         *string `json:"url,omitempty"`
	Notes       *string `json:"notes,omitempty"`
	Markdown    *string `json:"markdown,omitempty"`
	Text        *string `json:"text,omitempty"`
	Password    *string `json:"password,omitempty"`
	OTPSecret   *string `json:"otp_secret,omitempty"`
	EncText     *string `json:"enc_text,omitempty"`
	TaskChecked *bool   `json:"task_checked,omitempty"`
	TaskDueDate *string `json:"task_due_date,omitempty"`
}

// MCPGroupInput represents input parameters for creating a group.
type MCPGroupInput struct {
	Title string         `json:"title"`
	Items []MCPItemInput `json:"items,omitempty"`
}

func isSensitiveItem(item models.Item) bool {
	if item.Password != nil || item.OTPSecret != nil || item.EncText != nil {
		return true
	}
	if item.Locked != nil && *item.Locked {
		return true
	}
	return false
}

func groupContainsSensitiveItems(group models.Group) bool {
	for _, it := range group.Items {
		if isSensitiveItem(it) {
			return true
		}
	}
	return false
}

func pageContainsSensitiveItems(page models.Page) bool {
	for _, g := range page.Groups {
		if groupContainsSensitiveItems(g) {
			return true
		}
	}
	return false
}

func sanitizeItemForRead(item models.Item) MCPItem {
	if isSensitiveItem(item) {
		locked := true
		return MCPItem{
			Title:    item.Title,
			ItemType: item.ItemType(),
			Locked:   &locked,
		}
	}
	out := MCPItem{
		Title:       item.Title,
		ItemType:    item.ItemType(),
		URL:         item.URL,
		Notes:       item.Notes,
		TaskChecked: item.TaskChecked,
		TaskDueDate: item.TaskDueDate,
		TaskCreated: item.TaskCreated,
		CreatedAt:   item.CreatedAt,
		ModifiedAt:  item.ModifiedAt,
	}
	if item.Text != nil && *item.Text != "" {
		md := decodeMarkdownText(*item.Text)
		out.Markdown = &md
	}
	return out
}

func sanitizePageForRead(slug, workspace string, page models.Page) MCPPage {
	groups := make([]MCPGroup, 0, len(page.Groups))
	for _, g := range page.Groups {
		items := make([]MCPItem, 0, len(g.Items))
		for _, it := range g.Items {
			items = append(items, sanitizeItemForRead(it))
		}
		groups = append(groups, MCPGroup{
			Title: g.Title,
			Items: items,
		})
	}
	return MCPPage{
		Slug:       slug,
		Workspace:  workspace,
		PageName:   page.PageName,
		Hidden:     page.Hidden,
		CustomSort: page.CustomSort,
		Groups:     groups,
	}
}

func buildItemFromInput(in MCPItemInput) (models.Item, error) {
	if in.Password != nil || in.OTPSecret != nil || in.EncText != nil ||
		strings.EqualFold(in.ItemType, "password") || strings.EqualFold(in.ItemType, "enc_note") {
		return models.Item{}, errors.New("creating or modifying password/encrypted items is not permitted via MCP")
	}

	title := strings.TrimSpace(in.Title)
	if title == "" {
		return models.Item{}, errors.New("item 'title' cannot be empty")
	}

	mdContent := in.Markdown
	if mdContent == nil && in.Text != nil {
		mdContent = in.Text
	}

	hasURL := in.URL != nil && strings.TrimSpace(*in.URL) != ""
	hasMD := mdContent != nil && *mdContent != ""
	if hasURL && hasMD {
		return models.Item{}, errors.New("an item cannot have both 'url' (link) and 'markdown' (note)")
	}

	now := time.Now().Format(time.RFC3339)
	item := models.Item{
		Title:      title,
		CreatedAt:  &now,
		ModifiedAt: &now,
	}

	if hasURL {
		u := strings.TrimSpace(*in.URL)
		item.URL = &u
		if in.Notes != nil && *in.Notes != "" {
			n := *in.Notes
			item.Notes = &n
		}
	} else if mdContent != nil {
		encoded := encodeMarkdownText(*mdContent)
		item.Text = &encoded
	} else if in.TaskChecked == nil {
		// Default empty note item
		encoded := ""
		item.Text = &encoded
	}

	if in.TaskChecked != nil {
		checked := *in.TaskChecked
		item.TaskChecked = &checked
		item.TaskCreated = &now
		if in.TaskDueDate != nil && strings.TrimSpace(*in.TaskDueDate) != "" {
			due := strings.TrimSpace(*in.TaskDueDate)
			item.TaskDueDate = &due
		}
	}

	return item, nil
}

func buildGroupsFromInput(groupsIn []MCPGroupInput) ([]models.Group, error) {
	groups := make([]models.Group, 0, len(groupsIn))
	for _, gIn := range groupsIn {
		gTitle := strings.TrimSpace(gIn.Title)
		if gTitle == "" {
			return nil, errors.New("group 'title' cannot be empty")
		}
		items := make([]models.Item, 0, len(gIn.Items))
		for _, itIn := range gIn.Items {
			it, err := buildItemFromInput(itIn)
			if err != nil {
				return nil, err
			}
			items = append(items, it)
		}
		groups = append(groups, models.Group{
			Title: gTitle,
			Items: items,
		})
	}
	return groups, nil
}

func (s *Server) toolGetGridPage(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug      string `json:"slug"`
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	page, status, msg := s.Store.ReadPage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}
	return sanitizePageForRead(in.Slug, wsName, page), nil
}

func (s *Server) toolCreateGridPage(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		PageName   string          `json:"page_name"`
		Workspace  string          `json:"workspace"`
		Hidden     bool            `json:"hidden"`
		CustomSort bool            `json:"custom_sort"`
		Groups     []MCPGroupInput `json:"groups"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	pageName := strings.TrimSpace(in.PageName)
	if pageName == "" {
		return nil, errors.New("'page_name' is required")
	}

	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}

	slug := storage.Slugify(pageName)
	if slug == "" {
		return nil, errors.New("'page_name' must contain at least one alphanumeric character")
	}
	if _, existingSt, _ := s.Store.ReadPage(slug, wsName); existingSt == 0 {
		return nil, fmt.Errorf("grid page '%s' already exists in workspace '%s'", slug, wsName)
	}

	groups, err := buildGroupsFromInput(in.Groups)
	if err != nil {
		return nil, err
	}

	page := models.Page{
		PageName:   pageName,
		Hidden:     in.Hidden,
		CustomSort: in.CustomSort,
		Groups:     groups,
	}

	if wSt, wMsg := s.Store.WritePage(slug, page, wsName); wSt != 0 {
		return nil, errors.New(wMsg)
	}

	return sanitizePageForRead(slug, wsName, page), nil
}

func (s *Server) toolUpdateGridPage(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug       string           `json:"slug"`
		Workspace  string           `json:"workspace"`
		PageName   *string          `json:"page_name"`
		Hidden     *bool            `json:"hidden"`
		CustomSort *bool            `json:"custom_sort"`
		Groups     *[]MCPGroupInput `json:"groups"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	wsName, wsPath, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}

	page, status, msg := s.Store.ReadPage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}

	if in.PageName != nil {
		trimmed := strings.TrimSpace(*in.PageName)
		if trimmed == "" {
			return nil, errors.New("page_name cannot be empty")
		}
		page.PageName = trimmed
	}
	if in.Hidden != nil {
		page.Hidden = *in.Hidden
	}
	if in.CustomSort != nil {
		page.CustomSort = *in.CustomSort
	}
	if in.Groups != nil {
		if pageContainsSensitiveItems(page) {
			return nil, errors.New("cannot replace groups on a page containing encrypted/password items; use group/item tools instead")
		}
		groups, err := buildGroupsFromInput(*in.Groups)
		if err != nil {
			return nil, err
		}
		page.Groups = groups
	}

	newSlug := storage.Slugify(page.PageName)
	if newSlug != in.Slug {
		if wSt, wMsg := s.Store.WritePage(newSlug, page, wsName); wSt != 0 {
			return nil, errors.New(wMsg)
		}
		if wsPath != "" {
			oldMedia := filepath.Join(wsPath, in.Slug)
			newMedia := filepath.Join(wsPath, newSlug)
			if stat, err := os.Stat(oldMedia); err == nil && stat.IsDir() {
				_ = os.Rename(oldMedia, newMedia)
			}
		}
		_, _ = s.Store.DeletePage(in.Slug, wsName)
		_ = s.Store.UpdateLinksAfterPageRename(in.Slug, newSlug, wsName)
	} else {
		if wSt, wMsg := s.Store.WritePage(in.Slug, page, wsName); wSt != 0 {
			return nil, errors.New(wMsg)
		}
	}

	return sanitizePageForRead(newSlug, wsName, page), nil
}

func (s *Server) toolDeleteGridPage(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug      string `json:"slug"`
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	if dSt, dMsg := s.Store.DeletePage(in.Slug, wsName); dSt != 0 {
		return nil, errors.New(dMsg)
	}
	return map[string]interface{}{
		"slug":      in.Slug,
		"workspace": wsName,
		"status":    "deleted",
	}, nil
}

func (s *Server) toolAddGroup(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug      string         `json:"slug"`
		Title     string         `json:"title"`
		Workspace string         `json:"workspace"`
		Items     []MCPItemInput `json:"items"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}

	groups, err := buildGroupsFromInput([]MCPGroupInput{{Title: in.Title, Items: in.Items}})
	if err != nil {
		return nil, err
	}

	page, status, msg := s.Store.ReadPage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}

	page.Groups = append(page.Groups, groups[0])
	if wSt, wMsg := s.Store.WritePage(in.Slug, page, wsName); wSt != 0 {
		return nil, errors.New(wMsg)
	}

	return map[string]interface{}{
		"slug":        in.Slug,
		"workspace":   wsName,
		"group_index": len(page.Groups) - 1,
		"group_title": groups[0].Title,
	}, nil
}

func (s *Server) toolUpdateGroup(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug       string          `json:"slug"`
		GroupIndex int             `json:"group_index"`
		Title      *string         `json:"title"`
		Workspace  string          `json:"workspace"`
		Items      *[]MCPItemInput `json:"items"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}

	page, status, msg := s.Store.ReadPage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}
	if in.GroupIndex < 0 || in.GroupIndex >= len(page.Groups) {
		return nil, fmt.Errorf("group_index %d is out of range (page has %d groups)", in.GroupIndex, len(page.Groups))
	}

	group := &page.Groups[in.GroupIndex]
	if in.Title != nil {
		trimmed := strings.TrimSpace(*in.Title)
		if trimmed == "" {
			return nil, errors.New("group title cannot be empty")
		}
		group.Title = trimmed
	}
	if in.Items != nil {
		if groupContainsSensitiveItems(*group) {
			return nil, errors.New("cannot replace items in a group containing encrypted/password items")
		}
		built, err := buildGroupsFromInput([]MCPGroupInput{{Title: group.Title, Items: *in.Items}})
		if err != nil {
			return nil, err
		}
		group.Items = built[0].Items
	}

	if wSt, wMsg := s.Store.WritePage(in.Slug, page, wsName); wSt != 0 {
		return nil, errors.New(wMsg)
	}

	return map[string]interface{}{
		"slug":        in.Slug,
		"workspace":   wsName,
		"group_index": in.GroupIndex,
		"group_title": group.Title,
		"item_count":  len(group.Items),
	}, nil
}

func (s *Server) toolDeleteGroup(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug       string `json:"slug"`
		GroupIndex int    `json:"group_index"`
		Workspace  string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	page, status, msg := s.Store.ReadPage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}
	if in.GroupIndex < 0 || in.GroupIndex >= len(page.Groups) {
		return nil, fmt.Errorf("group_index %d is out of range (page has %d groups)", in.GroupIndex, len(page.Groups))
	}
	if groupContainsSensitiveItems(page.Groups[in.GroupIndex]) {
		return nil, errors.New("cannot delete a group containing encrypted/password items via MCP")
	}

	page.Groups = append(page.Groups[:in.GroupIndex], page.Groups[in.GroupIndex+1:]...)
	if wSt, wMsg := s.Store.WritePage(in.Slug, page, wsName); wSt != 0 {
		return nil, errors.New(wMsg)
	}

	return map[string]interface{}{
		"slug":        in.Slug,
		"workspace":   wsName,
		"group_index": in.GroupIndex,
		"status":      "deleted",
	}, nil
}

func (s *Server) toolMoveGroup(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug            string `json:"slug"`
		GroupIndex      int    `json:"group_index"`
		TargetSlug      string `json:"target_slug"`
		Workspace       string `json:"workspace"`
		TargetWorkspace string `json:"target_workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	srcWS, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	targetWSInput := in.TargetWorkspace
	if targetWSInput == "" {
		targetWSInput = srcWS
	}
	dstWS, _, st, errMsg := s.Store.ResolveWorkspace(targetWSInput)
	if st != 0 {
		return nil, errors.New(errMsg)
	}

	srcPage, status, msg := s.Store.ReadPage(in.Slug, srcWS)
	if status != 0 {
		return nil, errors.New(msg)
	}
	if in.GroupIndex < 0 || in.GroupIndex >= len(srcPage.Groups) {
		return nil, fmt.Errorf("group_index %d is out of range (page has %d groups)", in.GroupIndex, len(srcPage.Groups))
	}
	group := srcPage.Groups[in.GroupIndex]
	if srcWS != dstWS && groupContainsSensitiveItems(group) {
		return nil, errors.New("cannot move a group containing encrypted/password items across workspaces via MCP")
	}

	dstPage, status, msg := s.Store.ReadPage(in.TargetSlug, dstWS)
	if status != 0 {
		return nil, fmt.Errorf("target page error: %s", msg)
	}

	srcPage.Groups = append(srcPage.Groups[:in.GroupIndex], srcPage.Groups[in.GroupIndex+1:]...)
	if wSt, wMsg := s.Store.WritePage(in.Slug, srcPage, srcWS); wSt != 0 {
		return nil, errors.New(wMsg)
	}

	// Re-read dstPage if moving within the same page/workspace
	if srcWS == dstWS && in.Slug == in.TargetSlug {
		dstPage = srcPage
	}
	dstPage.Groups = append(dstPage.Groups, group)
	if wSt, wMsg := s.Store.WritePage(in.TargetSlug, dstPage, dstWS); wSt != 0 {
		return nil, errors.New(wMsg)
	}

	return map[string]interface{}{
		"source_slug":      in.Slug,
		"source_workspace": srcWS,
		"target_slug":      in.TargetSlug,
		"target_workspace": dstWS,
		"status":           "moved",
	}, nil
}

func (s *Server) toolAddItem(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug       string  `json:"slug"`
		Workspace  string  `json:"workspace"`
		GroupIndex *int    `json:"group_index"`
		GroupTitle *string `json:"group_title"`
		MCPItemInput
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}

	item, err := buildItemFromInput(in.MCPItemInput)
	if err != nil {
		return nil, err
	}

	page, status, msg := s.Store.ReadPage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}

	targetGroupIdx := -1
	if in.GroupIndex != nil {
		if *in.GroupIndex < 0 || *in.GroupIndex >= len(page.Groups) {
			return nil, fmt.Errorf("group_index %d is out of range (page has %d groups)", *in.GroupIndex, len(page.Groups))
		}
		targetGroupIdx = *in.GroupIndex
	} else if in.GroupTitle != nil && strings.TrimSpace(*in.GroupTitle) != "" {
		gTitle := strings.TrimSpace(*in.GroupTitle)
		for i, g := range page.Groups {
			if strings.EqualFold(g.Title, gTitle) {
				targetGroupIdx = i
				break
			}
		}
		if targetGroupIdx == -1 {
			page.Groups = append(page.Groups, models.Group{
				Title: gTitle,
				Items: []models.Item{},
			})
			targetGroupIdx = len(page.Groups) - 1
		}
	} else {
		return nil, errors.New("either 'group_index' or 'group_title' must be provided")
	}

	page.Groups[targetGroupIdx].Items = append(page.Groups[targetGroupIdx].Items, item)
	if wSt, wMsg := s.Store.WritePage(in.Slug, page, wsName); wSt != 0 {
		return nil, errors.New(wMsg)
	}

	return map[string]interface{}{
		"slug":        in.Slug,
		"workspace":   wsName,
		"group_index": targetGroupIdx,
		"group_title": page.Groups[targetGroupIdx].Title,
		"item_index":  len(page.Groups[targetGroupIdx].Items) - 1,
		"item":        sanitizeItemForRead(item),
	}, nil
}

func (s *Server) toolUpdateItem(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug        string  `json:"slug"`
		GroupIndex  int     `json:"group_index"`
		ItemIndex   int     `json:"item_index"`
		Workspace   string  `json:"workspace"`
		Title       *string `json:"title"`
		ItemType    string  `json:"item_type"`
		URL         *string `json:"url"`
		Notes       *string `json:"notes"`
		Markdown    *string `json:"markdown"`
		Text        *string `json:"text"`
		Password    *string `json:"password"`
		OTPSecret   *string `json:"otp_secret"`
		EncText     *string `json:"enc_text"`
		TaskChecked *bool   `json:"task_checked"`
		TaskDueDate *string `json:"task_due_date"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	if in.Password != nil || in.OTPSecret != nil || in.EncText != nil ||
		strings.EqualFold(in.ItemType, "password") || strings.EqualFold(in.ItemType, "enc_note") {
		return nil, errors.New("creating or modifying password/encrypted items is not permitted via MCP")
	}

	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}

	page, status, msg := s.Store.ReadPage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}
	if in.GroupIndex < 0 || in.GroupIndex >= len(page.Groups) {
		return nil, fmt.Errorf("group_index %d is out of range (page has %d groups)", in.GroupIndex, len(page.Groups))
	}
	if in.ItemIndex < 0 || in.ItemIndex >= len(page.Groups[in.GroupIndex].Items) {
		return nil, fmt.Errorf("item_index %d is out of range (group has %d items)", in.ItemIndex, len(page.Groups[in.GroupIndex].Items))
	}

	item := page.Groups[in.GroupIndex].Items[in.ItemIndex]
	if isSensitiveItem(item) {
		return nil, errors.New("cannot modify encrypted or password items via MCP")
	}

	if in.Title != nil {
		trimmed := strings.TrimSpace(*in.Title)
		if trimmed == "" {
			return nil, errors.New("item title cannot be empty")
		}
		item.Title = trimmed
	}

	mdContent := in.Markdown
	if mdContent == nil && in.Text != nil {
		mdContent = in.Text
	}
	if in.URL != nil && mdContent != nil && *in.URL != "" && *mdContent != "" {
		return nil, errors.New("an item cannot have both 'url' and 'markdown'")
	}

	if in.URL != nil {
		u := strings.TrimSpace(*in.URL)
		if u == "" {
			item.URL = nil
		} else {
			item.URL = &u
			item.Text = nil
		}
	}
	if in.Notes != nil {
		n := *in.Notes
		if n == "" {
			item.Notes = nil
		} else {
			item.Notes = &n
		}
	}
	if mdContent != nil {
		encoded := encodeMarkdownText(*mdContent)
		item.Text = &encoded
		item.URL = nil
		item.Notes = nil
	}
	if in.TaskChecked != nil {
		checked := *in.TaskChecked
		item.TaskChecked = &checked
		if item.TaskCreated == nil {
			now := time.Now().Format(time.RFC3339)
			item.TaskCreated = &now
		}
	}
	if in.TaskDueDate != nil {
		due := strings.TrimSpace(*in.TaskDueDate)
		if due == "" {
			item.TaskDueDate = nil
		} else {
			item.TaskDueDate = &due
		}
	}

	now := time.Now().Format(time.RFC3339)
	item.ModifiedAt = &now
	page.Groups[in.GroupIndex].Items[in.ItemIndex] = item

	if wSt, wMsg := s.Store.WritePage(in.Slug, page, wsName); wSt != 0 {
		return nil, errors.New(wMsg)
	}

	return sanitizeItemForRead(item), nil
}

func (s *Server) toolDeleteItem(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug       string `json:"slug"`
		GroupIndex int    `json:"group_index"`
		ItemIndex  int    `json:"item_index"`
		Workspace  string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	page, status, msg := s.Store.ReadPage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}
	if in.GroupIndex < 0 || in.GroupIndex >= len(page.Groups) {
		return nil, fmt.Errorf("group_index %d is out of range (page has %d groups)", in.GroupIndex, len(page.Groups))
	}
	items := page.Groups[in.GroupIndex].Items
	if in.ItemIndex < 0 || in.ItemIndex >= len(items) {
		return nil, fmt.Errorf("item_index %d is out of range (group has %d items)", in.ItemIndex, len(items))
	}
	if isSensitiveItem(items[in.ItemIndex]) {
		return nil, errors.New("cannot delete encrypted or password items via MCP")
	}

	page.Groups[in.GroupIndex].Items = append(items[:in.ItemIndex], items[in.ItemIndex+1:]...)
	if wSt, wMsg := s.Store.WritePage(in.Slug, page, wsName); wSt != 0 {
		return nil, errors.New(wMsg)
	}

	return map[string]interface{}{
		"slug":        in.Slug,
		"workspace":   wsName,
		"group_index": in.GroupIndex,
		"item_index":  in.ItemIndex,
		"status":      "deleted",
	}, nil
}

func (s *Server) toolMoveItem(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug             string `json:"slug"`
		GroupIndex       int    `json:"group_index"`
		ItemIndex        int    `json:"item_index"`
		TargetGroupIndex int    `json:"target_group_index"`
		Workspace        string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	page, status, msg := s.Store.ReadPage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}
	if in.GroupIndex < 0 || in.GroupIndex >= len(page.Groups) {
		return nil, fmt.Errorf("group_index %d is out of range", in.GroupIndex)
	}
	if in.TargetGroupIndex < 0 || in.TargetGroupIndex >= len(page.Groups) {
		return nil, fmt.Errorf("target_group_index %d is out of range", in.TargetGroupIndex)
	}
	if in.GroupIndex == in.TargetGroupIndex {
		return nil, errors.New("source and target groups are the same")
	}
	items := page.Groups[in.GroupIndex].Items
	if in.ItemIndex < 0 || in.ItemIndex >= len(items) {
		return nil, fmt.Errorf("item_index %d is out of range", in.ItemIndex)
	}

	item := items[in.ItemIndex]
	page.Groups[in.GroupIndex].Items = append(items[:in.ItemIndex], items[in.ItemIndex+1:]...)
	page.Groups[in.TargetGroupIndex].Items = append(page.Groups[in.TargetGroupIndex].Items, item)

	if wSt, wMsg := s.Store.WritePage(in.Slug, page, wsName); wSt != 0 {
		return nil, errors.New(wMsg)
	}

	return map[string]interface{}{
		"slug":               in.Slug,
		"workspace":          wsName,
		"source_group_index": in.GroupIndex,
		"target_group_index": in.TargetGroupIndex,
		"status":             "moved",
	}, nil
}

// Note Page & Media tools

func (s *Server) toolGetNote(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug      string `json:"slug"`
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	content, status, msg := s.Store.ReadNotePage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}
	return map[string]interface{}{
		"slug":      in.Slug,
		"workspace": wsName,
		"page_name": storage.ExtractH1(content),
		"content":   content,
	}, nil
}

func (s *Server) toolCreateNote(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Content   string `json:"content"`
		Title     string `json:"title"`
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}

	content := in.Content
	title := strings.TrimSpace(in.Title)
	if title != "" && storage.ExtractH1(content) == "" {
		if strings.TrimSpace(content) == "" {
			content = "# " + title + "\n"
		} else {
			content = "# " + title + "\n\n" + content
		}
	}
	if strings.TrimSpace(content) == "" {
		return nil, errors.New("note 'content' or 'title' must be non-empty")
	}

	newSlug, pageName, status, msg := s.Store.WriteNotePage("", content, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}
	return map[string]interface{}{
		"slug":      newSlug,
		"page_name": pageName,
		"workspace": wsName,
		"status":    "created",
	}, nil
}

func (s *Server) toolUpdateNote(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug      string `json:"slug"`
		Content   string `json:"content"`
		Append    bool   `json:"append"`
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}

	existing, status, msg := s.Store.ReadNotePage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}

	newContent := in.Content
	if in.Append {
		if strings.HasSuffix(existing, "\n") {
			newContent = existing + "\n" + in.Content
		} else {
			newContent = existing + "\n\n" + in.Content
		}
	}

	newSlug, pageName, wSt, wMsg := s.Store.WriteNotePage(in.Slug, newContent, wsName)
	if wSt != 0 {
		return nil, errors.New(wMsg)
	}
	if newSlug != in.Slug {
		_ = s.Store.UpdateLinksAfterPageRename(in.Slug, newSlug, wsName)
	}

	return map[string]interface{}{
		"slug":      newSlug,
		"page_name": pageName,
		"workspace": wsName,
		"status":    "updated",
	}, nil
}

func (s *Server) toolDeleteNote(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug      string `json:"slug"`
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	if dSt, dMsg := s.Store.DeleteNotePage(in.Slug, wsName); dSt != 0 {
		return nil, errors.New(dMsg)
	}
	return map[string]interface{}{
		"slug":      in.Slug,
		"workspace": wsName,
		"status":    "deleted",
	}, nil
}

func (s *Server) toolListMedia(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug      string `json:"slug"`
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, locPath, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	if in.Slug == "" || in.Slug == "." || in.Slug == ".." {
		return nil, errors.New("invalid slug")
	}

	dirPath := filepath.Join(locPath, filepath.Base(in.Slug))
	entries, err := os.ReadDir(dirPath)

	type mediaEntry struct {
		Filename string `json:"filename"`
		Size     int64  `json:"size"`
		URL      string `json:"url"`
	}
	items := make([]mediaEntry, 0)
	if err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			if info, infoErr := e.Info(); infoErr == nil {
				items = append(items, mediaEntry{
					Filename: e.Name(),
					Size:     info.Size(),
					URL:      fmt.Sprintf("/api/v1/media/%s/%s?location=%s", in.Slug, e.Name(), wsName),
				})
			}
		}
	}
	return items, nil
}

func (s *Server) toolDeleteMedia(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug      string `json:"slug"`
		Filename  string `json:"filename"`
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, locPath, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	if isBuiltInHelpWorkspace(wsName) {
		return nil, errors.New("ExoDeck help workspace is read-only")
	}
	if in.Slug == "" || in.Filename == "" {
		return nil, errors.New("slug and filename are required")
	}

	cleanSlug := filepath.Base(in.Slug)
	cleanFile := filepath.Base(in.Filename)
	fullPath := filepath.Join(locPath, cleanSlug, cleanFile)

	if err := os.Remove(fullPath); err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("media file '%s' not found", cleanFile)
		}
		return nil, fmt.Errorf("deleting media file: %w", err)
	}

	return map[string]interface{}{
		"slug":      cleanSlug,
		"filename":  cleanFile,
		"workspace": wsName,
		"status":    "deleted",
	}, nil
}

// Whiteboard tools (.excalidraw)

func buildWhiteboardJSON(pageName, rawContent string, elements []interface{}) (string, error) {
	if strings.TrimSpace(rawContent) != "" {
		var parsed map[string]interface{}
		if err := json.Unmarshal([]byte(rawContent), &parsed); err != nil {
			return "", fmt.Errorf("invalid Excalidraw JSON content: %w", err)
		}
		if pageName != "" {
			parsed["page-name"] = pageName
		}
		if elements != nil {
			parsed["elements"] = elements
		}
		out, err := json.Marshal(parsed)
		if err != nil {
			return "", err
		}
		return string(out), nil
	}

	if elements == nil {
		elements = []interface{}{}
	}
	doc := map[string]interface{}{
		"type":      "excalidraw",
		"version":   2,
		"source":    "exodeck",
		"page-name": pageName,
		"elements":  elements,
		"appState": map[string]interface{}{
			"viewBackgroundColor": "#ffffff",
		},
		"files": map[string]interface{}{},
	}
	out, err := json.Marshal(doc)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func (s *Server) toolGetWhiteboard(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug      string `json:"slug"`
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	content, status, msg := s.Store.ReadWhiteboardPage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}
	var parsed interface{}
	_ = json.Unmarshal([]byte(content), &parsed)
	return map[string]interface{}{
		"slug":       in.Slug,
		"workspace":  wsName,
		"excalidraw": parsed,
	}, nil
}

func (s *Server) toolCreateWhiteboard(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		PageName  string        `json:"page_name"`
		Workspace string        `json:"workspace"`
		Content   string        `json:"content"`
		Elements  []interface{} `json:"elements"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}

	content, err := buildWhiteboardJSON(strings.TrimSpace(in.PageName), in.Content, in.Elements)
	if err != nil {
		return nil, err
	}

	newSlug, pageName, wSt, wMsg := s.Store.WriteWhiteboardPage("", content, wsName)
	if wSt != 0 {
		return nil, errors.New(wMsg)
	}
	return map[string]interface{}{
		"slug":      newSlug,
		"page_name": pageName,
		"workspace": wsName,
		"status":    "created",
	}, nil
}

func (s *Server) toolUpdateWhiteboard(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug      string        `json:"slug"`
		Workspace string        `json:"workspace"`
		PageName  string        `json:"page_name"`
		Content   string        `json:"content"`
		Elements  []interface{} `json:"elements"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}

	existingContent, status, msg := s.Store.ReadWhiteboardPage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}

	baseContent := in.Content
	if strings.TrimSpace(baseContent) == "" {
		baseContent = existingContent
	}

	content, err := buildWhiteboardJSON(strings.TrimSpace(in.PageName), baseContent, in.Elements)
	if err != nil {
		return nil, err
	}

	newSlug, pageName, wSt, wMsg := s.Store.WriteWhiteboardPage(in.Slug, content, wsName)
	if wSt != 0 {
		return nil, errors.New(wMsg)
	}
	if newSlug != in.Slug {
		_ = s.Store.UpdateLinksAfterPageRename(in.Slug, newSlug, wsName)
	}
	return map[string]interface{}{
		"slug":      newSlug,
		"page_name": pageName,
		"workspace": wsName,
		"status":    "updated",
	}, nil
}

func (s *Server) toolDeleteWhiteboard(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug      string `json:"slug"`
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	if dSt, dMsg := s.Store.DeleteWhiteboardPage(in.Slug, wsName); dSt != 0 {
		return nil, errors.New(dMsg)
	}
	return map[string]interface{}{
		"slug":      in.Slug,
		"workspace": wsName,
		"status":    "deleted",
	}, nil
}

// BPMN tools (.bpmn)

func defaultBpmnXML(pageName string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(pageName))
	escaped := b.String()
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  id="Definitions_1"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" name="%s" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="_BPMNShape_StartEvent_2" bpmnElement="StartEvent_1">
        <dc:Bounds x="173" y="102" width="36" height="36" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`, escaped)
}

func (s *Server) toolGetBpmn(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug      string `json:"slug"`
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	content, status, msg := s.Store.ReadBpmnPage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}
	var parsed map[string]string
	_ = json.Unmarshal([]byte(content), &parsed)
	return map[string]interface{}{
		"slug":      in.Slug,
		"workspace": wsName,
		"page_name": parsed["page-name"],
		"bpmn_xml":  parsed["bpmn_xml"],
	}, nil
}

func (s *Server) toolCreateBpmn(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		PageName  string `json:"page_name"`
		Workspace string `json:"workspace"`
		BpmnXML   string `json:"bpmn_xml"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}

	pageName := strings.TrimSpace(in.PageName)
	if pageName == "" {
		return nil, errors.New("'page_name' is required")
	}
	xmlContent := strings.TrimSpace(in.BpmnXML)
	if xmlContent == "" {
		xmlContent = defaultBpmnXML(pageName)
	}

	payload, _ := json.Marshal(map[string]string{
		"page-name": pageName,
		"bpmn_xml":  xmlContent,
	})

	newSlug, savedName, wSt, wMsg := s.Store.WriteBpmnPage("", string(payload), wsName)
	if wSt != 0 {
		return nil, errors.New(wMsg)
	}
	return map[string]interface{}{
		"slug":      newSlug,
		"page_name": savedName,
		"workspace": wsName,
		"status":    "created",
	}, nil
}

func (s *Server) toolUpdateBpmn(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug      string `json:"slug"`
		Workspace string `json:"workspace"`
		PageName  string `json:"page_name"`
		BpmnXML   string `json:"bpmn_xml"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}

	existingJSON, status, msg := s.Store.ReadBpmnPage(in.Slug, wsName)
	if status != 0 {
		return nil, errors.New(msg)
	}
	var existing map[string]string
	_ = json.Unmarshal([]byte(existingJSON), &existing)

	pageName := strings.TrimSpace(in.PageName)
	if pageName == "" {
		pageName = existing["page-name"]
	}
	xmlContent := strings.TrimSpace(in.BpmnXML)
	if xmlContent == "" {
		xmlContent = existing["bpmn_xml"]
	}

	payload, _ := json.Marshal(map[string]string{
		"page-name": pageName,
		"bpmn_xml":  xmlContent,
	})

	newSlug, savedName, wSt, wMsg := s.Store.WriteBpmnPage(in.Slug, string(payload), wsName)
	if wSt != 0 {
		return nil, errors.New(wMsg)
	}
	if newSlug != in.Slug {
		_ = s.Store.UpdateLinksAfterPageRename(in.Slug, newSlug, wsName)
	}
	return map[string]interface{}{
		"slug":      newSlug,
		"page_name": savedName,
		"workspace": wsName,
		"status":    "updated",
	}, nil
}

func (s *Server) toolDeleteBpmn(_ context.Context, args json.RawMessage) (interface{}, error) {
	var in struct {
		Slug      string `json:"slug"`
		Workspace string `json:"workspace"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	wsName, _, st, errMsg := s.Store.ResolveWorkspace(in.Workspace)
	if st != 0 {
		return nil, errors.New(errMsg)
	}
	if dSt, dMsg := s.Store.DeleteBpmnPage(in.Slug, wsName); dSt != 0 {
		return nil, errors.New(dMsg)
	}
	return map[string]interface{}{
		"slug":      in.Slug,
		"workspace": wsName,
		"status":    "deleted",
	}, nil
}
