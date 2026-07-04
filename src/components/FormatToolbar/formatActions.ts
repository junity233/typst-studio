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
 * to act on, where the workspace root is (for resolving relative paths), and
 * the configured image-path template (mirrors the paste-convert hook).
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
        id: "link",
        icon: Link,
        label: "Link",
        // TODO(T6): replace with the link modal (href + text) →
        // `#link("href")[text]` (see inline.ts `<a>` case). The placeholder
        // just no-ops until the dialog ships.
        action: { kind: "custom", run: () => { /* link modal — T6 */ } },
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
        // TODO(T6): replace with the image picker → `#image("path")` using
        // ctx.insertImagePathTemplate (see htmlToTypst/images.ts).
        action: { kind: "custom", run: () => { /* image picker — T6 */ } },
      },
      {
        id: "table",
        icon: Table,
        label: "Insert table",
        // TODO(T5): replace with the table grid picker → #table(...) (see
        // htmlToTypst/tables.ts).
        action: { kind: "custom", run: () => { /* table grid picker — T5 */ } },
      },
    ],
  },
];
