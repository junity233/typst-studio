import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { usePackagesStore } from "../../../store/packagesStore";
import { useWorkspaceStore } from "../../../store/workspaceStore";
import {
  packageGetReadme,
  packageImportSnippet,
  packageInitTemplate,
  openFileByPath,
  openWorkspaceByPath,
} from "../../../lib/tauri";
import { toIpcError } from "../../../lib/ipc-error";
import { Thumbnail } from "./Thumbnail";

export function PackageDetail() {
  const { t } = useTranslation("packages");
  const selectedKey = usePackagesStore((s) => s.selectedKey);
  const catalog = usePackagesStore((s) => s.catalog);
  const setSelected = usePackagesStore((s) => s.setSelected);
  const install = usePackagesStore((s) => s.install);
  const hydrate = useWorkspaceStore((s) => s.hydrate);
  const [readme, setReadme] = useState<string | null>(null);

  const entry = useMemo(
    () => catalog.find((e) => `${e.name}@${e.version}` === selectedKey) ?? null,
    [catalog, selectedKey],
  );

  useEffect(() => {
    setReadme(null);
    if (!entry) return;
    void packageGetReadme(entry.name, entry.version).then(setReadme);
  }, [entry]);

  if (!entry) {
    return (
      <div className="pkg-detail">
        <button className="pkg-back" onClick={() => setSelected(null)}>
          ‹ {t("back")}
        </button>
        <p className="packages-empty">{t("notFound")}</p>
      </div>
    );
  }

  const isTemplate = entry.template != null;
  const importText = packageImportSnippet(entry.name, entry.version);

  const applyTemplate = async () => {
    const dest = await openDialog({ directory: true, multiple: false });
    if (!dest || Array.isArray(dest)) return;
    const destStr = String(dest);
    try {
      const entrypoint = await packageInitTemplate(entry.name, entry.version, destStr);
      // Open the freshly-populated folder as the workspace. The workspace store
      // has no `openWorkspaceByPath` method, so drive the backend directly and
      // then re-hydrate the store (getWorkspace now returns the new meta).
      await openWorkspaceByPath(destStr);
      await hydrate();
      await openFileByPath(`${destStr}/${entrypoint}`);
    } catch (e) {
      alert(toIpcError(e).message);
    }
  };

  return (
    <div className="pkg-detail">
      <button className="pkg-back" onClick={() => setSelected(null)}>
        ‹ {t("back")}
      </button>
      {isTemplate && (
        <Thumbnail name={entry.name} version={entry.version} isTemplate={isTemplate} />
      )}
      <h2 className="pkg-detail-name">{entry.name}</h2>
      <p className="pkg-detail-desc">{entry.description ?? ""}</p>
      <dl className="pkg-detail-meta">
        <dt>{t("version")}</dt>
        <dd>{entry.version}</dd>
        {entry.compiler && (
          <>
            <dt>{t("requires")}</dt>
            <dd>Typst {entry.compiler}</dd>
          </>
        )}
        {entry.license && (
          <>
            <dt>{t("license")}</dt>
            <dd>{entry.license}</dd>
          </>
        )}
      </dl>
      {readme && <pre className="pkg-readme">{readme}</pre>}
      <div className="pkg-detail-actions">
        {isTemplate && (
          <button className="pkg-btn-primary" onClick={applyTemplate}>
            {t("useTemplate")}
          </button>
        )}
        <button
          className={isTemplate ? "pkg-btn-secondary" : "pkg-btn-primary"}
          onClick={() => install(entry.name, entry.version)}
        >
          {t("install")}
        </button>
        <button
          className="pkg-btn-secondary"
          onClick={() => navigator.clipboard.writeText(importText)}
          title={importText}
        >
          {t("copyImport")}
        </button>
      </div>
    </div>
  );
}
