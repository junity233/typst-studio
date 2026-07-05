# Format Toolbar — Design Spec

> **Topic:** editor-above formatting toolbar (Typst)
> **Date:** 2026-07-05 · **Status:** Approved
> **Branch:** `feat/format-toolbar` (worktree under `.worktrees/`)

---

## 1. Goal & Non-Goals

**Goal.** A formatting toolbar sits directly above the editor pane, exposing the common Typst markup actions (headings, inline emphasis, lists, code, links, image, table) as one-click buttons. Active when a tab is open; greyed when none. Visual language follows `DESIGN.md` (flat chrome, single Action Blue, transparent icon buttons, `scale(0.95)` press, hairline dividers).

**Non-goals (v1).**
- No toggle/setting to hide the toolbar (always visible).
- No dark mode (project has none; follows light palette).
- No keyboard shortcuts for formatting actions (only button clicks).
- No `Math`/`Underline`/`Highlight`/`Sub`/`Super` buttons (Standard set only; can be added later by appending to the actions list).
- No WYSIWYG. The toolbar inserts raw Typst markup into the Monaco buffer; it does not transform the editing surface.

---

## 2. Architecture — Approach A (Extend `MonacoEditorApi`)

The live `Monaco.editor.IStandaloneCodeEditor` lives only inside `MonacoEditor.tsx`'s `editorAppRef`. It is surfaced to the parent (`EditorArea`) via an imperative `MonacoEditorApi` interface built in `handleLanguageClientsStartDone`. Today that interface exposes navigation/scroll only — no text edits.

**Change:** add three edit methods to `MonacoEditorApi`. The toolbar calls these; it never touches the raw Monaco editor.

### `MonacoEditorApi` additions (`src/components/Editor/MonacoEditor.tsx`)

```ts
export interface MonacoEditorApi {
  // ...existing navigation/scroll methods...

  /** Wrap the current selection (or insert placeholder if empty) with
   *  prefix/suffix. Used for `*…*`, `_…_`, `` `…` ``, etc. Selects the
   *  placeholder range when there was no selection so the user can type. */
  wrapSelection: (prefix: string, suffix: string, placeholder?: string) => void;

  /** Replace the current selection with `text`, then select the inserted
   *  range. Used for snippets where we don't wrap (code block, HR, image,
   *  table produce a block to drop in). */
  replaceSelection: (text: string) => void;

  /** Toggle a line-prefix marker (e.g. `= ` for H1, `- ` for bullet, `+ ` for
   *  numbered, `> ` for quote). Operates on every line touched by the
   *  selection (or the caret's line if no selection). If the prefix already
   *  exists it is removed; otherwise it is added. Collapses multi-prefix
   *  conflicts by always taking the new prefix. */
  toggleLinePrefix: (prefix: string) => void;
}
```

All three are implemented in `handleLanguageClientsStartDone` (the same closure that builds the existing API, `MonacoEditor.tsx:382-443`) using `getEditor()` (`MonacoEditor.tsx:240-242`). They follow the `executeEdits` precedent at `usePasteConvert.ts:83`.

**Why this shape:**
- `wrapSelection` — bold/italic/strike/inline-code/link share identical "surround selection" mechanics.
- `replaceSelection` — code block, HR, image, table produce a block to drop in.
- `toggleLinePrefix` — headings/lists/quote toggle rather than blindly prepend (so clicking H1 twice doesn't produce `= = text`).

The toolbar's `formatActions.ts` then becomes a pure data table:

```ts
// formatActions.ts — no React, no Monaco imports
export type FormatAction =
  | { kind: "wrap"; prefix: string; suffix: string; placeholder?: string }
  | { kind: "replace"; text: string }
  | { kind: "linePrefix"; prefix: string }
  | { kind: "custom"; run: (api: FormatApi, ctx: ActionContext) => void | Promise<void> };

export interface FormatApi {
  wrapSelection: MonacoEditorApi["wrapSelection"];
  replaceSelection: MonacoEditorApi["replaceSelection"];
  toggleLinePrefix: MonacoEditorApi["toggleLinePrefix"];
}

export interface ActionContext {
  tab: Tab;
  workspace: string | null;
  insertImagePathTemplate: string | undefined;
}
```

Image and Table are `kind: "custom"` (they need a dialog first), all others are data.

---

## 3. Button Set (Standard) — 15 buttons, 5 groups

Groups separated by a 1px `--color-hairline` vertical divider.

| # | Group | Button | Icon (lucide-react) | Typst output | Action kind |
|---|---|---|---|---|---|
| 1 | Structure | Heading 1 | `Heading1` | `= ` line prefix | `linePrefix` |
| 2 | | Heading 2 | `Heading2` | `== ` line prefix | `linePrefix` |
| 3 | | Heading 3 | `Heading3` | `=== ` line prefix | `linePrefix` |
| 4 | Inline | Bold | `Bold` | `*…*` (wrap) | `wrap` |
| 5 | | Italic | `Italic` | `_…_` (wrap) | `wrap` |
| 6 | | Strikethrough | `Strikethrough` | `#strike[…]` (wrap) | `wrap` |
| 7 | | Inline code | `Code` | `` `…` `` (wrap) | `wrap` |
| 8 | | Link | `Link` | `#link("URL")[label]` → opens URL prompt | `custom` |
| 9 | Blocks | Code block | `SquareCode` | ` ``` \n\n``` ` (replace) | `replace` |
| 10 | | Quote | `Quote` | `#quote[…]` (wrap) | `wrap` |
| 11 | | Bullet list | `List` | `- ` line prefix | `linePrefix` |
| 12 | | Numbered list | `ListOrdered` | `+ ` line prefix | `linePrefix` |
| 13 | | Horizontal rule | `Minus` | `#line(length: 100%)\n` (replace) | `replace` |
| 14 | Insert | Image | `Image` | `#image("…")` after picker | `custom` |
| 15 | | Table | `Table` | `#table(columns: N, …)` after grid picker | `custom` |

Quote uses `#quote[…]` to match the htmlToTypst output at `blocks.ts:46-48`.

---

## 4. Components & Files

All new files under `src/components/FormatToolbar/`. CSS appended to `src/styles/global.css` (single-stylesheet convention).

```
src/components/FormatToolbar/
├── FormatToolbar.tsx        # container: groups, dividers, dispatches actions
├── formatActions.ts         # action table + FormatAction/FormatApi types (no React)
├── FormatToolbarButton.tsx  # one button; aria-pressed, title=tooltip, disabled state
├── TableGridPicker.tsx      # hover-grid popup (m×n up to 8×8)
└── useInsertImage.ts        # the picker→copy→insert flow (hook returning a callback)
```

### Layout integration — `src/components/Shell/EditorArea.tsx`

```tsx
<div className="editor-area">
  <div className="editor-area-header">   {/* existing: TabStrip + preview-toggle */}
    <TabStrip />
    <button className="preview-toggle" .../>
  </div>
  <FormatToolbar                          {/* NEW */}
    api={editorApiRef.current}
    readyTick={editorReadyTick}           {/* re-render when editor becomes ready */}
    tab={activeTab}
    disabled={activeTab === null}
  />
  <main className="editor-area-main"> … </main>
</div>
```

The toolbar reads `editorApiRef.current` (already in `EditorArea.tsx:50`); `readyTick` (`EditorArea.tsx:51`) triggers re-render when the editor becomes ready.

---

## 5. Action Behaviors

### 5.1 `wrapSelection(prefix, suffix, placeholder?)`
- If selection empty: insert `prefix + placeholder + suffix`, select the placeholder range.
- If selection non-empty: insert `prefix + selected + suffix`, leave selection covering the wrapped text.
- Push undo stop before and after (`editor.pushUndoStop()`).

### 5.2 `toggleLinePrefix(prefix)`
- Compute the line range touched by selection (or just the caret's line).
- For each line: if it already starts with a known prefix (`=+ `, `- `, `+ `, `> `), strip it first; then add `prefix` if `prefix` differs from what was stripped.
- Always operates on line starts; preserves cursor column sensibly.

### 5.3 Link button (`custom`)
- A small modal rendered by `FormatToolbar` itself (overlay + text input) collecting a URL and an optional label. The selection text pre-fills the label field. On submit:
  - **Typed label present** → `api.replaceSelection('#link("URL")[label]')`.
  - **No typed label, but a selection exists** → `api.wrapSelection('#link("URL")[', "]")`, so the selected text becomes the label.
  - **No typed label and no selection** → `api.replaceSelection('#link("URL")')` (a bare link; avoids the invalid `#link("URL")[]`).
  - The URL is escaped via `escapeTypstStr`.
- Esc cancels; Enter submits.

### 5.4 Image button (`custom`) → `useInsertImage.ts`
Flow reuses existing primitives:
1. Call new Tauri command `pick_image_file` → returns absolute path.
2. Read bytes via `@tauri-apps/plugin-fs`; compute `ext = inferExt(path)` (`src/lib/htmlToTypst/images.ts`).
3. `fileDir = await resolveImageDir(ctx, tab)` (`imageIo.ts`).
4. `rel = expandTemplate(insertImagePathTemplate, { fileDir, fileName, filePath, workspace, ext, timestamp, index })` (`pathMacros`). Default template: `${fileDir}/assets/${fileName}`.
5. `abs = await ensureAbsolute(rel, workspace)`.
6. `await writeImage(abs, bytes)`.
7. Insert `#image("${escapeTypstStr(abs)}")` via `api.replaceSelection`.
   - **v1 inserts absolute path** (matches existing paste flow at `usePasteConvert.ts:131-138`). Relative path computation is a documented follow-up.

### 5.5 Table button (`custom`) → `TableGridPicker.tsx`
- 8×8 grid of cells; hovering sets `rows × cols`; click inserts.
- Inserted text (matching `htmlToTypst/tables.ts:42-51`):
  ```
  #table(
    columns: <cols>,
    [ ], [ ], … <cols × rows empty content cells>
  )
  ```
- Each cell is `[ ]` (single space so the cell renders). Cursor placed in the first cell after insert.
- Picker closes on outside-click or Esc.

---

## 6. Backend Changes

### 6.1 New Tauri command: `pick_image_file`
File: `src-tauri/src/ipc/commands.rs` (alongside `open_file` at `commands.rs:42`).

```rust
/// Open a native image-picker dialog and return the chosen file's path.
/// Returns `None` if the user cancels. Bytes are read by the frontend via
/// the fs plugin (matches the paste-image flow).
#[tauri::command]
pub async fn pick_image_file(app: AppHandle) -> Result<Option<String>> {
    let app_for_dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog
            .dialog()
            .file()
            .add_filter("Images", &["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?;
    let Some(picked) = picked else { return Ok(None) };
    let path = path_buf_from(picked)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
```

- Register in `src-tauri/src/lib.rs` `invoke_handler!` alongside `open_file`.
- Frontend wrapper in `src/lib/tauri.ts`: `export async function pickImageFile(): Promise<string | null>`.

### 6.2 New setting: `editor.insertImagePath`
File: `src-tauri/settings/manifest.json`, in the `editor` category (after the existing paste-image trio, line 17):

```json
{ "key": "editor.insertImagePath", "type": "string",
  "label": "Inserted image path",
  "default": "${fileDir}/assets/${fileName}",
  "help": "Where toolbar-inserted images are copied. Macros: ${fileDir}, ${fileName}, ${workspace}, ${ext}, ${timestamp}." }
```

The Settings UI auto-renders this from the manifest. Read via `useSetting<string>("editor.insertImagePath")` in `useInsertImage.ts`.

---

## 7. Styling (DESIGN.md compliance)

Appended to `src/styles/global.css`:

- `.format-toolbar` — `display: flex; align-items: center; gap: var(--space-xxs); height: 36px; padding: 0 var(--space-xs); border-bottom: 1px solid var(--color-hairline); background: var(--color-canvas); flex: 0 0 auto;`
- `.format-toolbar-button` — clone of `.explorer-action` (22×22 transparent, `var(--color-ink-muted-48)`, hover `rgba(0,0,0,0.06)` + ink, active `scale(0.9)`).
- `.format-toolbar-button[aria-pressed="true"]` — `background: var(--color-canvas-parchment); color: var(--color-ink);`
- `.format-toolbar-button:disabled` — `opacity: 0.4; cursor: default;`
- `.format-toolbar-divider` — `width: 1px; height: 18px; background: var(--color-hairline); margin: 0 var(--space-xxs);`
- `.table-grid-picker` — small popover: hairline + soft `rgba(0,0,0,0.08)` shadow.
- `.table-grid-cell` — 16×16, hover `background: var(--color-primary)` + white text.
- `.link-modal-overlay` / `.link-modal` — reuse `.dialog-overlay` + `.dialog`.

**Height rationale:** 36px matches `--commandbar-h: 36px`. The `--toolbar-h: 52px` token is sized for a frosted sub-nav with 21px tagline text; a 15-button icon toolbar is denser.

---

## 8. State, i18n, Theme

- **State:** no new store. The toolbar reads `editorApiRef` (prop), `useTabsStore` for active tab, `useWorkspaceStore` for `rootPath`, and `useSetting` for the image-path template. Link modal + table picker use local `useState`.
- **i18n:** none in the project; hardcode English string literals inline.
- **Theme:** all colors via CSS variables → automatically follows any user-selected theme.

---

## 9. Testing

- `formatActions.test.ts` — pure unit tests for the action table.
- `MonacoEditorApi.edit.test.ts` — extract edit-method implementations into testable helpers (`applyWrapSelection`, `applyToggleLinePrefix`, `applyReplaceSelection`); test against a fake/in-memory Monaco editor.
- `TableGridPicker.test.tsx` — render + simulate hover/click.
- `useInsertImage.test.ts` — mock `pickImageFile`, `writeImage`, `resolveImageDir`, `expandTemplate`.
- Manual: click each button in a real tab.

---

## 10. Task Breakdown (subagent-driven)

- **T1** — Extend `MonacoEditorApi` with `wrapSelection` / `replaceSelection` / `toggleLinePrefix` (extract testable helpers, TDD).
- **T2** — `formatActions.ts` action table + tests (no React).
- **T3** — Backend: `pick_image_file` command + register in `lib.rs` + frontend wrapper in `tauri.ts`. Add `editor.insertImagePath` to `manifest.json`.
- **T4** — `FormatToolbarButton.tsx` + `FormatToolbar.tsx` container + CSS in `global.css`. Wire to `EditorArea.tsx`.
- **T5** — `TableGridPicker.tsx` + tests.
- **T6** — `useInsertImage.ts` + link modal + tests.
- **T7** — Final integration pass + finishing-a-development-branch.

---

## 11. Open Questions for Implementation

- **Image path absolute vs relative:** v1 inserts absolute. Relative is a follow-up.
- **Quote button semantics:** `#quote[…]` matches `htmlToTypst/blocks.ts:46-48`.
- **Empty-table cell content:** `[ ]` (single space).
