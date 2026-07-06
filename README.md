# Typst Studio

> A native desktop editor for Typst, focused on local-first workflows, live preview, and smooth writing.

[简体中文](README_zh.md)

![status](https://img.shields.io/badge/status-WIP-yellow)
![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

![Typst Studio icon](app-icon.png)

## Overview

**Typst Studio** is a cross-platform desktop editor built specifically for [Typst](https://typst.app). It uses `Tauri 2 + React + Rust` and embeds the official Typst compiler directly, so you can edit, preview, and export documents without relying on a separate Typst CLI install.

Its goal is not just to put Typst into a generic code editor, but to offer a desktop experience that feels better for writing, typesetting, and document organization: code on the left, real-time multi-page preview on the right, plus workspace, search, outline, export, recovery, and theming support.

## Who It Is For

- People who want a desktop Typst app instead of a browser-only or CLI-only workflow
- People who want to write source and watch the rendered result side by side
- People who need local folders, document search, outline navigation, and export tools
- People who prefer a local-first workflow and do not want to depend on cloud sync

## Highlights

- **Embedded official Typst compiler**  
  You can compile, preview, and export Typst documents out of the box, without first installing the Typst CLI.

- **Live multi-page preview**  
  The preview refreshes automatically as you edit and supports multi-page SVG rendering.

- **Preview-to-source mapping**  
  Editor and preview can scroll together, and double-clicking the preview jumps back to the corresponding source line.

- **Workspace workflow**  
  You can open a full folder workspace, browse files in the explorer, create, rename, or delete entries, and reopen recent workspaces.

- **Writing navigation**  
  Built-in outline view lets you navigate by headings, and workspace-wide search helps you find content across files.

- **Export options**  
  Supports export to `PDF`, `PNG`, and `SVG`.

- **Safer saving and recovery**  
  Includes autosave modes, session restore, crash recovery, and conflict handling when files change outside the app.

- **Themes and language**  
  Offers built-in themes, hot-reloadable custom CSS themes, and English/Simplified Chinese UI.

## What You Can Do Today

- Open a single `.typ` file or an entire Typst project folder
- Edit multiple documents in tabs
- Use the format toolbar to quickly insert headings, lists, tables, links, and images
- Convert pasted rich text into Typst markup
- Inspect diagnostics and jump to problem locations
- Reuse the running app instance when opening `.typ` files, instead of spawning duplicate windows

## Quick Start

### 1. Open a file or folder

- If you only want to edit one document, just open a `.typ` file
- If you are working on a full project, opening the whole folder is recommended

### 2. Edit on the left, preview on the right

- The left side is a Monaco editor
- The right side is a multi-page preview pane
- You can hide or show the sidebar and preview pane as needed

### 3. Use the sidebar for navigation

- `Explorer`: browse workspace files
- `Search`: search across the workspace
- `Outline`: jump by document heading structure

### 4. Export your final document

You can export from the native app menu as:

- `PDF`
- `PNG`
- `SVG`

## Useful Shortcuts

> Shortcuts use `Cmd` on macOS and `Ctrl` on Windows/Linux.

- `Cmd/Ctrl + S`: save the current document
- `Cmd/Ctrl + Shift + S`: save as
- `Cmd/Ctrl + B`: toggle sidebar
- `Cmd/Ctrl + Shift + F`: find in files
- `Cmd/Ctrl + Shift + O`: open Outline

## Installation

### Option 1: Use a packaged release

When packaged builds are available on the [Releases](../../releases) page, download the one for your platform.

Supported target platforms:

- macOS
- Windows
- Linux

> The repository already includes a cross-platform release workflow. If no downloadable build is currently published, use the source-based setup below.

### Option 2: Run from source

#### Requirements

- `Node.js 20+`
- `Rust 1.92+`
- Platform-specific Tauri prerequisites

Please check the official Tauri prerequisites first:

- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

#### Development run

```bash
npm install
npm run tauri dev
```

#### Production build

```bash
npm run tauri build
```

Build artifacts are written to `src-tauri/target/release/bundle/`.

## Optional Components

### Tinymist language service

Typst Studio includes integration for the Tinymist language server, but Tinymist itself is not bundled with the app.

If you want richer language-service behavior, install `tinymist` separately and make sure it is available on your system `PATH`.

## Personalization

### Themes

The app ships with multiple built-in themes and also supports user-authored themes. Custom themes hot-reload after saving, with no app restart required.

Theme documentation:

- [docs/themes.md](docs/themes.md)

### Language

Currently supported UI languages:

- English
- Simplified Chinese

### Configurable settings

Things you can configure in the Settings window include:

- Editor font, font size, line height, wrapping, minimap, and whitespace rendering
- Compile and editor debounce
- Autosave behavior
- Preview zoom, background, and padding
- Search result limits
- PNG export resolution
- Extra font directories

## Data and Privacy

Typst Studio is local-first. Your documents remain on your local file system.

The app also stores a small amount of local support data to improve resilience and usability, such as:

- Settings
- Recent workspaces
- Last session state
- Crash-recovery snapshots
- User themes

### Crash-recovery locations

Recovery snapshots are stored under the app's private data directory in a `recovery/` subfolder:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/com.typststudio.app/recovery/` |
| Windows | `%APPDATA%\com.typststudio.app\recovery\` |
| Linux | `~/.local/share/com.typststudio.app/recovery/` |

These recovery files are not automatically deleted on uninstall. You can clear them manually from Settings.

## Current Status

Typst Studio is still an actively evolving project and is best suited for users who are comfortable trying an early-stage app.

The local editing experience is already substantial, but this is not yet a fully polished, everything-included Typst IDE.

## Known Limitations

- Language-service behavior depends on whether external `tinymist` is available
- Custom themes currently focus on the app chrome; Monaco and preview theme linkage is not yet fully unified
- Project-level workflows are already present, but the overall experience is still being refined
- This is not a cloud collaboration tool; it is currently positioned as a local desktop editor

## Direction

The project is moving toward feeling more like a dedicated Typst workstation than a generic code editor.

Key directions include stronger project workflows, richer language-service support, a better theming system, and continued refinement of the desktop writing experience.

## License

This project is dual-licensed under **MIT OR Apache-2.0**, matching the Typst project itself.

## Acknowledgments

- [Typst](https://github.com/typst/typst)
- [Tauri](https://tauri.app)
- [Monaco Editor](https://microsoft.github.io/monaco-editor/)
