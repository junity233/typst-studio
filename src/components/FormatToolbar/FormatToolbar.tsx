import type { Tab } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useSetting } from "../../hooks/useSetting";
import {
  FORMAT_BUTTON_GROUPS,
  type FormatAction,
  type FormatApi,
  type ActionContext,
} from "./formatActions";
import { FormatToolbarButton } from "./FormatToolbarButton";

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
      api.wrapSelection(action.prefix, action.suffix, action.placeholder);
      return;
    case "replace":
      api.replaceSelection(action.text);
      return;
    case "linePrefix":
      api.toggleLinePrefix(action.prefix);
      return;
    case "custom":
      // T5 (table grid picker) + T6 (image + link modals) supply the real
      // `run`. The dispatch path is correct today; the stubs just no-op.
      // Swallow rejections here so a failing async action (e.g. image write
      // in T6) surfaces as a console error rather than an uncaught promise
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
 * `linePrefix` buttons are fully functional today; the `custom` insert actions
 * (image / table / link) call through to no-op stubs that T5/T6 replace.
 */
export function FormatToolbar({
  api,
  tab,
  disabled,
}: FormatToolbarProps) {
  const workspace = useWorkspaceStore((s) => s.rootPath);
  const [insertImagePathTemplate] = useSetting<string>("editor.insertImagePath");

  // All buttons disable when there's no tab or no editor API yet. The `disabled`
  // prop already covers the no-tab case; the api check is defensive (e.g. tab
  // open but Monaco still mounting).
  const isDisabled = disabled || api === null;

  // Build the FormatApi lazily per click rather than memoizing on `api` — the
  // object is tiny (3 method refs) and memoizing on a ref-backed api that
  // doesn't change identity after mount would just add a useMemo for nothing.
  const handleAction = (action: FormatAction) => {
    if (api === null || tab === null) return;
    const formatApi: FormatApi = {
      wrapSelection: api.wrapSelection,
      replaceSelection: api.replaceSelection,
      toggleLinePrefix: api.toggleLinePrefix,
    };
    const actionCtx: ActionContext = {
      tab,
      workspace,
      insertImagePathTemplate,
    };
    dispatchAction(action, formatApi, actionCtx);
  };

  return (
    <div className="format-toolbar" role="toolbar" aria-label="Text formatting">
      {FORMAT_BUTTON_GROUPS.map((group, groupIndex) => (
        <span key={group.id} className="format-toolbar-group">
          {group.buttons.map((button) => (
            <FormatToolbarButton
              key={button.id}
              icon={button.icon}
              label={button.label}
              disabled={isDisabled}
              onClick={() => handleAction(button.action)}
            />
          ))}
          {groupIndex < FORMAT_BUTTON_GROUPS.length - 1 && (
            <span className="format-toolbar-divider" aria-hidden="true" />
          )}
        </span>
      ))}
    </div>
  );
}
