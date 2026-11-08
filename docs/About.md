# About

> ExoDeck is a fast, keyboard-driven personal browser start page, dashboard, and lightweight local-first Personal Knowledge Management (PKM) system.
> It combines quick web link collections, rich Markdown notes, freeform Excalidraw whiteboards, and structured BPMN process diagrams into a single, unified interface.

Built with a lightweight Go backend and a vanilla JavaScript and CSS frontend, ExoDeck delivers sub-second startup times, full offline capability, and zero cloud dependency.

## What is ExoDeck?

ExoDeck is designed around three fundamental principles:

1. **Local-First & File-Based**: All your data lives directly on your local filesystem as plain, human-readable files (`.grid`, `.md`, `.excalidraw`, `.bpmn`). There are no databases to maintain, no proprietary formats, and no vendor lock-in.
2. **Fast & Lightweight**: With no heavy frameworks (no React, Angular, or Vue), ExoDeck launches instantly, uses minimal memory, and responds immediately to your input.
3. **Privacy & Security First**: With built-in KeePass-style Master Password vaults utilizing Argon2id and AES-256-GCM encryption, your confidential credentials, OTP secrets, and sensitive notes stay protected on your device.

## Typical Use Cases

- **Browser Start Page & Bookmarks Cockpit**: Replace cluttered browser bookmarks with structured, searchable link dashboards organized into groups and cards.
- **Personal Knowledge Management (PKM)**: Maintain a personal wiki, meeting minutes, daily logs, and technical notes with syntax highlighting, auto-calculating tables, and media embeds.
- **Visual Thinking & Architecture Diagrams**: Sketch system architectures, user journeys, wireframes, and concept maps with infinite-canvas Excalidraw whiteboards.
- **Business Process Modeling**: Document workflows, business procedures, and systems integration flows with interactive standard BPMN 2.0 diagrams.
- **Cross-Workspace Task Tracking**: Keep track of todos and deadlines with an integrated global task list, due-date notifications, and overdue badges.
- **Secure Password & Credential Vault**: Keep login credentials, OTP tokens, and sensitive notes encrypted within workspace vaults without exposing plaintext secrets in configuration files.

## Basic Concepts

### Workspaces

A **Workspace** is an isolated folder on your local drive containing a collection of pages and media files. You can configure multiple workspaces (such as `Default`, `Personal`, `Work`, or `Projects`) to cleanly compartmentalize your data.

Each workspace can have:

- Its own local folder path on your machine.
- A custom SVG icon for quick visual recognition.
- An optional KeePass-grade Master Password vault for encrypting sensitive credentials and notes.
- Automatic Git synchronization to back up and version your pages.

#### Configuring Workspaces

Workspaces can be configured via the web interface or in `config.json`:

1. **In the Web UI**:
   - Open the hamburger menu (**☰**) in the top header and click **Configuration** (or click the gear icon **⚙**).
   - Select the **Workspaces** tab.
   - **Add a Workspace**: Click **+ Add Workspace**, specify a friendly display name (e.g. `Work`), and enter a folder path (absolute or relative to your configuration directory).
   - **Reorder**: Drag and drop the **☰** handle or use the `Up`/`Down` arrow keys while focused on the handle.
   - **Hide / Show**: Check **Hidden** to hide a workspace from navigation without deleting its data.
   - **Custom Icon**: Click on a workspace row to upload a custom `.svg` icon.
   - **Master Password Vault**: Set up or unlock a password vault for credentials and encrypted notes.
   - **Delete**: Click the trash icon to remove a workspace from ExoDeck (your local files on disk are preserved).
2. **In `config.json`**:
   Workspaces are defined under the `"workspaces"` key:

   ```json
   "workspaces": [
     {
       "name": "Personal",
       "path": "./data",
       "hidden": false
     },
     {
       "name": "Work",
       "path": "C:\\Users\\Username\\Documents\\WorkDeck",
       "hidden": false
     }
   ]
   ```

#### Using Workspaces

- **Switching**:
  - Click any workspace name in the header strip at the top of the sidebar.
  - Press the **`#`** shortcut key anywhere to open the quick Workspace Switcher popup, filter by name, and press `Enter`.
  - Open the floating navigator (**`.`**) and click a workspace icon or press `ArrowRight` / `ArrowLeft`.
- **Creating Pages**:
  - When a workspace is active, create pages inside it using the hamburger menu (**☰**) or single-key shortcuts:
    - **`g`**: New Grid dashboard page
    - **`q`**: New Markdown Note page
    - **`w`**: New Excalidraw Whiteboard page
    - **`b`**: New BPMN Process Diagram

### Page Types

ExoDeck supports four native page types to fit different workflows:

- **Grid Pages (`.grid`)**: Customizable card layouts containing bookmarks, quick notes, tasks with due dates, and encrypted credentials.
- **Note Pages (`.md`)**: Full Markdown documents supporting code syntax highlighting, auto-sum tables, task lists, and image paste.
- **Whiteboard Pages (`.excalidraw`)**: Visual sketching, mind maps, and diagrams powered by Excalidraw.
- **Process Diagrams (`.bpmn`)**: Interactive business process diagrams powered by bpmn-js.

For detailed information on each type, explore the [Page Types](Page-Types.md) and [Using Markdown](Using-Markdown.md) guides.

### Hierarchical Virtual Folders

You can organize pages hierarchically by inserting slashes (`/`) into page titles. For example, naming a page `Projects / ExoDeck / Roadmap` will automatically group it into a collapsible folder tree in the sidebar.

### Help & Documentation Mode

When launching ExoDeck for the first time or when no user workspaces contain pages, **Help** mode is automatically enabled so you can read this documentation.

You can toggle Help on or off anytime via **Help** / **Hide Help** in the hamburger menu (**☰**). When Help is active, the built-in read-only **ExoDeck** workspace appears alongside your personal workspaces.

For navigation workflows, menu overviews, and shortcuts, see the [Help & Navigation Guide](Help.md) and [Keyboard Shortcuts](Keyboard-Shortcuts.md).
