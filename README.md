# ExoDeck

[![CI](https://github.com/ExoDeck/exodeck/actions/workflows/ci.yml/badge.svg)](https://github.com/ExoDeck/exodeck/actions/workflows/ci.yml)
[![Go Version](https://img.shields.io/github/go-mod/go-version/ExoDeck/exodeck)](https://golang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **Local-first knowledge management & browser cockpit.**

ExoDeck is a fast, keyboard-driven personal knowledge management (PKM) dashboard and browser start page. It seamlessly brings together bookmark collections, long-form Markdown notes, Excalidraw whiteboards, and BPMN process diagrams into a unified, file-based interface.

Built with a lightweight Go backend and pure vanilla JavaScript/CSS in the frontend, ExoDeck delivers sub-second startup times, full offline support, and zero cloud dependency.

---

## Key Features

- ⚡ **Zero Bloat, Instant Startup**: Pure Go backend serving a vanilla ES2020+ frontend. No heavy frameworks (no React, Angular, or Vue), zero virtual DOM overhead.
- 📁 **100% Local-First & File-Based**: All your data is saved as plain files in local workspace folders:
  - **Grid pages** (`.grid`): Hierarchical dashboards with grouped links and quick notes.
  - **Note pages** (`.md`): Markdown documents with syntax highlighting, auto-sum tables, and media embeds.
  - **Whiteboard pages** (`.excalidraw`): Freeform canvas sketching and visual thinking.
  - **BPMN pages** (`.bpmn`): Structured business process modeling diagrams.
- 🛡️ **Master Password Vault**: KeePass-style master password protection using **Argon2id** key derivation and **AES-256-GCM** encryption. Store passwords, OTP/TOTP secrets, and confidential notes safely without plaintext keys in your configuration.
- ⌨️ **Keyboard-Centric Navigation**: Press `/` to summon the jump search prompt to filter and open pages instantly. Full hotkey coverage for common actions.
- 🔄 **Git-Sync Ready**: Native support for automatic Git commits and sync across workspaces.
- 🌓 **Themes & Typography**: Built-in Dark and Light themes with customizable UI, note, and link font scaling.
- 📦 **Single Self-Contained Binary**: All HTML, CSS, JavaScript, and documentation are embedded directly into the Go executable (`xd` / `xd.exe`).

---

## Quick Start

### 1. Pre-built Binaries

Download the latest executable (`xd.exe` on Windows or `xd` on Linux/macOS) from the [Releases](https://github.com/ExoDeck/exodeck/releases) page.

Run the executable:

```bash
./xd
```

Open your browser to [http://localhost:8000](http://localhost:8000).

### 2. Run from Source

**Prerequisites:** Go 1.25+ and Node.js 22+ (only needed if building or linting frontend assets).

```bash
# Clone the repository
git clone https://github.com/ExoDeck/exodeck.git
cd exodeck

# Run directly
go run .

# Or build the standalone binary
go build -o xd .
./xd
```

---

## Configuration (`config.json`)

On first run, ExoDeck automatically generates a default `config.json` next to the executable if one does not exist.

You can specify a custom directory for `config.json` and data via the `--config-location` or `-cl` command-line flag:

```bash
./xd -cl /path/to/my/workspace
```

A sample configuration ([`config.json.example`](config.json.example)):

```json
{
  "theme": "dark",
  "groupbox_max_width": 420,
  "font_size_ui": 16,
  "font_size_note": 16,
  "font_size_links": 16,
  "port": 8000,
  "workspaces": [
    {
      "name": "Default",
      "path": "./data",
      "hidden": false
    }
  ],
  "enable_git_sync": false,
  "log_level": "info",
  "log_file": ""
}
```

---

## Documentation

ExoDeck includes complete built-in documentation accessible directly inside the application via the **Docs** workspace (or by clicking the `?` icon in the sidebar):

- [About & First Run](docs/About.md)
- [Page Types (`.grid`, `.md`, `.excalidraw`, `.bpmn`)](docs/Page-Types.md)
- [Keyboard Shortcuts](docs/Keyboard-Shortcuts.md)
- [Using Markdown](docs/Using-Markdown.md)
- [License](docs/License.md)

---

## Contributing

Contributions, bug reports, and suggestions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md) before submitting pull requests.

## Security

For security concerns or to report a vulnerability regarding vault encryption or authentication, please refer to our [Security Policy](SECURITY.md).

## License

ExoDeck is open source software licensed under the [MIT License](LICENSE).
Third-party component notices and licenses are documented in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
