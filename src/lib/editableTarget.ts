/**
 * Whether a key event's target is a real editable control — an `<input>`,
 * `<textarea>`, `<select>`, or any `[contenteditable]` element. When the user
 * is typing in such a control (the Search panel input, the Assistant textarea,
 * a contenteditable cell, …) it should own the keystrokes, so the app-global
 * shortcuts (save / find / format) must yield and NOT be intercepted.
 * Defensive about non-Element targets: the listener is on `document`, so the
 * target can be the `Document` itself or `null`.
 *
 * Extracted verbatim from `useAppCommands.ts` (its capture-phase keybinding
 * dispatcher is the only production caller) so the rule can be tested against
 * a real DOM without any Tauri mocking.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // Monaco renders its editable surface as a hidden <textarea class="inputarea">
  // inside `.monaco-editor`. That textarea would otherwise match the
  // HTMLTextAreaElement branch below and cause every app-global shortcut (save,
  // format, AND the formatting shortcuts like Ctrl+B) to be skipped while the
  // editor is focused — the opposite of what we want. The editor owns its own
  // keybindings via Monaco's command system, but our app-global shortcuts are
  // intentionally layered on top (capture-phase), so treat anything inside the
  // Monaco editor as NOT an editable-yielding target.
  if (target.closest(".monaco-editor")) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  // `isContentEditable` is defined on HTMLElement (not Element), so narrow
  // further before reading it. SVGElement extends Element but not HTMLElement,
  // and isn't relevant here anyway.
  return target instanceof HTMLElement && target.isContentEditable === true;
}
