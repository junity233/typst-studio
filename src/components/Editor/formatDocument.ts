import { editorApiRef } from "./editorApiRef";
import { useLspStore } from "../../store/lspStore";
import { appLanguageClient } from "./appLanguageClient";

/**
 * The reason `formatActiveDocument` did not format. Drives how the caller
 * surfaces the outcome to the user:
 * - `"no-lsp"`    — tinymist isn't running; the caller alerts the user to
 *                   install/restart it (formatting is impossible without the
 *                   language server providing `textDocument/formatting`).
 * - `"no-action"` — the editor/format action isn't registered right now (e.g.
 *                   the editor is gone or the LSP feature hasn't attached).
 *                   Silently ignored by the caller; it typically means there
 *                   is simply nothing to format at the moment.
 */
export type FormatNotDoneReason = "no-lsp" | "no-action";

export interface FormatResult {
  /** `true` when tinymist formatting was invoked; `false` with `reason` otherwise. */
  formatted: boolean;
  /** Present (and `formatted` false) when formatting could not be performed. */
  reason?: FormatNotDoneReason;
}

/**
 * Format the active document via tinymist's `textDocument/formatting`.
 *
 * Routing: `MonacoEditorApi.formatDocument()` calls
 * `editor.getAction("editor.action.formatDocument")?.run()`. The LSP client
 * (`MonacoLanguageClient`, default capabilities) auto-registers
 * `vscode-languageclient`'s `DocumentFormattingEditProviderFeature`, so that
 * action is wired to tinymist. The returned `TextEdit[]` is applied by
 * Monaco's own machinery, and the resulting content-change flows through the
 * existing `handleTextChanged → updateText → update_text_at_revision` backend
 * sync — no Rust change is needed for the formatting itself.
 *
 * Availability gate: if tinymist isn't installed (the authoritative
 * `useLspStore.status.available` flag is false) OR the client isn't running,
 * formatting is impossible — return `{ formatted: false, reason: "no-lsp" }`
 * so the caller can prompt the user. When the LSP is available but the action
 * isn't registered (editor gone, feature not yet attached), return
 * `{ formatted: false, reason: "no-action" }` (transient — silently ignored).
 *
 * Pure-ish: reads live state at call time (`useLspStore.getState()`,
 * `appLanguageClient.isRunning()`, `editorApiRef.current`) so the gate reflects
 * the moment of invocation, not the moment of registration.
 */
export async function formatActiveDocument(): Promise<FormatResult> {
  const available =
    useLspStore.getState().status.available && appLanguageClient.isRunning();
  if (!available) {
    return { formatted: false, reason: "no-lsp" };
  }
  const formatted = await editorApiRef.current?.formatDocument();
  if (formatted !== true) {
    return { formatted: false, reason: "no-action" };
  }
  return { formatted: true };
}
