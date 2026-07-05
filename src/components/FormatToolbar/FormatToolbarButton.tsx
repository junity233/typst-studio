import type { LucideIcon } from "lucide-react";

/**
 * Props for a single format-toolbar icon button.
 *
 * - `icon`     — a lucide-react component (Bold, Heading1, …).
 * - `label`    — the tooltip text (native `title`) and accessible name.
 * - `pressed`  — active state: true when the caret/selection sits inside this
 *                button's markup (e.g. Bold is pressed inside `*…*`, Heading 1
 *                is pressed on a `= ` line). Drives `aria-pressed` and the
 *                parchment-tint highlight (`.format-toolbar-button[aria-pressed="true"]`).
 *                Computed by `FormatToolbar`'s `computePressed` from the live
 *                editor API on every render (re-render is triggered by the
 *                `cursorTick` subscription).
 * - `disabled` — mirrors the toolbar-level disabled flag (no tab / no editor API).
 *
 * Presentational only — the click handler is supplied by the parent container,
 * which knows the button's {@link FormatAction} and the live editor API.
 */
export interface FormatToolbarButtonProps {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  /**
   * Click handler. Receives the native React MouseEvent so a caller that needs
   * the button's geometry (e.g. the table button, which anchors its picker to
   * the button's bounding rect) can read `e.currentTarget`. Callers that don't
   * care about the event can ignore the parameter.
   */
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

/**
 * One toolbar button. Icon-only, 14px (the project-wide icon size — matches
 * `Explorer.tsx` and `EditorArea.tsx`). Styled by `.format-toolbar-button` in
 * `global.css`, which mirrors the `.explorer-action` icon-button precedent.
 */
export function FormatToolbarButton({
  icon: Icon,
  label,
  disabled,
  pressed,
  onClick,
}: FormatToolbarButtonProps) {
  return (
    <button
      type="button"
      className="format-toolbar-button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={14} />
    </button>
  );
}
