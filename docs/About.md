# About

ExoDeck is a personal browser start page and a lightweight Personal Knowledge Management (PKM) System. It allows you to organize web links, notes, whiteboard sketches, and diagrams using a fast, file-based architecture.

## Installation

ExoDeck is built with Go, meaning it compiles to a single, lightweight executable binary with no external runtime dependencies.

**To install via script:**

- **Linux & macOS:**

  ```bash
  curl -fsSL https://raw.githubusercontent.com/ExoDeck/exodeck/main/scripts/install.sh | bash
  ```

- **Windows (PowerShell — No Admin Required):**

  ```powershell
  irm https://raw.githubusercontent.com/ExoDeck/exodeck/main/scripts/install.ps1 | iex
  ```

**To build from source:**

1. Ensure you have Go 1.25+ installed on your system.
2. Clone the repository and navigate into the folder:

   ```bash
   git clone https://github.com/ExoDeck/exodeck.git
   cd exodeck
   ```

3. Run the application directly or compile it:

   ```bash
   go run .
   # OR
   go build -o xd
   ./xd
   ```

## First Run

When you launch ExoDeck for the very first time, it does the following automatically:

- Creates its working directory and default `config.json` in `~/.exodeck` (`$HOME/.exodeck` on Linux/macOS, `%USERPROFILE%\.exodeck` on Windows).
- Initializes a default workspace folder at `~/.exodeck/data`.
- Boots up a local web server (by default on port `8000`).
- Opens with the built-in, readonly **Docs** workspace displayed so you can read this documentation.

To access the app, simply open your web browser and navigate to:
[http://localhost:8000](http://localhost:8000)

## Configuration (`config.json`)

All settings for ExoDeck are stored in `config.json`. By default, this file lives in `~/.exodeck/config.json`.
The binary `xd` can be installed anywhere, including system folders (`/usr/local/bin`, `C:\Program Files\ExoDeck`, etc.).
If you want to specify a custom directory for your config, cache, and workspaces, launch the app with the `--config-location` or `-cl` flag:

```bash
xd --config-location /path/to/my/data
```

### Important Settings

You can modify `config.json` manually or via the Settings menu in the web interface (accessible via the gear icon).

- **`port`**: The HTTP port the server listens on (default: `8000`).
- **`theme`**: Set to `"dark"` or `"light"`.
- **`log_level`**: Controls the verbosity of application logs. Valid options are `"debug"`, `"info"`, `"warn"`, and `"error"` (default: `"info"`).
- **`log_file`**: Specify a file path to log output to a file instead of, or in addition to, the console. If omitted or empty, logs will only print to the console.
- **`workspaces`**: An array of directories where your page data (JSON and Markdown files) is stored.
  > **Master Password Vault:** Workspaces can be protected with a KeePass-style Master Password.
  > Sensitive credentials (passwords, usernames, URLs, notes, OTP secrets, and encrypted notes) are encrypted using Argon2id and AES-256-GCM.
  > When sharing a workspace folder or Git repo with a team, members only need to share the workspace's Master Password—no plaintext keys are stored in `config.json`.
  > Legacy Fernet keys can be migrated to Master Password vaults with one click.
  > For full cryptographic details, see the [Password Vault & Encryption Guide](Password-Vault.md).
- **`enable_git_sync`**: If set to `true`, ExoDeck will attempt to automatically commit and sync changes using Git for any workspace initialized as a Git repository.
- **Font Sizes**: Adjust `font_size_ui`, `font_size_note`, and `font_size_links` to customize the typography scale across the app.

Once your workspace is configured, you can collapse the Docs workspace by clicking the `?` icon in the sidebar, and begin creating your own pages!
