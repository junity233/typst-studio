import { useTranslation } from "react-i18next";
import { confirmAction } from "../../../store/dialogStore";
import { usePackagesStore } from "../../../store/packagesStore";
import i18n from "../../../i18n";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function InstalledList() {
  const { t } = useTranslation("packages");
  const installed = usePackagesStore((s) => s.installed);
  const uninstall = usePackagesStore((s) => s.uninstall);
  const loadInstalled = usePackagesStore((s) => s.loadInstalled);

  if (installed.length === 0) {
    return <p className="packages-empty">{t("installedEmpty")}</p>;
  }

  return (
    <ul className="pkg-installed">
      {installed.map((p) => (
        <li key={`${p.name}@${p.version}`} className="pkg-installed-row">
          <div className="pkg-installed-main">
            <span className="pkg-row-name">{p.name}</span>
            <span className="pkg-row-ver">{p.version}</span>
            <span className="pkg-row-size">{formatBytes(p.sizeBytes)}</span>
          </div>
          <div className="pkg-installed-actions">
            <button
              className="pkg-action-btn"
              onClick={async () => {
                // Styled ConfirmDialog, not native confirm — window.confirm
                // is dead in the macOS WKWebView (see Explorer.tsx).
                const ok = await confirmAction({
                  title: `${p.name} ${p.version}`,
                  message: t("confirmUninstall", { name: p.name, version: p.version }),
                  confirmLabel: t("uninstall"),
                  cancelLabel: i18n.t("cancel", { ns: "common" }),
                  // Uninstalling deletes from the local cache — start focused
                  // on Cancel so a stray Enter cannot confirm.
                  danger: true,
                });
                if (!ok) return;
                if (await uninstall(p.name, p.version)) await loadInstalled();
              }}
            >
              {t("uninstall")}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
