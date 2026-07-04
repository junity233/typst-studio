# Typst Studio

> A native desktop Typst editor with live SVG preview — Tauri 2 + React + Rust, embedding the official typst compiler.

![status](https://img.shields.io/badge/status-WIP-yellow)
![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

<!-- ![screenshot](docs/screenshot.png) -->

## What it is

Typst Studio is a visual editor for [Typst](https://typst.app), the modern, markup-based typesetting
system. The window is split in two: a [Monaco](https://microsoft.github.io/monaco-editor/) code editor on
the left and a real-time SVG preview on the right. The Typst compiler is embedded directly in the Rust
backend via the official crates (`typst`, `typst-svg`, `typst-pdf`, `typst-render`, `typst-kit`), so the
`EditorWorld` instance stays alive across keystrokes and incremental compilation (via `comemo`) yields
millisecond-level responses — 100% consistent with the official Typst toolchain.

## Features

- **Real-time preview** — ~150 ms edit-to-preview latency. A per-tab compile worker (single-threaded, 128 MB stack) compiles on every edit via typst's incremental evaluator; SVG pages render as blob-URL images for off-main-thread decoding.
- **Multi-tab editing** — each tab owns an independent `EditorWorld` + `CompileWorker`.
- **PDF export** — one-shot export via `typst-pdf`.
- **PNG export** — per-page raster export via `typst-render`.
- **Monaco editor** — Typst syntax highlighting via Monarch tokenizer + light theme.
- **Diagnostics** — Typst errors surface as Monaco squiggles plus a clickable problems panel.
- **System fonts** — automatic loading via `typst-kit` (embedded + scanned fonts).
- **Resizable split** — drag the divider (Allotment).

## Architecture

```
┌─ Webview (React) ─────────────────────────────────────────┐
│  Monaco onChange → debounce 100ms → invoke(update_text)    │
│       ▲                                                    │
│       │ listen("compiled", pages[]) → blob-URL <img>       │
│       │ listen("diagnostics", errs[])  → Monaco markers    │
│       │ listen("status", state)        → status bar        │
│       │ (preview updates wrapped in startTransition)        │
└───────┼────────────────────────────────────────────────────┘
        │  Tauri IPC (all async; spawn_blocking for IO/dialogs)
┌───────┴────────────────────────────────────────────────────┐
│  Rust backend                                               │
│  EditorService                                              │
│   ├─ tabs: HashMap<Id, Arc<TabState>>                       │
│   │    TabState { world: EditorWorld (no Mutex!)            │
│   │               state: Mutex<TabRuntime> }                │
│   ├─ workers: HashMap<Id, CompileWorker>                    │
│   │    CompileWorker: 1 thread/tab, 128MB stack, channel    │
│   │    ├─ coalesces N keystrokes → 1 compile                │
│   │    └─ skips SVG render if text changed mid-compile      │
│   └─ ExportService → render_pdf/png (IO in command layer)   │
└─────────────────────────────────────────────────────────────┘
```

The backend is layered `domain → typst_engine → service → ipc`, with each extension point
(`SourceProvider`, `RenderPipeline`, `LanguageService`, `Project`, `ConfigStore`) behind a trait.
See the full design doc: [`docs/superpowers/specs/2026-06-30-typst-studio-design.md`](docs/superpowers/specs/2026-06-30-typst-studio-design.md).

## Prerequisites

- **Node.js** 20+
- **Rust** 1.92+ (Typst 0.15 raises the MSRV to 1.92)
- **Platform-specific Tauri dependencies** — see the
  [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/).

<details>
<summary>macOS</summary>

```bash
# Xcode command-line tools provide everything Tauri needs.
xcode-select --install
brew install rustup-init
```
</details>

<details>
<summary>Linux (Debian/Ubuntu)</summary>

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```
</details>

<details>
<summary>Windows</summary>

Install the [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
(needed for the Rust `msvc` toolchain) and [Rust](https://www.rust-lang.org/tools/install).
WebView2 is preinstalled on Windows 10/11.
</details>

## Development

```bash
npm install
npm run tauri dev
```

The first build downloads and compiles the Typst crates (`typst`, `typst-svg`, `typst-pdf`,
`typst-render`, `typst-kit`) — expect roughly 2–3 minutes for the initial compile. Subsequent
dev builds are fast thanks to incremental compilation.

## Production build

```bash
npm run tauri build
```

Artifacts are written to `src-tauri/target/release/bundle/`:

| Platform | Output |
|---|---|
| macOS | `Typst Studio.app` + `Typst Studio_0.1.0_aarch64.dmg` / `_x64.dmg` |
| Windows | `Typst Studio_0.1.0_x64-setup.exe` (NSIS, user-scope) + `.msi` |
| Linux | `typst-studio_0.1.0_amd64.deb` + `typst-studio_0.1.0_amd64.AppImage` |

The macOS DMG targets `minimumSystemVersion` 10.15. The Windows installer uses NSIS in
`currentUser` mode (no administrator elevation required). The Linux AppImage does not bundle
the media framework by default.

## Type generation (for developers)

The Rust ↔ TypeScript IPC types are generated with [`ts-rs`](https://crates.io/crates/ts-rs) behind
the `export-types` feature and are checked into [`src/lib/types.ts`](src/lib/types.ts). Regenerate
after changing command signatures or domain models:

```bash
cd src-tauri && cargo test --features export-types
```

## Project layout

```
typst-studio/
├── src/                          # React + TypeScript frontend
│   ├── App.tsx                   # root layout: SplitPane + title bar + status bar
│   ├── main.tsx
│   ├── components/
│   │   ├── SplitPane/            # draggable left/right divider (allotment)
│   │   ├── Editor/               # Monaco + Typst grammar + diagnostics markers
│   │   ├── Preview/              # blob-URL <img> preview (per-page SvgPage, memoized)
│   │   ├── Diagnostics/          # collapsible problems panel (click to jump)
│   │   ├── StatusBar/            # compile status: idle / Xms / N errors
│   │   └── TitleBar/             # top bar + menu actions
│   ├── store/                    # zustand stores (tabs, diagnostics)
│   ├── hooks/                    # useTypstCompile, useDebounce, ...
│   ├── lib/                      # tauri.ts (invoke/listen), types.ts (ts-rs), ui-types.ts
│   └── styles/
├── src-tauri/                    # Rust backend
│   ├── tauri.conf.json           # Tauri 2 bundle config (3 platforms)
│   ├── capabilities/default.json # window permissions + fs/dialog scopes
│   └── src/
│       ├── main.rs               # bootstrap: build app, register commands, mount State
│       ├── lib.rs                # library entry (integration tests)
│       ├── domain/               # domain models (Document, Diagnostics, CompileResult) — no IO
│       ├── typst_engine/         # EditorWorld (impl typst::World), compiler, source/font loading
│       ├── render/               # RenderPipeline trait: Svg / Pdf / Png renderers
│       ├── service/              # EditorService + ExportService + CompileWorker (per-tab thread)
│       ├── ipc/                  # #[tauri::command] wrappers, events, AppState
│       ├── project/              # Project + VirtualFs traits (MVP: single file)
│       ├── languageserver/       # LanguageService trait (MVP: NoopLs)
│       └── settings/             # AppConfig + ConfigStore
├── docs/superpowers/specs/       # design spec + IPC contract
└── .github/workflows/release.yml # 3-platform CI release pipeline
```

## Security

`src-tauri/capabilities/default.json` scopes the filesystem plugin commands
(`fs:allow-read-text-file`, `fs:allow-write-text-file`, `fs:allow-write-file`,
`fs:allow-mkdir`, `fs:allow-exists`) to `$HOME/**`, so the frontend-exposed fs
plugin can read/write within the user's home directory (Tauri's `deny-default`
protections, e.g. the webview data folder on Windows/Linux, still take
precedence). Note: the app's core file I/O (open/save/save-as) goes through
**Rust IPC commands using `std::fs` directly**, which bypass the plugin's
permission scope — so the capability glob is cosmetic for those paths but still
correct practice for any frontend-exposed fs API. Tightening to user-chosen
paths only requires deeper integration (a per-action grant model) and is tracked
as a future production gate. `app.security.csp` is set to a production policy
(see `tauri.conf.json`): `default-src 'self'`, with `img-src` allowing the
`blob:`/`data:` preview SVGs and `worker-src 'self'` for Monaco's workers.

### Recovery data & uninstall

Crash-recovery snapshots of unsaved edits are written to the app's private data
directory under `<app-data>/recovery/`:

- **macOS**: `~/Library/Application Support/com.typststudio.app/recovery/`
- **Linux**: `~/.local/share/com.typststudio.app/recovery/`
- **Windows**: `%APPDATA%\com.typststudio.app\recovery\`

These are NOT deleted on uninstall — uninstalling the app leaves recovery data
in place so a reinstall can still offer to restore unsaved work. To remove them,
use **Settings → Data & Privacy → Clear recovery data**, or delete the
`recovery/` folder above manually.

## Roadmap

See the [design spec](docs/superpowers/specs/2026-06-30-typst-studio-design.md) for the full plan.
Deliberately **out of scope for the MVP**:

- Multi-file project management UI (the `World` already handles `#include`; only the UI is missing)
- Language-server features — completion / go-to-definition (LSP; `typst-ide` / tinymist)
- Custom package / font management UI
- Incremental SVG diff for very large documents (would require `typst-ts` / reflexo)

## License

Dual-licensed under **MIT OR Apache-2.0**, matching the Typst project itself.

## Acknowledgments

- [Typst](https://github.com/typst/typst) — the typesetting system this editor is built around.
- [Tauri](https://tauri.app) — the cross-platform application framework.
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — the editor component.
