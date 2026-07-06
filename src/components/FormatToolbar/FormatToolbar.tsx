import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Tab } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useSetting } from "../../hooks/useSetting";
import {
  FORMAT_BUTTON_GROUPS,
  TABLE_BUTTON_ID,
  type FormatAction,
  type FormatApi,
  type ActionContext,
} from "./formatActions";
import { FormatToolbarButton } from "./FormatToolbarButton";
import { TableGridPicker } from "./TableGridPicker";
import { buildTableSnippet } from "./buildTableSnippet";
import { LinkModal } from "./LinkModal";
import { escapeTypstStr } from "../../lib/htmlToTypst/escape";
import { useInsertImage } from "./useInsertImage";

/**
 * Dispatch a single button action against a {@link FormatApi} (+ the optional
 * {@link ActionContext} that `custom` actions need). Pure: no React, no store.
 *
 * Exported so the test suite can pin each branch (wrap / replace / linePrefix
 * / custom) without standing up the editor or a render harness — the toolbar
 * component is a thin caller of this, so locking its dispatch matrix pins the
 * rendered behavior too.
 */
export function dispatchAction(
  action: FormatAction,
  api: FormatApi,
  ctx: ActionContext,
): void {
  switch (action.kind) {
    case "wrap":
      // Idempotent: toggleWrap removes the markers when the selection is already
      // inside them, adds them otherwise (state-aware toolbar T3). The action
      // table's `kind` stays "wrap" — only the dispatch routing changes. The
      // link flow's handleLinkConfirm still uses wrapSelection directly (it
      // always inserts, never removes).
      api.toggleWrap(action.prefix, action.suffix, action.placeholder);
      return;
    case "replace":
      api.replaceSelection(action.text);
      return;
    case "linePrefix":
      api.toggleLinePrefix(action.prefix);
      return;
    case "custom":
      // T5 (table grid picker, no-op run + render-loop ternary) + T6 (image
      // flow via ctx.insertImage, link modal via ctx.openModal) supply the real
      // `run`. Swallow rejections here so a failing async action (e.g. image
      // write) surfaces as a console error rather than an uncaught promise
      // rejection in the renderer. Each `run` should still handle its own
      // user-facing error UI; this is the safety net.
      void Promise.resolve(action.run(api, ctx)).catch((e) => {
        console.error("[FormatToolbar] custom action failed:", e);
      });
      return;
  }
}

export interface FormatToolbarProps {
  /**
   * The live editor API; null until the editor reports ready. The toolbar only
   * ever touches the three {@link FormatApi} edit methods, so the prop is typed
   * as the narrower `FormatApi` (which the parent's `MonacoEditorApi`
   * structurally satisfies) — keeps the toolbar decoupled from the full editor
   * surface and lets tests pass a minimal mock.
   */
  api: FormatApi | null;
  /** The active document, or null when nothing is open. */
  tab: Tab | null;
  /** True when there's no tab to act on; disables every button. */
  disabled: boolean;
}

/**
 * The format toolbar: a horizontal strip of 15 icon buttons grouped into four
 * sections (structure / inline / blocks / insert) separated by dividers.
 *
 * Reads the button table from {@link FORMAT_BUTTON_GROUPS} (pure data) and
 * dispatches each click via {@link dispatchAction}. `wrap` / `replace` /
 * `linePrefix` buttons are fully functional; the table button opens the
 * {@link TableGridPicker} (special-cased by {@link TABLE_BUTTON_ID} in the
 * render loop — predates the openModal mechanism). The image button runs the
 * async insert flow via `ActionContext.insertImage` (built from {@link
 * useInsertImage}), and the link button opens the {@link LinkModal} via
 * `ActionContext.openModal`.
 */
export function FormatToolbar({
  api,
  tab,
  disabled,
}: FormatToolbarProps) {
  const { t } = useTranslation("formatToolbar");
  const workspace = useWorkspaceStore((s) => s.rootPath);
  const [insertImagePathTemplate] = useSetting<string>("editor.insertImagePath");
  // The table grid picker's anchor when open; null = closed. Set by the table
  // button's onClick from its own bounding rect; cleared by the picker's
  // onCancel / onSelect.
  const [tablePickerAnchor, setTablePickerAnchor] = useState<{ x: number; y: number } | null>(null);
  // The link modal's open flag. No anchor needed — it's centered like the
  // other dialogs (reuses .dialog-overlay / .dialog).
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  // The label field's initial value when the link modal opens. Pre-filled with
  // the current selection so the user sees what they're linking (spec §5.3) and
  // can confirm as-is or type a different label.
  const [linkInitialLabel, setLinkInitialLabel] = useState("");

  // cursorTick: a re-render trigger, not a value the render reads directly.
  // The subscription below fires on caret moves (clicks, arrows) and selection
  // drags (T2 wires both); each fire bumps the tick so computePressed (which
  // queries isInsideWrap / isLinePrefixActive synchronously during render)
  // re-reads the live editor state. This mirrors the dropped readyTick pattern.
  const [cursorTick, setCursorTick] = useState(0);

  // Re-query each button's aria-pressed state when the caret/selection moves.
  // Gated on api + disabled: with no api there's nothing to subscribe to, and
  // a disabled toolbar renders no pressed state anyway (computePressed
  // short-circuits). The returned disposer is wired through to React's effect
  // cleanup so a re-subscribe (api/disabled change) unhooks the old listener.
  useEffect(() => {
    if (api === null || disabled) return;
    return api.onDidChangeCursorPosition(() => setCursorTick((t) => t + 1));
  }, [api, disabled]);

  // The insert-image flow (picker → copy → insert). The hook tolerates a null
  // tab (bails internally) so we can always call it at the top level and pass
  // the current tab through; each render's closure captures the latest ctx.
  const insertImage = useInsertImage({ tab, workspace, insertImagePathTemplate });

  // All buttons disable when there's no tab or no editor API yet. The `disabled`
  // prop already covers the no-tab case; the api check is defensive (e.g. tab
  // open but Monaco still mounting).
  const isDisabled = disabled || api === null;

  // Compute a button's aria-pressed state from the live editor state. Called
  // during render (cheap: at most 10 single-line scans), and re-run on every
  // render — the cursorTick effect above ensures a re-render after each cursor
  // move so this re-reads fresh editor state. wrap buttons are pressed when the
  // selection sits inside their markers; linePrefix buttons when every selected
  // line already carries the prefix; replace / custom have no meaningful
  // active state (they're one-shot insertions), so they report false. The
  // isDisabled guard short-circuits so a disabled toolbar never shows pressed.
  // `void cursorTick` documents that the tick's sole purpose is to trigger the
  // re-render in which this function re-runs — it is intentionally not read.
  void cursorTick;
  const computePressed = (action: FormatAction): boolean => {
    if (isDisabled || api === null) return false;
    switch (action.kind) {
      case "wrap":
        return api.isInsideWrap(action.prefix, action.suffix);
      case "linePrefix":
        return api.isLinePrefixActive(action.prefix);
      default:
        return false;
    }
  };

  // openModal dispatches a React-rendered popup from an action's `run`. Today
  // only "link" exists; the switch leaves room to add more without touching the
  // action table.
  const openModal = (kind: "link") => {
    if (kind === "link") {
      // Pre-fill the label with the current selection (spec §5.3) so the user
      // can confirm the existing text as the link label or type a new one.
      setLinkInitialLabel(api?.getSelectionText() ?? "");
      setLinkModalOpen(true);
    }
  };

  // `api` is already the narrow FormatApi (the prop type), so dispatch reads it
  // directly — no need to rebuild a wrapper object per click.
  const handleAction = (action: FormatAction) => {
    if (api === null || tab === null) return;
    const actionCtx: ActionContext = {
      tab,
      workspace,
      insertImagePathTemplate,
      openModal,
      insertImage,
    };
    dispatchAction(action, api, actionCtx);
  };

  // Link confirm: per spec §5.3, wrap the current selection as the link label
  // (or use a typed label, or fall back to a bare `#link("url")`). Three cases:
  //  1. User typed a label in the modal → replace the selection with the full
  //     `#link("url")[typedLabel]` (the typed label wins over any selection).
  //  2. No typed label but there IS a selection → wrap the selection:
  //     `#link("url")[` … `]` around the selected text.
  //  3. No typed label and no selection → bare `#link("url")` (URL is the only
  //     content). wrapSelection with an empty placeholder would instead emit
  //     `#link("url")[]`, which is invalid Typst, so we replaceSelection here.
  // The URL is escaped via escapeTypstStr (matches inline.ts `<a>`); the label
  // is inserted verbatim into the `[…]` content (Typst content markup, not a
  // string literal, so backslash/quote escaping is intentionally not applied —
  // escaping it would show literal backslashes in the rendered link).
  const handleLinkConfirm = (url: string, label: string) => {
    if (api === null) {
      setLinkModalOpen(false);
      return;
    }
    const escapedUrl = escapeTypstStr(url);
    const head = '#link("' + escapedUrl + '")';
    const trimmedLabel = label.trim();
    if (trimmedLabel) {
      api.replaceSelection(head + "[" + trimmedLabel + "]");
    } else {
      const selectionText = api.getSelectionText();
      if (selectionText) {
        api.wrapSelection(head + "[", "]");
      } else {
        api.replaceSelection(head);
      }
    }
    setLinkModalOpen(false);
  };

  // Table grid picker: open below the clicked button (4px gap), then insert the
  // snippet on confirm. The button's own `action.run` is a no-op — React UI
  // can't be launched from a plain action handler, so the table button is
  // special-cased in the render loop (detected by TABLE_BUTTON_ID) and given an
  // onClick that captures the anchor from the click's currentTarget.
  const openTablePicker = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (api === null || tab === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setTablePickerAnchor({ x: rect.left, y: rect.bottom + 4 });
  };
  const handleTableSelect = (rows: number, cols: number) => {
    if (api !== null) {
      api.replaceSelection(buildTableSnippet(rows, cols));
    }
    setTablePickerAnchor(null);
  };

  return (
    <div className="format-toolbar" role="toolbar" aria-label={t("toolbarLabel", { defaultValue: "Text formatting" })}>
      {FORMAT_BUTTON_GROUPS.map((group, groupIndex) => (
        <span key={group.id} className="format-toolbar-group">
          {group.buttons.map((button) => (
            <FormatToolbarButton
              key={button.id}
              icon={button.icon}
              label={t(button.id, { defaultValue: button.label })}
              disabled={isDisabled}
              pressed={computePressed(button.action)}
              onClick={
                button.id === TABLE_BUTTON_ID
                  ? openTablePicker
                  : () => handleAction(button.action)
              }
            />
          ))}
          {groupIndex < FORMAT_BUTTON_GROUPS.length - 1 && (
            <span className="format-toolbar-divider" aria-hidden="true" />
          )}
        </span>
      ))}
      {tablePickerAnchor !== null && (
        <TableGridPicker
          anchor={tablePickerAnchor}
          onSelect={handleTableSelect}
          onCancel={() => setTablePickerAnchor(null)}
        />
      )}
      {linkModalOpen && (
        <LinkModal
          initialLabel={linkInitialLabel}
          onConfirm={handleLinkConfirm}
          onCancel={() => setLinkModalOpen(false)}
        />
      )}
    </div>
  );
}
