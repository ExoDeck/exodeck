# ExoDeck UX & UI Design Proposals

> **Document Version**: 1.0  
> **Status**: Review & Decision Phase  
> **Target Application**: ExoDeck (Personal Browser Start Page & Knowledge Hub)  
> **Tech Stack Guardrails**: Vanilla JavaScript (ES2020+), Vanilla CSS (no frameworks), Go backend, local filesystem storage, no CDN dependencies (except Excalidraw).

---

## 1. Executive Summary & Vision

The objective is to transform **ExoDeck** from a pragmatic, functional start page into a **tactile, modern, and delightful daily dashboard**—an application that brings immediate visual clarity and joy every time a new browser tab is opened.

ExoDeck already possesses extraordinary foundations:

* **Blazing startup speed** (vanilla JS/CSS with zero framework overhead).
* **Keyboard-first ergonomics** (`/`, `s`, `e`, `+`, `o`, `#`).
* **Rich content diversity** (Bookmarks, Inline Notes, Scheduled Tasks, Markdown Docs, Excalidraw Whiteboards, Fernet Passwords).
* **Local-first data privacy**.

This document outlines **four distinct design directions**—starting with the **User's Floating Navigator** concept, followed by three complementary system paradigms.

---

## 2. Current State UX Audit

| Aspect | Current Experience | Opportunity for Joy & Polish |
| :--- | :--- | :--- |
| **Layout & Space** | Fixed 220px left sidebar is visible even when idle, reducing grid and whiteboard canvas width. | **Reclaim 100% viewport width** with a unified top header and floating/pinnable navigation. |
| **Visual Hierarchy** | All group boxes share identical width, flat dark background, and uniform grey borders ("sea of grey cards"). | **Bento-style card hierarchy**, variable column spans, and subtle color accents. |
| **Link Ergonomics** | Links display plain text with a generic `open_in_new` icon. Every link looks the same. | **Automatic domain favicons** and recognizable visual badges for rapid 50ms spatial recognition. |
| **Interaction Flow** | Adding or editing items requires modal overlays, interrupting flow. Checking tasks lacks kinetic feedback. | **Inline direct editing**, keyboard capture shortcuts, and springy, tactile micro-animations. |
| **Header Redundancy** | Sidebar header and page content header are disconnected, creating stacked horizontal lines. | **Unified Horizon Header** connecting workspace identity, page title, and actions in a single scan line. |

---

## 3. Idea 1: "The Horizon Header & Floating Navigator" (User Idea)

### Core Philosophy

Eliminate the persistent vertical sidebar by default to maximize horizontal content area. Consolidate navigation and context into a single, elegant **Horizon Header Line**, with an on-demand **Floating Navigator Card** triggered by hover or keyboard shortcut, capable of being pinned when desired.

```text
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ╭───╮                                                                                                 │
│  │ ⚡│ Main Workspace  ▾  [···]   │   🚀 Project Alpha         [✎ Edit]  [+ Add]  [🔀 Sort]  [⚙ Config]│
│  ╰───╯                                                                                                 │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────┐                                                                     │
│  │ 📂 NAVIGATOR            [📌] │                                                                     │
│  │ ───────────────────────────── │                                                                     │
│  │ 🔍 Filter pages...            │         [ CONTENT GRID TAKES 100% OF SCREEN WIDTH ]                 │
│  │                               │                                                                     │
│  │  ▾ 📁 Personal                │   ┌─────────────────────┐  ┌─────────────────────┐                  │
│  │    • Bookmarks                │   │ ⚡ Quick Links       │  │ ☕ Daily News       │                  │
│  │    • Reading List             │   │ • GitHub             │  │ • Hacker News       │                  │
│  │  ▾ 📁 Work                    │   │ • Vercel             │  │ • lobste.rs         │                  │
│  │    • 🚀 Project Alpha  [●]    │   └─────────────────────┘  └─────────────────────┘                  │
│  │    • 📝 Tech Specs            │                                                                     │
│  │    • 🎨 Brainstorm (Canvas)   │   ┌───────────────────────────────────────────────┐                  │
│  │  + New Page (q)               │   │ 🎯 Tasks (Overdue / Today)                    │                  │
│  └───────────────────────────────┘   └───────────────────────────────────────────────┘                  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Key Components & Interaction Flow

#### 1. The Unified Horizon Header

* **Circle Workspace Icon**:
  * 36px circular avatar in the top-left holding the workspace icon or initials with an accent ring.
  * Clicking toggles the Floating Navigator immediately (or keyboard shortcut `.`).
* **Workspace Name & Actions**:
  * `Workspace Name ▾`: Click opens the workspace switcher popover (or shortcut `#`).
  * `[···]` Menu: Access workspace settings, git sync status, and folder view toggles.
* **Vertical Separator `|`**:
  * Semi-transparent border (`1px solid var(--color-border)`) visually dividing **Global Scope** (Workspace) from **Current Scope** (Active Page).
* **Page Title & Action Buttons**:
  * `Page Title` (`h1`) with inline rename support upon double click.
  * Right-aligned actions: `[✎ Edit]`, `[+ Add Item]`, `[🔀 Custom Sort]`, `[⚙ Config]`.

#### 2. The Floating Navigator (Flyout Card)

* **Visual Style**: Elevated glassmorphism island with blur and soft shadow:

  ```css
  background: rgba(19, 19, 19, 0.88);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
  border-radius: 12px;
  ```

* **Built-in Quick Filter**: Instant filter field at the top of the flyout to search 20+ pages quickly.
* **Full Tree Hierarchy**: Displays folders, subpages, unread badges, and overdue task status indicators.

#### 3. Pinned vs. Unpinned Mode

* **Pin Button `[📌]`**: Located at the top right of the Navigator.
* **When Unpinned (Default)**: Floats gracefully over content; auto-dismisses when clicking outside, navigating to a page, or pressing `Esc`.
* **When Pinned**: Docked as a persistent left sidebar with smooth transition (`transition: width 0.2s ease`).
* **Persistence**: Preference is saved in `localStorage` (`navigator-pinned: true/false`).

#### 4. Keyboard Shortcuts for Horizon Navigator

* **`.` (Period)**: Toggle Floating Navigator. Directly focuses active page.
* **`ArrowUp` / `ArrowDown`**: Navigate page list.
* **`ArrowRight` / `ArrowLeft`**: Expand / collapse folder trees.
* **`Enter`**: Open selected page (auto-closes flyout if unpinned).
* **`Shift + P`**: Toggle Pin state.
* **`Esc`**: Dismiss Navigator.

---

## 4. Idea 2: "The Modern Bento Cockpit"

### Core Philosophy

Turn the uniform grid of grey cards into an expressive, magazine-styled **Bento Grid Dashboard** inspired by modern Apple and Linear interfaces. Emphasizes spatial recognition, rich domain favicons, and tactile micro-animations.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🚀 WORKSPACE / MAIN      │ ⚡ QUICK TOOLS           │ ☕ DAILY READS        │
│ ┌──────────────────────┐ │ ┌──────────────────────┐ │ ┌───────────────────┐ │
│ │ [🐙 GitHub]   4 PRs  │ │ │ [🌐 Google Search]   │ │ │ [📰 Hacker News]  │ │
│ │ [▲ Vercel]   Prod OK │ │ │ [📊 Analytics]       │ │ │ [🎨 Smashing Mag] │ │
│ │ [💬 Slack]    Team   │ │ │ [🔑 Vault]  Fernet 🔒│ │ │ [📚 Readwise]     │ │
│ └──────────────────────┘ │ └──────────────────────┘ │ └───────────────────┘ │
├──────────────────────────┴──────────────────────────┴───────────────────────┤
│ 🎯 TODAY'S FOCUS  (3/5 Done) ━━━━━━━━━━━●━━━━━                              │
│  ☑ Review pull request for storage migration                                │
│  ☐ Update AGENTS.md documentation                                           │
│  ☐ Test keyboard navigation overlay                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Features

1. **Bento Card Hierarchy & Variable Spans**:
   * Groups can be styled with subtle color badges or custom category emojis (e.g., 🚀 *Work*, ☕ *Daily*, ⚡ *Utilities*).
   * High-priority groups can span **2 columns** or **full width**, breaking monotony and establishing natural focal points.
2. **Domain Favicons & Visual Badges**:
   * Instead of generic `open_in_new` icons, display crisp domain favicons (cached locally or fetched via domain icon utilities).
   * Spatial memory allows clicking GitHub, YouTube, or Jira in 50ms without reading text labels.
3. **Tactile Micro-interactions ("The Juice")**:
   * **Satisfying Task Completion**: Checking off a task triggers a springy checkbox bounce with a smooth strikethrough animation.
   * **Progress Rings / Mini Bars**: Groups containing tasks display a compact progress ring in their header (`4/5 done`).
   * **Card Hover Elevation**: Soft lift effect (`transform: translateY(-2px)`) with glowing border highlight.

---

## 5. Idea 3: "The Flow State Command Center"

### Core Philosophy

Targeted at developers and keyboard power-users who want **zero latency** between thought and capture, eliminating modal interruptions inspired by Raycast and Obsidian.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ [ / ]  Search pages, run commands, or type "+t Buy coffee tomorrow" ...     │
├─────────────────────────────────────────┬───────────────────────────────────┤
│ 📂 DEV WORKSPACE                        │ 📝 SCRATCHPAD (Ctrl+J)            │
│ • [g] Go Docs              (api.golang) │ ┌───────────────────────────────┐ │
│ • [r] Repositories         (github.com) │ │ • Chi router profiling notes  │ │
│ • [l] Localhost:8000       (local test) │ │ • Keynav overlay bug on Safari│ │
│ 📌 SPRINTS & TASKS                      │ └───────────────────────────────┘ │
│ [x] Fix fernet key decryption           │                                   │
│ [ ] Add table picker shortcut           │ 💡 Quick-Look: Press 'Space'      │
└─────────────────────────────────────────┴───────────────────────────────────┘
```

### Key Features

1. **Raycast-Style Omni-Command Palette (`/`)**:
   * Enhances the search overlay to accept command syntax:
     * `+l https://news.ycombinator.com HN` ➔ Immediately adds link to active group without opening a modal.
     * `+t Refactor API due:tomorrow` ➔ Instantly appends a scheduled task.
     * `ws personal` ➔ Switches workspace directly.
2. **Global Floating Scratchpad (`Ctrl + J` / `Cmd + J`)**:
   * Slide-in Markdown drawer accessible anywhere in ExoDeck for quick paste dumps, temporary phone numbers, or scratch thoughts.
3. **Frictionless Inline Direct Manipulation**:
   * Double-click any title or link label to edit inline.
   * `Spacebar` on any note opens a clean **Quick-Look floating popover** without changing pages.
   * `Alt + ArrowUp/ArrowDown` directly reorders items under cursor without entering an explicit "Edit Mode".

---

## 6. Idea 4: "Adaptive Zen Workspaces"

### Core Philosophy

ExoDeck holds three distinct media forms: Bookmarks, Long-form Markdown, and Excalidraw Canvases. This concept adapts the application's layout dynamically to match the active task.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ [≡] Work  |  View: [ ▦ Launchpad ]  [ 📋 Kanban Board ]  [ 📖 Zen Focus ]    │
├─────────────────────────────────────────────────────────────────────────────┤
│   BACKLOG (3)              IN PROGRESS (2)          DONE (5)                │
│ ┌──────────────────────┐  ┌──────────────────────┐  ┌─────────────────────┐ │
│ │ ⚡ Refactor chi router│  │ 🎨 Redesign dark UI  │  │ ✔ Markdown tables   │ │
│ │ 📅 Due in 2 days     │  │ 💬 In review         │  │ ✔ Whiteboard sync   │ │
│ └──────────────────────┘  └──────────────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Features

1. **Three Switchable View Modes for Grid Pages**:
   * **Launchpad Mode**: Optimized for fast click launching and compact bookmark density.
   * **Kanban / Focus Mode**: Groups act as pipeline stages (*Backlog / In Progress / Done*), turning ExoDeck into a personal task board.
   * **Zen Canvas Mode**: For Markdown notes and Whiteboards, toolbars and chrome gently fade out, leaving a pure reading and sketching canvas.
2. **Workspace Personas**:
   * Custom color themes per workspace (e.g. Electric Cobalt for *Engineering*, Warm Espresso for *Personal*, Lavender for *Ideation*).
3. **Collapsible Accordion Groups**:
   * Ability to fold less-frequently-used group boxes into sleek pill headers (`Dev Tools (12)`), preventing visual clutter.

---

## 7. Comparative Analysis Matrix

| Dimension | Idea 1: Floating Navigator (User) | Idea 2: Bento Cockpit | Idea 3: Flow Command Center | Idea 4: Adaptive Zen |
| :--- | :--- | :--- | :--- | :--- |
| **Primary Strength** | Maximizes screen real estate & modernizes header | Visual delight, hierarchy & instant spatial recognition | Speed, keyboard dominance & modal-free capture | Workflow flexibility (Kanban, Focus) |
| **Space Efficiency** | 🌟 Highest (100% full-bleed) | 🌟 High (fluid bento cards) | ⚡ High | 🎯 Medium |
| **Visual Freshness** | ✨ Modern Arc/Notion aesthetic | 🎨 Rich, tactile Apple/Linear look | 🖥️ Clean, terminal-adjacent | 🧘 Minimalist zen |
| **Vanilla JS/CSS Effort** | **Low–Medium** | **Low–Medium** | **Medium** | **Medium–High** |

---

## 8. The Recommended Synergy (The "Dream ExoDeck")

The most compelling outcome is that **your idea (Idea 1) is not mutually exclusive with Ideas 2 and 3—in fact, they complement each other perfectly**:

```text
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ╭───╮                                                                                                 │
│  │ ⚡│ Engineering  ▾  [···]   │   🚀 Sprint Dashboard      [ / Quick Action ] [✎ Edit]  [⚙ Settings]  │
│  ╰───╯                                                                                                 │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ [Floating Navigator on `.` / Hover]                                                                    │
│                                                                                                        │
│  ┌───────────────────────────────┐   ┌───────────────────────────────┐   ┌───────────────────────────┐ │
│  │ ⚡ DAILY LAUNCHPAD (Bento)    │   │ 🐙 GITHUB / DEV REPOS         │   │ 📝 SCRATCHPAD (Ctrl+J)    │ │
│  │ • [🐙] GitHub PRs             │   │ • [▲] Vercel Deployments      │   │ • Review chi router API   │ │
│  │ • [🌐] Google Cloud Console   │   │ • [🐳] Docker Registry        │   │ • Check memory leak       │ │
│  └───────────────────────────────┘   └───────────────────────────────┘   └───────────────────────────┘ │
│                                                                                                        │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │ 🎯 ACTIVE TASKS  (3/5 Done)  ━━━━━━━━━━━━━●━━━━━━━                         [+ Quick Task]         │ │
│  │  ☑ Fix Fernet encryption key storage                                                               │ │
│  │  ☐ Review new Floating Navigator CSS transition                                                    │ │
│  └───────────────────────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Suggested Implementation Roadmap

1. **Step 1: The Horizon Header & Floating Navigator (Idea 1)**
   * Unify header in `index.html` and `content.js`.
   * Convert sidebar into a floating popover with hover-intent and `.` keyboard shortcut.
   * Implement the `[📌]` pin toggle with `localStorage` persistence.
   * *Result: Immediate 100% viewport expansion for notes, whiteboards, and grids.*
2. **Step 2: Bento Grid & Favicons (Idea 2)**
   * Add domain favicon rendering for link items.
   * Introduce Bento card spans (`span-2`, `span-full`) and progress rings for task groups.
   * Update dark palette tokens to deep obsidian glass.
   * *Result: Instant visual polish and spatial recognition.*
3. **Step 3: Frictionless Capture & Shortcuts (Idea 3)**
   * Add quick capture commands to the `/` palette (`+t`, `+l`).
   * Add global scratchpad drawer (`Ctrl + J`).
   * *Result: Lightning-fast everyday productivity.*
