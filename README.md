# Typst Studio

> A native desktop IDE for [Typst](https://typst.app) — edit, watch it compile, and ship your document. Local-first, no CLI install, no cloud.

[简体中文](README_zh.md)

![status](https://img.shields.io/badge/status-WIP-yellow)
![license](https://img.shields.io/badge/license-MIT-blue)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

## Why Typst Studio

Typst Studio embeds the **official Typst compiler** in a Rust backend and pairs it with a Monaco-based editor and a live multi-page preview — the writing loop stays entirely on your machine, and everything compiles and refreshes as you type.

It is built as a real workbench rather than a generic code editor that happens to open `.typ` files: project-level configuration, bibliography and package management, workspace-wide search, export pipelines, session recovery, and theming are all first-class.

## Features

### Writing & editing

- **Monaco editor with Typst syntax highlighting** — full keyboard editing, word-wrap toggle, configurable font/size/line-height/minimap.
- **Format toolbar** — one click to insert headings, bold/italic/code, lists, tables, links, and images; a visual grid picker for tables.
- **Formula assist** — guided insertion of math formulas.
- **Rich-text paste** — content pasted from browsers or Word is converted into Typst markup.
- **Paste images** — screenshots dropped into the editor are saved into a configurable assets folder and referenced automatically.
- **Multi-tab editing** with per-tab dirty state, soft-close, and session restore.

### Live preview

- **Embedded compiler** — no Typst CLI needed; preview starts instantly.
- **Debounced incremental recompiles** — multi-page SVG preview refreshes as you type; stale responses are dropped by a revision guard.
- **Preview ↔ source sync** — double-click the preview to jump to the source line.
- **Project preview mode** — preview the project's main file while editing any of its includes.
- **Ctrl + wheel zoom** in the preview pane.

### Project & workspace

- **Folder workspaces** — lazy-loading file explorer with create / rename / copy / delete (trash-first, with confirmation for destructive actions).
- **`.typstpro` project config** — a small TOML file at the workspace root declares the main file, title, bibliographies, compile root, extra font dirs, exclude globs, new-file template, and export defaults (format + output path with `${title}` macros). Hand-editable, watched, live-reloaded. See the [field reference](docs/typstpro.md).
- **Workspace search & replace** — full-text search across the project with jump-to-line, plus multi-file replace.
- **Outline view** — jump by heading structure.
- **Source control** — a Git panel for status and commits.
- **Recent workspaces** — reopen where you left off.

### Bibliography & packages

- **Bibliography panel** — parses `.bib` and Hayagriva `.yml`; click a reference to insert `#cite(<key>)` at the caret.
- **Packages panel** — browse the Typst Universe catalog, manage installed packages, and insert `#import` statements.

### Diagnostics & language features

- **Diagnostics panel** — compile errors and warnings with severity, position, and jump-to-line.
- **Tinymist integration** — richer language features via [`tinymist`](https://github.com/Myriad-Dreamin/tinymist). Found on your `PATH` or in the managed install (`~/.typststudio/`); when neither exists, the app downloads it automatically (disable or re-trigger from Settings → Language Server).

### Export

- **PDF / PNG / SVG export**, pinned to the revision you are looking at — never silently exporting an older compile.
- **Per-project export defaults** — declare `format` and `outputPath` in `.typstpro` to skip the save dialog entirely.

### AI assistant

- Built-in writing assistant — bring your own provider and key (Anthropic-compatible / OpenAI-compatible endpoints), configurable model and token limits.

### Safety & recovery

- **Autosave** (interval / on-change / manual modes) and crash-recovery snapshots.
- **External-change awareness** — files modified outside the app surface a conflict dialog instead of being overwritten; deletes are blocked while affected documents have unsaved edits.
- **Session restore** — tabs, layout, and window geometry come back on launch.

### Personalization

- **Themes** — built-in light/dark/sepia/accent themes, plus hot-reloadable custom CSS themes ([authoring guide](docs/themes.md)).
- **English / 简体中文 UI**, switchable at runtime.
- **Command palette** (`Ctrl+Shift+P`) for every action, with a settings window covering editor, compile, export, search, and appearance.

## Keyboard shortcuts

> `Cmd` on macOS, `Ctrl` on Windows/Linux.

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+T` / `Ctrl+W` | New tab / close tab |
| `Ctrl+O` | Open file |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / save as |
| `Ctrl+Shift+B` | Toggle sidebar |
| `Ctrl+\` | Toggle preview |
| `Ctrl+Shift+F` | Find in files |
| `Ctrl+Shift+G` | Source control |
| `Ctrl+Shift+O` | Outline |
| `Ctrl+wheel` | Zoom preview |
| `Shift+Alt+F` | Format document |

## Installation

### Download a build

Grab the latest installer from the [Releases](../../releases) page:

- **Windows** — `.msi` or NSIS `.exe` (x64)
- **macOS** — `.dmg` (Apple Silicon & Intel)
- **Linux** — `.deb` / `.AppImage`

### Build from source

Requirements: Node.js 20+, Rust 1.92+, and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev     # development
npm run tauri build   # installers land in src-tauri/target/release/bundle/
```

## Documentation

- [`.typstpro` project config reference](docs/typstpro.md)
- [Custom theme authoring](docs/themes.md)

## Data & privacy

Typst Studio is local-first — documents never leave your file system. The app keeps a small amount of support data (settings, recent workspaces, session state, recovery snapshots, user themes) under its private data directory (`%APPDATA%\com.typststudio.app\` on Windows, `~/Library/Application Support/com.typststudio.app/` on macOS, `~/.local/share/com.typststudio.app/` on Linux). The optional AI assistant sends only the prompts you explicitly send it, to the endpoint you configure.

## Status

Actively developed (`v0.1.x`). The local editing workflow is solid; language-service depth and theme/editor linkage are still being refined. Feedback and issues are welcome.

## License

[MIT](LICENSE). Built on [Typst](https://github.com/typst/typst), [Tauri](https://tauri.app), and [Monaco Editor](https://microsoft.github.io/monaco-editor/).
