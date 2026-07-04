import type { LucideIcon } from "lucide-react";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  Minus,
  Quote,
  SquareCode,
  Strikethrough,
  Table,
} from "lucide-react";
import type { Tab } from "../../store/tabsStore";
// Re-export FormatApi so consumers import the action types from one place
// (the toolbar component will do `import type { FormatApi, FormatButton } from
// "./formatActions"` rather than reaching into Editor/ for the API shape).
import type { MonacoEditorApi } from "../Editor/MonacoEditor";

/**
 * The imperative edit surface the format toolbar drives. This is a structural
 * subset of {@link MonacoEditorApi} — exactly the three edit methods the
 * `wrap` / `replace` / `linePrefix` actions call. Carved out as its own type
 * (rather than reusing `MonacoEditorApi`) so the action table doesn't depend
 * on the full editor surface (scroll, reveal, etc.) and so a future non-Monaco
 * editor could satisfy the same shape.
 */
export interface FormatApi {
  wrapSelection: MonacoEditorApi["wrapSelection"];
  replaceSelection: MonacoEditorApi["replaceSelection"];
  toggleLinePrefix: MonacoEditorApi["toggleLinePrefix"];
}

/**
 * Context handed to {@link FormatAction} `custom` handlers. The non-edit
 * details a dialog-driven action (image / table / link) needs: which document
 * to act on, where the workspace root is (for resolving relative paths), the
 * configured image-path template (mirrors the paste-convert hook), and the two
 * React-driven escape hatches (`openModal` / `insertImage`).
 */
export interface ActionContext {
  tab: Tab;
  workspace: string | null;
  /**
   * Image-destination path template for the toolbar's Insert Image button.
   * Sourced from the `editor.insertImagePath` setting (added in T3 — default
   * `${fileDir}/assets/${fileName}`). Distinct from `editor.pasteImagePath`,
   * which governs the paste-rich-text flow (its default uses a `pasted-`
   * prefix + `${hash}` for dedup). Both expand via the same pathMacros engine.
   */
  insertImagePathTemplate: string | undefined;
  /**
   * Open a React-rendered modal (currently just the link URL prompt).
   * Popups that need React UI call this from `action.run`; the FormatToolbar
   * component owns the modal state and renders it. Keeps the action table as
   * the single dispatch source — no render-loop id-matching needed (contrast
   * the table button, which predates this mechanism).
   */
  openModal: (kind: "link") => void;
  /**
   * Kick off the insert-image flow (open native picker → copy into assets →
   * insert `#image("…")`). Async (Tauri IPC) but not React UI, so it runs
   * cleanly inside `action.run` — the FormatToolbar builds this from the
   * {@link useInsertImage} hook and threads it in here.
   */
  insertImage: (api: FormatApi) => Promise<void>;
}

/**
 * A single button's behavior. Four kinds:
 *  - `wrap`        → surround the selection (or drop a placeholder when empty)
 *                    with a prefix/suffix; e.g. `*…*` for bold.
 *  - `replace`     → swap the selection for a ready-made snippet; e.g. an empty
 *                    fenced code block or a `#line` horizontal rule.
 *  - `linePrefix`  → toggle a per-line marker across the selection; e.g. `= `
 *                    for H1, `- ` for bullet.
 *  - `custom`      → anything that needs a dialog first (image picker, table
 *                    grid, link modal). `run` performs the action against the
 *                    live {@link FormatApi} + {@link ActionContext}.
 *
 * `wrap` / `replace` / `linePrefix` are pure data so the toolbar component can
 * dispatch them generically; only `custom` carries executable code.
 */
export type FormatAction =
  | { kind: "wrap"; prefix: string; suffix: string; placeholder?: string }
  | { kind: "replace"; text: string }
  | { kind: "linePrefix"; prefix: string }
  | {
      kind: "custom";
      run: (api: FormatApi, ctx: ActionContext) => void | Promise<void>;
    };

/**
 * One toolbar button. `id` is a stable React key + test id; `icon` is a
 * lucide-react component; `label` is the native tooltip; `action` is what
 * happens on click.
 */
export interface FormatButton {
  /** Stable id, e.g. "heading1", "bold". Used as React key + test id. */
  id: string;
  /** lucide-react icon component, e.g. Bold. */
  icon: LucideIcon;
  /** Tooltip text (native title attribute). Plain English. */
  label: string;
  /** The action to perform when clicked. */
  action: FormatAction;
}

/** A named group of buttons; groups are separated by a divider in the UI. */
export interface FormatButtonGroup {
  id: string;
  buttons: FormatButton[];
}

/**
 * The stable id of the table-insert button. Exported so the toolbar component
 * can special-case it (rendering the {@link TableGridPicker} on click) without a
 * magic string — the button's own `action.run` stays a no-op because React UI
 * can't be rendered from a plain action handler (see TableGridPicker docs).
 */
export const TABLE_BUTTON_ID = "table";

/**
 * The stable id of the link-insert button. Parallel to {@link TABLE_BUTTON_ID}:
 * exported for any id-based checks. Unlike the table button, the link flow does
 * NOT use a render-loop ternary — it goes through `ActionContext.openModal`
 * (`action.run` calls `ctx.openModal("link")`) so the action table stays the
 * single dispatch source and the toolbar component owns the React modal state.
 */
export const LINK_BUTTON_ID = "link";

/**
 * The complete button table for the format toolbar — four groups, 15 buttons.
 *
 * The Typst strings here are pinned to the `src/lib/htmlToTypst/` converter
 * (the canonical HTML→Typst mapping) so the toolbar emits exactly what paste
 * would, and so a typo is caught by the unit tests rather than discovered in
 * the UI. See the cross-references in each group below.
 *
 * No React / Monaco code lives here — this is just data. The toolbar component
 * (a later task) maps over the groups, renders a divider between them, and
 * dispatches each button's `action`.
 */
export const FORMAT_BUTTON_GROUPS: FormatButtonGroup[] = [
  {
    // Headings. Typst prefix is N '=' followed by a space (blocks.ts:
    // `"=".repeat(level) + " "`). toggleLinePrefix handles the add/remove/swap.
    id: "structure",
    buttons: [
      { id: "heading1", icon: Heading1, label: "Heading 1", action: { kind: "linePrefix", prefix: "= " } },
      { id: "heading2", icon: Heading2, label: "Heading 2", action: { kind: "linePrefix", prefix: "== " } },
      { id: "heading3", icon: Heading3, label: "Heading 3", action: { kind: "linePrefix", prefix: "=== " } },
    ],
  },
  {
    // Inline emphasis. wrapSelection inserts the placeholder when the
    // selection is empty and selects it so the user can type over it.
    // Strings match inline.ts: bold `*…*`, italic `_…_`, strike `#strike[…]`,
    // inline code `` `…` ``.
    id: "inline",
    buttons: [
      { id: "bold", icon: Bold, label: "Bold", action: { kind: "wrap", prefix: "*", suffix: "*", placeholder: "bold" } },
      { id: "italic", icon: Italic, label: "Italic", action: { kind: "wrap", prefix: "_", suffix: "_", placeholder: "italic" } },
      { id: "strikethrough", icon: Strikethrough, label: "Strikethrough", action: { kind: "wrap", prefix: "#strike[", suffix: "]", placeholder: "text" } },
      { id: "code", icon: Code, label: "Inline code", action: { kind: "wrap", prefix: "`", suffix: "`", placeholder: "code" } },
      {
        id: LINK_BUTTON_ID,
        icon: Link,
        label: "Link",
        // Opens the link modal via ActionContext.openModal — NOT a render-loop
        // ternary (unlike the table button). The FormatToolbar owns the modal
        // state and inserts `#link("url")[label]` (or `#link("url")` bare) on
        // confirm. See inline.ts `<a>` case for the Typst syntax.
        action: { kind: "custom", run: (_api, ctx) => { ctx.openModal("link"); } },
      },
    ],
  },
  {
    // Block-level constructs. Code block + HR are `replace` (they drop a whole
    // block, not wrap a selection); quote is a wrap; lists are line prefixes.
    // Strings match blocks.ts (convertPre raw block, blockquote, list marker,
    // hr `#line(length: 100%)`).
    id: "blocks",
    buttons: [
      {
        id: "codeBlock",
        icon: SquareCode,
        label: "Code block",
        // Typst raw block (blocks.ts convertPre): ```lang\n<body>\n```. The
        // toolbar inserts an empty one — "lang" is the user-editable language
        // tag, the blank line is the body. Both trailing newlines are kept so
        // the close fence lands on its own line.
        action: { kind: "replace", text: "```lang\n\n```\n" },
      },
      { id: "quote", icon: Quote, label: "Quote", action: { kind: "wrap", prefix: "#quote[", suffix: "]", placeholder: "text" } },
      { id: "bulletList", icon: List, label: "Bullet list", action: { kind: "linePrefix", prefix: "- " } },
      { id: "numberedList", icon: ListOrdered, label: "Numbered list", action: { kind: "linePrefix", prefix: "+ " } },
      { id: "horizontalRule", icon: Minus, label: "Horizontal rule", action: { kind: "replace", text: "#line(length: 100%)\n" } },
    ],
  },
  {
    // Insert actions. Both need a picker dialog first (image path / table
    // dimensions), so they're `custom` stubs that real handlers replace in
    // later tasks.
    id: "insert",
    buttons: [
      {
        id: "image",
        icon: Image,
        label: "Insert image",
        // Delegates to ActionContext.insertImage, built by FormatToolbar from
        // the useInsertImage hook (open native picker → copy into assets →
        // insert `#image("…")`). Image flow is async (Tauri IPC) but not React
        // UI, so `run` works cleanly without openModal / a ternary.
        action: { kind: "custom", run: (api, ctx) => { void ctx.insertImage(api); } },
      },
      {
        id: TABLE_BUTTON_ID,
        icon: Table,
        label: "Insert table",
        // The picker (TableGridPicker) is rendered by the toolbar component, not
        // by this `run` — React UI can't be launched from a plain action handler
        // (it has no React context / event). The toolbar detects
        // `id === TABLE_BUTTON_ID` in its render loop and overrides onClick to
        // open the picker; this stub stays a no-op so dispatchAction's generic
        // `custom` path doesn't double-fire. See FormatToolbar.tsx.
        action: { kind: "custom", run: () => { /* table grid picker — T5 */ } },
      },
    ],
  },
];
