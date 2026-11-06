# Page Types

ExoDeck supports four primary types of pages to suit different kinds of information.

## Grid Pages

The default page type is a structured grid designed to organize various types of information into manageable sections.

- You can create **Groups** within a Grid page to categorize your items.
- Inside each Group, you can add different types of **Items**:
  - **Link**: A standard URL bookmark.
  - **Note**: A small, inline Markdown text snippet.
  - **Task**: An actionable item with a checkbox and an optional due date. Overdue and due-soon tasks across visible workspaces are aggregated and surfaced via the notification bell in the top header.
  - **Password**: Securely store credentials with username, password, URL, notes, and optional TOTP authenticator. Includes a built-in password generator and entropy meter.
  - **Encrypted Note**: A Markdown note that is securely encrypted.
- **Security & Vault**: To use **Password** and **Encrypted Note** items, enable the **Master Password Vault** for your workspace in Settings (⚙ -> Workspaces).
  - Employs KeePass-grade cryptography: **Argon2id** key derivation and **AES-256-GCM** authenticated encryption.
  - Credentials and sensitive notes are locked by default and masked until unlocked with your Master Password.
  - Keys remain only in memory while unlocked, automatically locking after 15 minutes of inactivity.
  - Passwords copied to the clipboard are automatically cleared after 30 seconds.
- Click **Edit** to add, remove, or rearrange groups and items on the page.

## Markdown Notes

Notes are dedicated pages for writing long-form text using Markdown.

- Excellent for documentation, journaling, or writing guides.
- Supports rich text formatting, syntax highlighting for code blocks, and diagrams (Mermaid).
- See the [Markdown Features](/Using-Markdown.md) page for examples.

## Whiteboards

Whiteboard pages integrate [Excalidraw](https://excalidraw.com/), providing an endless canvas for sketching and drawing.

- Ideal for flowcharts, diagrams, and visual brainstorming.
- Click **Edit** on a whiteboard page to unlock the drawing tools.
- Data is saved directly as `.excalidraw` JSON files within your workspace.

## Business Processes

Business Process pages integrate [bpmn-js](https://bpmn.io/), providing an interactive environment to view and model BPMN 2.0 diagrams.

- Ideal for process modeling, workflow specification, and business architecture.
- View mode enables smooth navigation, zooming, and panning across the diagram.
- Click **Edit** on a business process page to unlock the modeling tools.
- Data is saved directly as standard `.bpmn` BPMN 2.0 XML files within your workspace.
