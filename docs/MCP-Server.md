# MCP Server Integration

ExoDeck includes a built-in **Model Context Protocol (MCP)** server integrated directly into the single `xd` binary.
AI coding assistants and desktop agents (such as Claude Desktop, Claude Code, Cursor, Antigravity, and Windsurf) can query your workspaces, search pages and tasks, and create or update Grid pages, Markdown notes, Excalidraw whiteboards, and BPMN 2.0 diagrams without any extra executable.

## Transport Modes

ExoDeck supports two standard MCP transport modes out of the box:

### 1. Streamable HTTP / SSE (Recommended while ExoDeck is running)

When ExoDeck is running (default port `8000`), the MCP server is mounted at:

- `http://localhost:8000/mcp` (and `/api/v1/mcp`)
- Legacy SSE endpoint: `http://localhost:8000/mcp/sse`

Connecting over HTTP shares the live in-memory cache and index with the ExoDeck Web UI, so any pages, groups, or items created via MCP appear immediately in your browser.

Example HTTP MCP configuration:

```json
{
  "mcpServers": {
    "exodeck": {
      "url": "http://localhost:8000/mcp"
    }
  }
}
```

### 2. Stdio Mode (`--mcp`)

You can also let your MCP client launch ExoDeck directly over `stdin`/`stdout` using the `--mcp` (or `-mcp`) flag:

```bash
xd --mcp
```

You can combine `--mcp` with `-cl` / `--config-location` to point to a custom configuration directory:

```json
{
  "mcpServers": {
    "exodeck": {
      "command": "xd",
      "args": ["--mcp", "-cl", "/path/to/config"]
    }
  }
}
```

In `--mcp` mode, all application logs are routed to `stderr` so `stdout` remains reserved strictly for JSON-RPC 2.0 messages.

## Security & Privacy Guardrails

1. **Zero Exposure of Vault Credentials & Encrypted Notes**:
   - The MCP server does **not** expose any tools to unlock vaults, read passwords, generate OTP codes, or read encrypted notes.
   - When reading Grid pages via `get_grid_page`, any `password` or `enc_note` items are automatically masked (`locked: true`) and their encrypted fields are stripped, even if the vault is currently unlocked in the Web UI.
   - Creating, modifying, or deleting encrypted/password items via MCP is blocked to prevent accidental data loss.
2. **Hidden Workspaces & Pages Excluded by Default**:
   - All discovery, search, and task tools (`list_workspaces`, `list_pages`, `search`, `list_tasks`) exclude hidden workspaces and hidden pages by default.
   - Pass `"include_hidden": true` to include hidden workspaces and pages when explicitly needed.
3. **Plain Markdown Ergonomics**:
   - Grid note and task item bodies (`markdown`) are automatically decoded from Base64 into plain Markdown when read and automatically Base64-encoded when written.

## Available Tools (38 Tools)

### Workspaces & Configuration

| Tool | Description |
| --- | --- |
| `list_workspaces` | List configured workspaces with paths, visibility, and page counts (`include_hidden` optional). |
| `create_workspace` | Create and register a new workspace directory in `config.json`. |
| `update_workspace` | Rename, repath, or toggle `hidden` on an existing workspace. |
| `delete_workspace` | Remove a workspace entry from `config.json` (files on disk are preserved). |
| `get_config` | Read non-sensitive application settings from `config.json`. |
| `update_config` | Update theme, font sizes, `groupbox_max_width`, or `enable_git_sync`. |

### Discovery, Global Search & Tasks

| Tool | Description |
| --- | --- |
| `list_pages` | List pages across one or all workspaces with optional `page_type` and `include_hidden` filters. |
| `search` | Search page titles, note contents, and grid items across workspaces. |
| `list_tasks` | List all unchecked tasks (`filter: "all"`) or only overdue/due-soon tasks (`filter: "due"`). |
| `move_page` | Move any page (`grid`, `note`, `whiteboard`, or `bpmn`) to another workspace. |

### Grid Pages (`.grid`), Groups & Items

| Tool | Description |
| --- | --- |
| `get_grid_page` | Read a Grid page, its groups, and its items (with plain-text Markdown and masked secrets). |
| `create_grid_page` | Create a new Grid page with optional initial groups and items. |
| `update_grid_page` | Update a Grid page's name, `hidden`, `custom_sort`, or groups (auto-updates internal links on rename). |
| `delete_grid_page` | Delete a Grid page. |
| `add_group` | Append a new group (with optional items) to a Grid page. |
| `update_group` | Rename or update a group at `group_index`. |
| `delete_group` | Delete a group at `group_index` from a Grid page. |
| `move_group` | Move a group to another Grid page in the same or another workspace. |
| `add_item` | Add a `link`, `note`, or `task` item to a group (by `group_index` or `group_title`). |
| `update_item` | Update an item's title, URL, notes, Markdown, `task_checked`, or `task_due_date`. |
| `delete_item` | Delete a non-encrypted item from a group. |
| `move_item` | Move an item between groups on the same Grid page. |

### Markdown Notes (`.md`) & Media

| Tool | Description |
| --- | --- |
| `get_note` | Read the Markdown content of a Note page. |
| `create_note` | Create a new Markdown Note page (auto-inserts `# Title` when `title` is provided). |
| `update_note` | Replace or append (`append: true`) Markdown content on a Note page. |
| `delete_note` | Delete a Note page and clean up its referenced media files. |
| `list_media` | List media attachments uploaded to a page's subfolder. |
| `delete_media` | Delete a media file from a page's subfolder. |

### Excalidraw Whiteboards (`.excalidraw`)

| Tool | Description |
| --- | --- |
| `get_whiteboard` | Read the Excalidraw JSON structure of a Whiteboard page. |
| `create_whiteboard` | Create a new Whiteboard page from `page_name` (and optional `elements` or `content`). |
| `update_whiteboard` | Update a Whiteboard page's title, `elements`, or raw JSON `content`. |
| `delete_whiteboard` | Delete a Whiteboard page. |

### Business Process Diagrams (`.bpmn`)

| Tool | Description |
| --- | --- |
| `get_bpmn` | Read a BPMN 2.0 diagram's `page_name` and `bpmn_xml`. |
| `create_bpmn` | Create a new BPMN 2.0 page (uses a starter BPMN 2.0 XML template if `bpmn_xml` is omitted). |
| `update_bpmn` | Update a BPMN 2.0 page's `page_name` and/or `bpmn_xml`. |
| `delete_bpmn` | Delete a BPMN 2.0 page. |

### Git Synchronization

| Tool | Description |
| --- | --- |
| `git_sync_status` | Check Git repository and uncommitted change status for one or all workspaces. |
| `git_sync` | Run Git auto-sync (`add`, `commit`, `pull --rebase`, `push`) and reload workspace cache. |
