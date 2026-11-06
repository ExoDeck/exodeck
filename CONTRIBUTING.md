# Contributing to ExoDeck

Thank you for your interest in contributing to ExoDeck! We appreciate your help in building a fast, private, and delightful local-first knowledge cockpit.

---

## Code of Conduct

All contributors and participants are expected to adhere to the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Architectural Principles

Before contributing code, please keep our core tenets in mind:

1. **Zero Bloat & No Large JS Frameworks**:
   - The frontend is built strictly with **Vanilla JavaScript (ES2020+)** and **Vanilla CSS**.
   - No React, Vue, Angular, Svelte, jQuery, Tailwind, or Bootstrap.
   - All third-party JS/CSS must be locally vendored in `frontend/vendor/` with **no CDN dependencies** (with exceptions only for Excalidraw and bpmn-js).
2. **Local-First & Privacy First**:
   - Data belongs to the user and is stored as readable, portable files in local folders.
   - Secrets must always be protected via the Master Password vault (Argon2id + AES-256-GCM).
3. **Single Self-Contained Binary**:
   - The frontend assets, icons, and documentation are embedded via Go `embed`. The resulting executable must run without external runtime files.

---

## Development Setup

### Prerequisites

- **Go 1.25+**
- **Node.js 22+** (for ESLint and MarkdownLint)
- **PowerShell 7+** (optional, for convenience scripts)

### Getting Started

```bash
# 1. Clone the repository
git clone https://github.com/ExoDeck/exodeck.git
cd exodeck

# 2. Install dev dependencies (linters)
npm install

# 3. Run the development server
go run .
```

Navigate to `http://localhost:8000`.

---

## Verification & Testing

Before submitting a pull request, ensure all tests and linters pass cleanly:

```bash
# Run Go unit tests
go test -v ./...

# Run ESLint (frontend JS)
npm run lint:js

# Run markdownlint (documentation)
npm run lint:md

# Or run everything via PowerShell
.\lint.ps1
```

---

## Commit Guidelines (Conventional Commits)

ExoDeck uses an automated versioning workflow based on commit message prefixes:

- `feat:` or `feat(...):` &rarr; Introduces a new feature (triggers a **minor** version bump, e.g. `0.38.0` &rarr; `0.39.0`).
- `fix:` or `fix(...):` &rarr; Fixes a bug (triggers a **patch** version bump, e.g. `0.38.0` &rarr; `0.38.1`).
- `major:` or `feat!:` &rarr; Breaking change (triggers a **major** version bump, e.g. `0.38.0` &rarr; `1.0.0`).
- `chore:`, `docs:`, `refactor:`, `test:` &rarr; Maintenance, documentation, or internal updates.

---

## Submitting a Pull Request

1. Fork the repository and create your branch from `main`:

   ```bash
   git checkout -b feat/my-new-feature
   ```

2. Write tests for any new backend handlers or storage logic.
3. Keep code formatted:
   - Go: `gofmt`
   - Frontend: Follow standard ESLint rules.
4. Push to your fork and submit a Pull Request describing your changes.
