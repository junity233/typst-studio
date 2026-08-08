import { useEffect, useRef, useState } from "react";
import { Keyboard, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SettingDef } from "../../lib/settings-types";
import { useSetting, readSetting } from "../../hooks/useSetting";
import { SETTING_ID } from "./SettingsApp";
import { commandRegistry } from "../../extensions/registry";
import {
  captureKeybinding,
  formatKeybinding,
  keybindingsEqual,
  parseKeybinding,
} from "../../extensions/keybinding";

/**
 * A `keybinding`-type setting renders as a "press a key" field plus Clear and
 * Reset buttons. The setting key mirrors a command id under a `keybindings.`
 * prefix (e.g. setting `keybindings.format.bold` overrides command
 * `format.bold`); the dispatcher in useAppCommands reads the same path to
 * resolve the effective binding, so a change here takes effect on the next
 * keystroke.
 *
 * Capture flow: clicking the field enters "listening" mode (highlighted), and
 * the next keydown is serialized via {@link captureKeybinding} into the
 * `CmdOrCtrl+…` storage form. Bare modifier presses (Shift/Ctrl/Alt/Cmd alone)
 * are ignored — we wait for the real key. Escape cancels without saving.
 *
 * Conflict detection: on commit we scan the registry for another command whose
 * effective binding (its own setting override, else its default) matches. A
 * conflict is surfaced as an inline warning but NOT blocked — the dispatcher
 * resolves collisions by registry order (first match wins), so the user can
 * still save and then clear the other binding if they wish.
 */
export function KeybindingControl({ def }: { def: SettingDef }) {
  const { t } = useTranslation("settings");
  const [value, setValue] = useSetting<string>(def.key);
  const fallback = typeof def.default === "string" ? def.default : "";
  const current = typeof value === "string" ? value : fallback;
  const [listening, setListening] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const fieldRef = useRef<HTMLButtonElement | null>(null);

  // Resolve which command id this setting overrides. The setting key is
  // `keybindings.<cmdId>`; strip the prefix to get the command id (which may
  // itself contain dots, e.g. `format.bold`).
  const cmdId = def.key.startsWith("keybindings.")
    ? def.key.slice("keybindings.".length)
    : def.key;

  // While listening, grab keydown at the window level so the capture fires even
  // if focus drifts, and preventDefault to stop the browser (and our own app
  // dispatcher) from acting on the chord being recorded.
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const captured = captureKeybinding(e);
      if (captured === null) {
        // Escape (cancel) or bare modifier (keep waiting). Only Escape exits.
        if (e.key === "Escape") setListening(false);
        return;
      }
      setValue(captured);
      setConflict(detectConflict(cmdId, captured));
      setListening(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, cmdId, setValue]);

  const reset = () => {
    setValue(fallback);
    setConflict(detectConflict(cmdId, fallback));
    setListening(false);
  };

  const clear = () => {
    setValue("");
    setConflict(null);
    setListening(false);
  };

  const display = current === "" ? t("keybindingNone") : formatKeybinding(current);
  const isDefault = current === fallback;

  return (
    <div className="keybinding-control">
      <button
        ref={fieldRef}
        id={SETTING_ID(def.key)}
        type="button"
        className={
          "setting-input keybinding-field" + (listening ? " keybinding-field-listening" : "")
        }
        onClick={() => {
          setConflict(null);
          setListening(true);
        }}
      >
        <Keyboard size={13} />
        <span className="keybinding-field-text">
          {listening ? t("keybindingPrompt") : display}
        </span>
      </button>
      {!isDefault && (
        <button
          type="button"
          className="keybinding-control-reset"
          aria-label={t("keybindingReset")}
          title={t("keybindingReset")}
          onClick={reset}
        >
          <RotateCcw size={13} />
        </button>
      )}
      {current !== "" && (
        <button
          type="button"
          className="path-control-clear"
          aria-label={t("keybindingClear")}
          title={t("keybindingClear")}
          onClick={clear}
        >
          <X size={13} />
        </button>
      )}
      {conflict && (
        <p className="keybinding-conflict">{t("keybindingConflict", { other: conflict })}</p>
      )}
    </div>
  );
}

/**
 * Find another command whose effective binding equals `binding`. Returns the
 * conflicting command's title (for display) or null. Skips the command being
 * edited (`selfCmdId`). "Effective" mirrors the dispatcher: the per-command
 * setting override, else the command's declared default.
 *
 * Comparison is by PARSED equivalence (`keybindingsEqual`), not raw string
 * equality: `Ctrl+B` and `CmdOrCtrl+B` collide on Windows/Linux, and
 * `Shift+Alt+F` collides with `Alt+Shift+F` (modifier order is irrelevant). A
 * naive string compare would miss both and silently let the user save a
 * collision that the dispatcher then resolves by registry order.
 */
function detectConflict(selfCmdId: string, binding: string): string | null {
  const parsed = parseKeybinding(binding);
  if (parsed === null) return null;
  for (const cmd of commandRegistry.all()) {
    if (cmd.id === selfCmdId) continue;
    const override = readSetting<string | undefined>(
      `keybindings.${cmd.id}`,
      undefined,
    );
    const effective = override ?? cmd.keybinding;
    if (!effective) continue;
    const other = parseKeybinding(effective);
    if (other !== null && keybindingsEqual(parsed, other)) {
      return cmd.title || cmd.id;
    }
  }
  return null;
}
