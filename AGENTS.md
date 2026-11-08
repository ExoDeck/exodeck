# AGENTS.md — ExoDeck

> This file provides context and conventions for AI coding agents (Copilot, Antigravity, Cursor, etc.) working on this repository.

---

## Project Overview

**ExoDeck** is a personal browser start page and local-first personal knowledge management (PKM) system with collections of web links, notes, whiteboards, and diagrams.

- **Backend**: Go — serves the frontend as static files and exposes a REST API for managing page data.
- **Frontend**: Vanilla JavaScript + CSS (no frameworks) located in `frontend/`.
- **File-based storage** - locations can be defined in config.json. By default, files are stored under `data/` — one file per page (Grid pages use `.grid`, note pages use `.md`, whiteboard pages use `.excalidraw`, BPMN diagrams use `.bpmn`).

---

## Tech Stack

| Layer    | Technology                                          |
|----------|-----------------------------------------------------|
| Backend  | Go 1.21+, Chi router, standard library              |
| Frontend | Vanilla JavaScript (ES2020+), Vanilla CSS           |
| Storage  | Local filesystem — .grid files in data/             |
| Markdown | `marked.js` (installed locally, no CDN)             |
| Testing  | Go testing package                                  |

> **Forbidden:** Angular, React, Vue, jQuery, Bootstrap, Tailwind, or any other large JS/CSS framework or library.  
> All JS dependencies must be installed locally and served from `frontend/vendor/` — **no CDN references anywhere**.

**Exceptions of the NO-CDN rule:**

- Excalidraw
- bpmn-js

---

## Agent tool usage

- Don't use cat or grep to read files, use internal tool instead so I don't have to give permissions on every file access in the workspace

## Agent workflow

- When the task is done, do **NOT** commit to git, let the user review it first

## Coding Conventions

### Go (backend)

- Follow standard Go conventions and `gofmt`.
- Use standard library where possible.
- API base path: `/api/v1/`.
- All file I/O via helpers in `internal/storage`.
- Use proper error handling.
- Write tests for all handlers.

### JavaScript (frontend)

- Use ES2020+ (modules, `async/await`, optional chaining).
- Variable and function names: `camelCase`.
- Constants: `UPPER_SNAKE_CASE`.
- No `var`; prefer `const`, use `let` only when reassignment is needed.
- DOM manipulation via direct APIs (`document.createElement`, etc.) — no virtual DOM.

### CSS

- BEM-like naming: `.block__element--modifier`.
- All colours and spacing via CSS custom properties defined on `:root` and `[data-theme="light"]`.
- Dark theme is the default (defined on `:root`).
- Mobile-first responsive design.

**Important notes:**

- Items are either **links** (have `url`) or **notes** (have `text`). Never both.
- `text` is Base64-encoded Markdown content.
- Groups and items are always displayed sorted alphabetically by `title`.

---

## Definition of done

- All go unit test passing
- All linters passing
- docs are updated (e.g. when new shortcuts are added update Keyboard-Shortcuts.md)

---

## Running the App

```bash
# Start the backend
go run .
# App available at http://localhost:8000

# Run tests
go test ./...
```

## Testing

- Unit Tests shall be created by the agent
- UI Verification shall be done manually

## Validation

Before completing tasks please run:

- All unit test
- Linters by executing lint.ps1
