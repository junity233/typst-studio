# Frontend — extension system

> Scope: `src/extensions/**` (api, registry, index, hooks, keybinding, and
> every `<id>/` extension).

The extension system is a VS Code-style contribution framework: in-tree
extensions self-register views, commands, and menu items into three
observable registries; the shell (ActivityBar, Sidebar, command palette,
keybinding dispatcher, TitleBar menus) renders and dispatches those
contributions generically. Extensions are same-origin and fully trusted —
no permission enforcement in the MVP; the `HostApi` shape is designed so a
permission proxy can be layered in later (`src/extensions/api.ts`).

## Core files

- `api.ts` — `HostApi { extensionId, registerView, registerCommand,
  registerMenuItem }`; `createHostApi(id)` binds an id.
- `registry.ts` — contribution types and three registries:
  - `ViewContribution { id, title, icon, component (dynamic-import factory),
    order?, when?: "workspace" | "always" }`
  - `CommandContribution { id, title, category?, keybinding?, handler,
    enablement? }`
  - `MenuItemContribution { command, location, group?, order? }`
  - `Registry<T>`: observable Map, duplicate-id warn+ignore, cached sorted
    snapshot (order ascending, default 100) invalidated on mutation — the
    cache is what keeps `useSyncExternalStore` stable.
- `index.ts` — `activateAll()`: eager `import.meta.glob("./*/index.ts")`,
  extension id = directory name; a missing default export is skipped.
- `hooks.ts` — `useViews()` / `useCommands()` subscribe via
  `useSyncExternalStore`.
- `keybinding.ts` — pure keybinding grammar: `parseKeybinding` (empty string
  = disabled; null on malformed), `matchKeybinding` (exact modifiers,
  `CmdOrCtrl` = meta on macOS / ctrl elsewhere), `keybindingsEqual`
  (platform-resolved conflict detection), `formatKeybinding` (mac glyphs vs
  Ctrl+Alt+Shift words), `captureKeybinding` (keydown → portable string).

## Extension inventory (all `src/extensions/<id>/index.ts`)

| Extension | Contributes | Powers |
|---|---|---|
| `workbench` | 16 core commands (File/View/Export/Go/Insert) + menu items | new-tab, open-file/folder, save, save-as, close-tab, toggle-sidebar/preview, settings, about, export pdf/png/svg/batch, project settings, go-to-main-file |
| `explorer` | view `workbench.explorer` (order 0, `when: workspace`) | file-tree sidebar |
| `outline` | view `workbench.outline` (order 10) + command (Ctrl+Shift+O) | heading outline |
| `search` | view `workbench.search` (order 20) + command (Ctrl+Shift+F) | workspace search |
| `symbols` | view `workbench.symbols` (order 30) | Typst `sym` browser, math/markup-aware insert |
| `bibliography` | view `workbench.bibliography` (order 40, workspace) | .bib/.yml panel, inserts `#cite(<key>)` |
| `project` | view `workbench.project` (order 45, workspace) | `.typstpro` editor form |
| `packages` | view `workbench.packages` (order 50) | Typst Universe browser |
| `assistant` | view `workbench.assistant` (order 60) + command (Ctrl+Shift+I) | AI assistant panel |
| `format` | command `format-document` (Shift+Alt+F) | tinymist formatting |
| `formatShortcuts` | 7 commands (bold/italic/strike/code/heading1-3) | keyboard formatting |
| `formula` | command `insert-formula` (Ctrl+Alt+M) | LaTeX→Typst modal |
| `commandPalette` | command (Ctrl+Shift+P) | palette toggle |

View components live in `src/components/**`; extensions only register lazy
dynamic-import factories for them. Some extensions also carry a declarative
`extension.json` manifest — discovery is the `import.meta.glob` over
`index.ts` only; the manifests are documentation.

## Command dispatch flow

Three entry points converge on `dispatch(menuId)` in
`src/hooks/useAppCommands.ts`:

1. Tauri `menu_event` (native macOS menus, `src-tauri/src/ipc/menu.rs`),
2. the Windows TitleBar dropdowns (`src/components/TitleBar/TitleBar.tsx`),
3. a document-level capture-phase keydown listener that resolves each
   command's effective binding — the user setting `keybindings.<cmdId>`
   overrides the contributed default; empty string disables it.

`dispatch` looks up `commandRegistry`, checks `enablement`, awaits
`handler`; errors funnel through `toIpcError` (`Cancelled` passes silently,
anything else alerts).

## Invariants

- **Activation failure isolation**: one extension's `activate()` throwing is
  caught and logged; the rest activate (mirrors VS Code's policy,
  `index.ts`).
- **Idempotent registration**: duplicate ids are ignored with a warning;
  workbench guards re-entry with an `activated` flag (it has two activation
  paths: `activateAll()` from App and `ensureActivated()` from `dispatch()`,
  deferred to break a circular init with `useAppCommands.ts`).
- **Lazy component shape**: `component` must return the raw dynamic-import
  promise, never pre-wrapped in `lazy()` (stated in extension comments).
- **Titles at activation** resolve via the i18n default import, not
  `useTranslation` — activation precedes any render.
- **Editable-target yield**: keystrokes aimed at focused input/textarea/
  contenteditable are skipped by the global dispatcher; Monaco's hidden
  textarea is deliberately exempted (`src/lib/editableTarget.ts`).

## Gotchas

- Keybinding conflicts are order-dependent: the capture listener iterates
  `commandRegistry.all()` and stops at the first match.
- The Windows TitleBar's "Open Recent" dispatches path-encoded dynamic ids
  (`open-recent:<path>`) handled as a special case in `dispatch`, not
  registry commands.
- `workbench.scm` appears in the ActivityBar's i18n title map but no
  extension currently registers it.
