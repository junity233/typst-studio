import { Trans, useTranslation } from "react-i18next";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { toIpcError } from "../../lib/ipc-error";
import i18n from "../../i18n";

/**
 * Shown in the sidebar when no workspace folder is open. Offers to open a
 * folder (native dialog). Documents can still be opened individually via the
 * File menu, but the file tree needs a workspace root.
 */
export function EmptyWorkspace() {
  const { t } = useTranslation("sidebar");
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);

  const handleOpen = () => {
    void openWorkspace().catch((e) => {
      console.error("[EmptyWorkspace] open failed:", e);
      window.alert(
        i18n.t("couldNotOpenFolder", {
          ns: "errors",
          message: toIpcError(e).message,
        }),
      );
    });
  };

  return (
    <div className="sidebar-empty">
      <span className="sidebar-empty-glyph" aria-hidden>
        {/* A folder-mark glyph rendered in mono weight 300 — the sidebar's
            hero artifact (DESIGN.md product-tile grammar). */}
        □
      </span>
      <p className="sidebar-empty-title">{t("emptyWorkspace.title")}</p>
      <p className="sidebar-empty-body">
        <Trans
          t={t}
          i18nKey="emptyWorkspace.body"
          components={{ code: <code /> }}
        />
      </p>
      <button className="btn-primary sidebar-empty-action" onClick={handleOpen}>
        {t("emptyWorkspace.openFolder")}
      </button>
    </div>
  );
}
