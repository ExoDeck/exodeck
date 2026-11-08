# Help & Navigation Guide

Welcome to ExoDeck! This guide explains how to navigate the application, use the menu system, organize and switch between pages, and configure multiple workspaces.

---

## The Hamburger Menu (☰)

The hamburger button (**☰**) located in the top-left corner of the header opens the primary action menu. You can also open actions with their respective keyboard shortcuts.

### Menu Options

- **Add Page**:
  - **Add Grid (`g`)**: Creates a new grid dashboard page for organizing web links, bookmarks, and quick notes in customizable group boxes.
  - **Add Note (`q`)**: Creates a new full-page Markdown document with a built-in outline and WYSIWYG editor.
  - **Add Whiteboard (`w`)**: Creates an Excalidraw freehand drawing and diagramming whiteboard.
  - **Add Business Process (`b`)**: Creates a BPMN 2.0 process modeling diagram.
- **Navigator (`.`)**: Opens or toggles the floating navigator palette.
- **Switch Workspace (`#`)**: Opens the quick workspace search and selection overlay.
- **Tasks (`t`)**: Toggles the global Task drawer showing upcoming and overdue tasks across all workspaces.
- **Git Sync**: If Git synchronization is enabled for the active workspace, triggers a manual commit and sync.
- **Configuration**: Opens the main configuration modal (general appearance, themes, font sizing, and workspace management).
- **Help / Hide Help**: Toggles the built-in, read-only **ExoDeck** workspace. When Help is active, documentation pages appear in your sidebar alongside your regular workspaces. When other workspaces have pages, you can click **Hide Help** to return exclusively to your pages.

---

## Switching Between Pages

ExoDeck provides several fast ways to navigate between pages:

### 1. Sidebar Tree Navigation

- The left sidebar displays a hierarchical list of all pages in the active workspace.
- **Hierarchy via Slashing (`/`)**: You can organize pages into nested folders simply by including slashes in the page title (for example, `Work / Projects / Q4-Roadmap`). Folders can be expanded or collapsed.
- Click any page name to open it immediately.
- Use the **`x`** shortcut to collapse or expand all groups at once.

### 2. Global Search Overlay (`/`)

- Press the forward slash (**`/`**) key anywhere in the app to open the global quick search.
- Search matches both page names and individual links/items across your workspace.
- Use `ArrowUp` / `ArrowDown` to navigate results, and press `Enter` to load the selected item.

### 3. Floating Navigator (`.`)

- Press the period (**`.`**) key to open the compact floating navigator palette.
- Navigate the full page tree using `ArrowUp` / `ArrowDown`, expand or collapse folders with `ArrowRight` / `ArrowLeft`, or switch workspaces with `Home` and arrow keys.
- Press `Enter` to open a page in the current tab, or `Ctrl` + `Enter` (`Cmd` + `Enter` on macOS) to open it in a new browser tab.

### 4. Direct URLs and Browser History

- Every page has a bookmarkable URL (e.g. `http://localhost:8000/Work/my-page` or `http://localhost:8000/ExoDeck/About`).
- The browser **Back** and **Forward** buttons work seamlessly to step through your page history.

---

## Workspaces

Workspaces are separate root storage folders on your filesystem. They allow you to cleanly isolate different projects, personal life, or work-related documents.

### Configuring Workspaces

#### Through the Web Interface

1. Click the hamburger menu (**☰**) and select **Configuration** (or click the gear icon **⚙**).
2. Click the **Workspaces** tab in the dialog.
3. Manage your workspaces:
   - **Add Workspace**: Click **+ Add Workspace**. Enter a descriptive name (e.g. `Work` or `Research`) and the filesystem path (absolute like `/home/user/notes` or `D:\WorkDeck`, or relative to your config directory like `./data`).
   - **Reorder**: Drag the **☰** handle on any workspace row, or focus the handle and use `ArrowUp` / `ArrowDown` to adjust workspace ordering.
   - **Hide / Unhide**: Check the **Hidden** box to conceal a workspace from the navigation bars without deleting your data.
   - **Custom Icon**: Click on an existing workspace to edit it and upload a custom `.svg` icon for instant recognition in headers and switchers.
   - **Master Password Vault**: Enable KeePass-style Argon2id + AES-256-GCM encryption for credentials, OTP secrets, and sensitive notes. See the [Password Vault Guide](Password-Vault.md).
   - **Delete**: Click the trash can icon to remove a workspace entry from ExoDeck (your underlying files on disk are never deleted).
4. Click **Save** to apply your changes.

#### In `config.json`

Workspaces can also be declared directly in `config.json` (located at `~/.exodeck/config.json` by default):

```json
"workspaces": [
  {
    "name": "Personal",
    "path": "./data",
    "hidden": false
  },
  {
    "name": "Work",
    "path": "/home/user/work-notes",
    "hidden": false
  }
]
```

---

## Switching Between Workspaces

When you have multiple workspaces configured, switching between them is instantaneous:

1. **Workspace Header Bar**: Click any workspace name in the header list displayed at the top of the left sidebar.
2. **Workspace Switcher Overlay (`#`)**:
   - Press the hash (**`#`**) key anywhere in the app to open the dedicated workspace switcher popup.
   - Type to filter your workspaces in real-time, then press `Enter` to jump directly to it.
3. **Floating Navigator Header (`.`)**:
   - Open the floating navigator with **`.`**.
   - Click the workspace icon tabs across the top, or use `ArrowLeft` / `ArrowRight` while the header is focused to cycle between workspaces.
4. **Hamburger Menu**:
   - Open **☰** and click **Switch Workspace (`#`)**.

---

## Help & Documentation Mode

- **Automatic Onboarding**: When you first run ExoDeck or when no user workspaces contain pages, **Help** mode is automatically active, displaying the built-in **ExoDeck** workspace.
- **Toggling Help**: You can toggle the documentation on or off at any time using **☰ -> Help / Hide Help**.
- When Help is turned on, the **ExoDeck** workspace appears in your workspace selector, letting you browse documentation, shortcut references, and feature guides without interrupting your work.
