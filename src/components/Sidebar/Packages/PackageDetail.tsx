import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { usePackagesStore } from "../../../store/packagesStore";
import { useWorkspaceStore } from "../../../store/workspaceStore";
import {
  packageCompilerVersion,
  packageGetReadme,
  packageImportSnippet,
  packageInitTemplate,
  openFileByPath,
  openWorkspaceByPath,
} from "../../../lib/tauri";
import { toIpcError } from "../../../lib/ipc-error";
import { Thumbnail } from "./Thumbnail";

/** Parse "major.minor.patch" → [major,minor,patch] (best-effort). */
function parseVer(s: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function PackageDetail() {
  const { t } = useTranslation("packages");
  const selectedKey = usePackagesStore((s) => s.selectedKey);
  const catalog = usePackagesStore((s) => s.catalog);
  const setSelected = usePackagesStore((s) => s.setSelected);
  const install = usePackagesStore((s) => s.install);
  const hydrate = useWorkspaceStore((s) => s.hydrate);
  const [readme, setReadme] = useState<string | null>(null);
  const [compilerVersion, setCompilerVersion] = useState<string | null>(null);

  const entry = useMemo(
    () => catalog.find((e) => `${e.name}@${e.version}` === selectedKey) ?? null,
    [catalog, selectedKey],
  );

  useEffect(() => {
    setReadme(null);
    if (!entry) return;
    void packageGetReadme(entry.name, entry.version).then(setReadme);
  }, [entry]);

  // Fetch the embedded compiler version once for the compat warning (§4.3).
  useEffect(() => {
    void packageCompilerVersion().then(setCompilerVersion);
  }, []);

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

  // Compat warning: the package requires a newer compiler than we embed (§4.3).
  const compatWarn =
    entry.compiler && compilerVersion
      ? (() => {
          const req = parseVer(entry.compiler);
          const cur = parseVer(compilerVersion);
          if (!req || !cur) return false;
          return (
            req[0] > cur[0] ||
            (req[0] === cur[0] && req[1] > cur[1]) ||
            (req[0] === cur[0] && req[1] === cur[1] && req[2] > cur[2])
          );
        })()
      : false;

  const applyTemplate = async () => {
    const dest = await openDialog({
      directory: true,
      multiple: false,
      title: t("pickTemplateDir"),
    });
    if (!dest || Array.isArray(dest)) return;
    const destStr = String(dest);
    // §4.1: if the chosen folder is non-empty, confirm before proceeding — the
    // backend aborts on the first existing-file conflict, so a pre-confirm
    // avoids a partial-copy cleanup modal.
    let isEmpty = true;
    try {
      const entries = await (await import("@tauri-apps/plugin-fs")).readDir(destStr);
      isEmpty = entries.length === 0;
    } catch {
      // If we can't read the dir, proceed and let the backend surface the error.
    }
    if (!isEmpty) {
      if (!confirm(t("confirmNonEmptyDest"))) return;
    }
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
            <dd>
              Typst {entry.compiler}
              {compatWarn && compilerVersion && (
                <span
                  className="pkg-compat-warn"
                  title={t("compatWarn", { required: entry.compiler, actual: compilerVersion })}
                >
                  {" "}⚠
                </span>
              )}
            </dd>
          </>
        )}
        {entry.license && (
          <>
            <dt>{t("license")}</dt>
            <dd>{entry.license}</dd>
          </>
        )}
      </dl>
      {compatWarn && compilerVersion && (
        <p className="pkg-compat-line">
          ⚠ {t("compatWarn", { required: entry.compiler, actual: compilerVersion })}
        </p>
      )}
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
