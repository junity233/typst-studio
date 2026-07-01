interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

/**
 * A controlled switch — the project's first toggle. Clicking flips `onChange`.
 * The visual state is driven entirely by `aria-pressed` (see `.toggle` CSS):
 * track fills Action Blue when on, translucent chip-gray when off; the white
 * knob slides right. Active press applies the system-wide `scale(0.95)` nudge.
 */
export function Toggle({ checked, onChange, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      className="toggle"
      aria-pressed={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-track">
        <span className="toggle-knob" />
      </span>
    </button>
  );
}
