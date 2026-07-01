import { Breadcrumb } from "./Breadcrumb";

/**
 * The top command bar: a breadcrumb of the active document's location (within
 * the workspace) plus its dirty state. Primary actions (Open / Save / Export)
 * live in the native app menu (File / Export) rather than inline buttons — this
 * bar is for context, not chrome. The native menu is always available.
 *
 * NOTE: this component is intentionally minimal in the first pass. The
 * overflow menu + command dispatch hook land with the menu-event wiring.
 */
export function CommandBar() {
  return (
    <header className="command-bar">
      <Breadcrumb />
    </header>
  );
}
