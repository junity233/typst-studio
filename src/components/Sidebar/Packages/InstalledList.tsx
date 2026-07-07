import { useTranslation } from "react-i18next";
import { usePackagesStore } from "../../../store/packagesStore";

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
                if (!confirm(t("confirmUninstall", { name: p.name, version: p.version }))) return;
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
