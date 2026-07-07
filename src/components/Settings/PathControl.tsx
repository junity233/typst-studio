import { useState } from "react";
import { FolderOpen, FileSearch, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SettingDef } from "../../lib/settings-types";
import { useSetting } from "../../hooks/useSetting";
import { pickPath } from "../../lib/tauri";
import { toIpcError } from "../../lib/ipc-error";
import i18n from "../../i18n";
import { SETTING_ID } from "./SettingsApp";

/**
 * A path setting renders as a read-only field + a "Browse…" button that opens
 * a native folder/file picker (per `def.pick`). The field is read-only because
 * the value must come from a real filesystem path — no manual typing.
 *
 * Implemented via the Rust `pick_path` command rather than the frontend dialog
 * plugin: the settings window deliberately grants no `dialog:default`
 * capability, and the Rust `DialogExt` path bypasses that frontend gate (same
 * reason `open_log_dir`/`open_themes_dir` use `app.opener()`).
 */
export function PathControl({ def }: { def: SettingDef }) {
  const { t } = useTranslation("settings");
  const [value, setValue] = useSetting<string>(def.key);
  const fallback = typeof def.default === "string" ? def.default : "";
  const current = typeof value === "string" ? value : fallback;
  const kind = def.pick ?? "folder";
  const isFolder = kind === "folder";
  const [busy, setBusy] = useState(false);

  const browse = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const chosen = await pickPath(kind);
      if (chosen !== null) setValue(chosen);
    } catch (e) {
      // IPC rejections arrive as the structured IpcError object — use toIpcError
      // to avoid [object Object] in the alert.
      window.alert(
        i18n.t("actionFailed", {
          ns: "errors",
          message: toIpcError(e).message,
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const Icon = isFolder ? FolderOpen : FileSearch;
  const browseLabel = isFolder ? t("browseFolder") : t("browseFile");

  return (
    <div className="path-control">
      <input
        id={SETTING_ID(def.key)}
        className="setting-input path-control-input"
        type="text"
        value={current}
        placeholder={t("noPath")}
        readOnly
      />
      {current !== "" && (
        <button
          type="button"
          className="path-control-clear"
          aria-label={t("clearPath")}
          title={t("clearPath")}
          onClick={() => setValue("")}
        >
          <X size={13} />
        </button>
      )}
      <button
        type="button"
        className={"setting-action-btn" + (busy ? " setting-action-busy" : "")}
        onClick={() => void browse()}
        disabled={busy}
      >
        <Icon size={13} /> {busy ? t("working") : browseLabel}
      </button>
    </div>
  );
}
