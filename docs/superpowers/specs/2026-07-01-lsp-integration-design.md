# LSP Integration Design

**Date**: 2026-07-01
**Status**: Draft
**Scope**: Embed tinymist LSP server into Typst Studio for completion, goto-definition, hover, and diagnostics.

## 1. Architecture

```
┌─ Frontend (Webview) ─────────────────────────────────────────────┐
│  monaco-languageclient (replaces @monaco-editor/react)           │
│  → WebSocket connection to Rust backend                          │
│  → Handles LSP document sync (didOpen/didChange/didSave)        │
│  → Receives diagnostics via publishDiagnostics                   │
│  → CompletionItemProvider / DefinitionProvider / HoverProvider   │
│                                                                  │
│  Existing compile pipeline PRESERVED:                            │
│  → updateText IPC still triggers compile → SVG preview           │
│  → Export (PDF/PNG) unchanged                                    │
└──────────────────────────────────────────────────────────────────┘
         │ WebSocket (ws://127.0.0.1:<port>)
         │ Tauri IPC (compile / file ops / export)
┌────────┴─────────────────────────────────────────────────────────┐
│  Rust Backend                                                     │
│                                                                   │
│  LspManager (new)                                                 │
│   ├─ Starts WebSocket server (tokio-tungstenite, random high port)│
│   ├─ Spawns tinymist --stdio child process                        │
│   ├─ Bidirectional relay: WebSocket ↔ stdio (Content-Length frame)│
│   └─ Child process lifecycle (start / restart on crash / shutdown)│
│                                                                   │
│  Existing EditorService + ExportService unchanged                 │
│  Existing LanguageService trait → deprecated                      │
│  Existing compile diagnostics → replaced by LSP publishDiagnostics│
└──────────────────────────────────────────────────────────────────┘
```

### Key Decisions

1. **tinymist as subprocess** (not Rust library) — avoids patched-typst version conflicts with existing `typst = "0.15"` dependency. tinymist ships its own typst internally.

2. **Rust backend is a pure relay** — does not parse LSP message content. All protocol logic lives in `monaco-languageclient` on the frontend.

3. **Existing compile pipeline preserved** — the `EditorService` continues to compile and render SVG previews. Only diagnostics source changes (from compile output → LSP `publishDiagnostics`).

4. **User-installed tinymist** — the app searches PATH for `tinymist` binary, with a settings override for custom path. No binary bundled with the app.

## 2. Rust Backend Changes

### 2.1 New Dependencies (`Cargo.toml`)

```toml
tokio-tungstenite = "0.26"
futures-util = "0.3"
```

### 2.2 New Module: `src-tauri/src/lsp/`

```
src-tauri/src/lsp/
├── mod.rs              # Module declaration
├── manager.rs          # LspManager: spawn tinymist, lifecycle
├── relay.rs            # WebSocket ↔ stdio message relay
└── framing.rs          # Content-Length header parsing/generation
```

#### `framing.rs` — LSP Message Framing

Implements `Content-Length: N\r\n\r\n<json>` parsing and generation for stdio transport.

```rust
/// Read one LSP message from a BufRead stream.
/// Returns the parsed JSON-RPC message body.
pub async fn read_message(reader: &mut impl AsyncBufRead) -> io::Result<String>;

/// Write one LSP message to a Write stream with Content-Length framing.
pub async fn write_message(writer: &mut (impl AsyncWrite + Unpin), body: &str) -> io::Result<()>;
```

#### `manager.rs` — LspManager

```rust
pub struct LspManager {
    child: Option<Child>,
    ws_port: u16,
    config: LspConfig,
}

pub struct LspConfig {
    pub tinymist_path: String,  // default: "tinymist"
    pub enabled: bool,          // default: true
}

impl LspManager {
    /// Find tinymist binary (PATH or config override), spawn it, start WS server.
    pub async fn start(config: LspConfig) -> Result<Self>;

    /// Gracefully shut down tinymist and the WS server.
    pub async fn shutdown(&mut self);

    /// The WebSocket URL the frontend should connect to.
    pub fn ws_url(&self) -> String;  // "ws://127.0.0.1:{port}"

    /// Check if tinymist is available (binary found in PATH or config).
    pub fn is_available(config: &LspConfig) -> bool;
}
```

#### `relay.rs` — Message Relay

```rust
/// Run the bidirectional relay between one WebSocket connection and tinymist's stdio.
/// Returns when either side closes.
pub async fn relay(
    ws_stream: WebSocketStream<TcpStream>,
    stdin: ChildStdin,
    stdout: ChildStdout,
) -> Result<()>;
```

### 2.3 Changes to `lib.rs`

- Add `pub mod lsp;`
- In `setup()`: start `LspManager`, store in `AppState`
- Add new Tauri commands for LSP status

### 2.4 Changes to `AppState`

```rust
pub struct AppState {
    pub editor: Arc<EditorService>,
    pub export: Arc<ExportService>,
    pub lsp: Arc<Mutex<LspManager>>,  // new
}
```

### 2.5 New Tauri Commands

```rust
/// Get the LSP WebSocket URL for the frontend to connect to.
#[tauri::command]
async fn get_lsp_status(state: State<'_, AppState>) -> Result<LspStatus>;

/// Restart the tinymist process (e.g., after settings change).
#[tauri::command]
async fn restart_lsp(state: State<'_, AppState>) -> Result<()>;
```

### 2.6 Changes to Compile Diagnostics

The existing `EditorService` emits diagnostics via `Emitter::emit_diagnostics()`. After LSP integration:
- **LSP diagnostics** (from `publishDiagnostics`) replace compile diagnostics in the editor
- **Compile diagnostics** still exist internally for status display (error count in status bar)
- The `diagnostics` Tauri event is no longer emitted by the compile pipeline (LSP handles it)

## 3. Frontend Changes

### 3.1 Package Changes

**Remove**:
```json
"@monaco-editor/react": "^4.6.0",
"monaco-editor": "^0.52.0"
```

**Add**:
```json
"monaco-languageclient": "~9.11.0",
"@codingame/monaco-vscode-api": "~20.2.1",
"@codingame/monaco-vscode-editor-api": "~20.2.1",
"@codingame/monaco-vscode-configuration-service-override": "~20.2.1",
"@codingame/monaco-vscode-model-service-override": "~20.2.1",
"@codingame/monaco-vscode-languages-service-override": "~20.2.1",
"@codingame/monaco-vscode-theme-service-override": "~20.2.1",
"@codingame/monaco-vscode-textmate-service-override": "~20.2.1",
"vscode-ws-jsonrpc": "~3.5.0"
```

Note: `monaco-editor` is replaced via `package.json` overrides:
```json
{
  "overrides": {
    "monaco-editor": "npm:@codingame/monaco-vscode-editor-api@~20.2.1"
  }
}
```

### 3.2 Editor Component Rewrite

Replace `src/components/Editor/MonacoEditor.tsx` with a new implementation using `monaco-languageclient`.

**Key changes**:
- Use `MonacoLanguageClient` with `WebSocketMessageTransports`
- Connect to `ws://127.0.0.1:{port}` (port from `get_lsp_status` command)
- Register Typst language with Monarch tokenizer (preserve existing rules)
- Preserve existing theme (`typst-light`)
- LSP client handles: document sync, diagnostics, completion, goto-def, hover

**Document URI strategy**:
- Files with disk path: `file:///path/to/file.typ` (tinymist can access directly)
- Untitled tabs: `inmemory://typst-studio/{tabId}` (tinymist uses VFS)

### 3.3 Files to Modify

| File | Change |
|------|--------|
| `src/components/Editor/MonacoEditor.tsx` | Rewrite to use monaco-languageclient |
| `src/components/Editor/typstLanguage.ts` | Adapt for @codingame/monaco-vscode-api |
| `src/components/Editor/diagnostics.ts` | Remove (LSP handles diagnostics) |
| `src/hooks/useTypstCompile.ts` | Remove diagnostics listener (LSP handles it) |
| `src/store/diagnosticsStore.ts` | Keep, but populated by LSP instead of compile events |
| `src/lib/tauri.ts` | Add `getLspStatus()`, `restartLsp()` |
| `src/lib/types.ts` | Add `LspStatus` type |
| `src/App.tsx` | No major changes (diagnostics flow stays the same) |
| `package.json` | Update dependencies |
| `vite.config.ts` | May need adjustments for @codingame packages |

### 3.4 Files to Add

| File | Purpose |
|------|---------|
| `src/components/Editor/lspClient.ts` | LSP client setup, WebSocket connection management |

### 3.5 Files to Deprecate/Remove

| File | Reason |
|------|--------|
| `src/components/Editor/diagnostics.ts` | LSP handles diagnostic mapping |

## 4. tinymist Discovery & Configuration

### 4.1 Binary Discovery

1. Check `settings.json` for custom `tinymist.path`
2. Search PATH for `tinymist` executable
3. If not found: LSP features disabled, show warning in status bar

### 4.2 Settings Schema

```json
{
  "lsp": {
    "enabled": true,
    "tinymistPath": "tinymist"
  }
}
```

### 4.3 tinymist Launch Arguments

```
tinymist --stdio
```

tinymist auto-discovers workspace root from the first `textDocument/didOpen` URI. For untitled documents, it uses an in-memory VFS.

## 5. Message Flow

### 5.1 App Startup

```
1. Tauri setup() → LspManager::start()
2. LspManager checks PATH for tinymist
3. If found: spawn "tinymist --stdio", start WS server
4. Store LspManager in AppState
5. Frontend calls get_lsp_status() → receives ws_url
6. Frontend creates MonacoLanguageClient with WebSocket transport
7. Client sends initialize request → tinymist responds
8. Client sends initialized notification → ready
```

### 5.2 Document Open

```
1. User opens file or creates new tab
2. Frontend creates Monaco model with file:// or inmemory:// URI
3. monaco-languageclient sends textDocument/didOpen to tinymist
4. tinymist begins analyzing the document
```

### 5.3 Typing

```
1. User types in Monaco
2. Monaco onChange → monaco-languageclient sends textDocument/didChange (debounced)
3. Existing: updateText IPC → EditorService → compile → SVG preview (unchanged)
4. tinymist analyzes → publishDiagnostics → Monaco markers updated
5. tinymist ready for completion/hover/goto requests
```

### 5.4 Completion Request

```
1. User types trigger character (e.g., "#")
2. Monaco CompletionItemProvider fires
3. monaco-languageclient sends textDocument/completion to tinymist
4. tinymist returns CompletionList
5. Monaco displays completion popup
```

### 5.5 Hover

```
1. User hovers over identifier
2. Monaco HoverProvider fires
3. monaco-languageclient sends textDocument/hover to tinymist
4. tinymist returns Hover content (markdown)
5. Monaco displays hover tooltip
```

### 5.6 Go-to-Definition

```
1. User Ctrl+Click on identifier
2. Monaco DefinitionProvider fires
3. monaco-languageclient sends textDocument/definition to tinymist
4. tinymist returns Location(s)
5. Monaco navigates to target
```

## 6. Error Handling

### 6.1 tinymist Not Found

- LSP features disabled gracefully
- Status bar shows "LSP: not available"
- Completion/hover/goto return empty results
- Compile pipeline + SVG preview still work

### 6.2 tinymist Crash

- `LspManager` detects child process exit
- Auto-restart (up to 3 attempts)
- Frontend reconnects WebSocket
- Status bar shows "LSP: reconnecting..."

### 6.3 WebSocket Connection Lost

- Frontend `MonacoLanguageClient` enters reconnect loop
- Exponential backoff (1s, 2s, 4s, max 10s)
- Status bar shows "LSP: disconnected"

## 7. Coexistence with Compile Pipeline

| Feature | Source |
|---------|--------|
| SVG preview | Compile pipeline (EditorService) → unchanged |
| PDF/PNG export | Compile pipeline (EditorService) → unchanged |
| Diagnostics (errors/warnings) | LSP (publishDiagnostics) → replaces compile diagnostics |
| Status bar (idle/compiling/error) | Compile pipeline → unchanged |
| Completion | LSP (textDocument/completion) → new |
| Hover | LSP (textDocument/hover) → new |
| Go-to-definition | LSP (textDocument/definition) → new |

The compile pipeline continues to emit `status` and `compiled` events. The `diagnostics` event is replaced by LSP's `publishDiagnostics`.

## 8. Migration Path

### Phase 1: Backend — LspManager + WebSocket relay
- Add `tokio-tungstenite` dependency
- Create `src-tauri/src/lsp/` module
- Implement framing, relay, manager
- Wire into `AppState` and `setup()`
- Add `get_lsp_status` and `restart_lsp` commands

### Phase 2: Frontend — monaco-languageclient migration
- Update `package.json` dependencies
- Rewrite `MonacoEditor.tsx` to use `monaco-languageclient`
- Adapt `typstLanguage.ts` for new Monaco API
- Add `lspClient.ts` for connection management
- Remove `diagnostics.ts` (LSP handles it)

### Phase 3: Integration — Wire diagnostics + settings
- LSP diagnostics populate `diagnosticsStore`
- Remove compile-based diagnostics emission
- Add LSP settings to config
- Status bar shows LSP status

## 9. Open Questions

1. **URI mapping for untitled tabs**: tinymist may not handle `inmemory://` URIs well. May need to use a fake `file:///untitled-{id}.typ` URI and manage VFS manually.

2. **Multiple tabs / multiple tinymist instances**: One tinymist instance can handle multiple documents. Use one instance for all tabs.

3. **tinymist workspace root**: For file-backed documents, use the file's parent directory. For untitled tabs, use a temp directory or the last-opened file's directory.

4. **Version pinning**: tinymist 0.15.x matches Typst 0.15. Need to document this requirement.
