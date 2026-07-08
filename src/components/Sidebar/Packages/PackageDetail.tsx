import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { usePackagesStore } from "../../../store/packagesStore";
import { useWorkspaceStore } from "../../../store/workspaceStore";
import { useUiStore } from "../../../store/uiStore";
import { openFile } from "../../../lib/openFile";
import {
  packageCompilerVersion,
  packageDirIsEmpty,
  packageImportSnippet,
  packageInitTemplate,
  openWorkspaceByPath,
} from "../../../lib/tauri";
import { toIpcError } from "../../../lib/ipc-error";
import i18n from "../../../i18n";
import { Thumbnail } from "./Thumbnail";
import { PackageReadme } from "./PackageReadme";

/** Parse "major.minor.patch" → [major,minor,patch] (best-effort). */
function parseVer(s: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function PackageDetail() {
  const { t } = useTranslation("packages");
  const selectedKey = usePackagesStore((s) => s.selectedKey);
  const index = usePackagesStore((s) => s.index);
  const setSelected = usePackagesStore((s) => s.setSelected);
  const install = usePackagesStore((s) => s.install);
  const installed = usePackagesStore((s) => s.installed);
  const installing = usePackagesStore((s) => s.installing);
  const hydrate = useWorkspaceStore((s) => s.hydrate);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const [compilerVersion, setCompilerVersion] = useState<string | null>(null);

  // Look up the selected entry in the FULL (unfiltered) index so the detail
  // view stays valid even if the user changes the search/category filter.
  const entry = useMemo(
    () => index.find((e) => `${e.name}@${e.version}` === selectedKey) ?? null,
    [index, selectedKey],
  );

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

  /** Run the full "init → open workspace → open entrypoint" sequence for the
   *  chosen destination, with a given overwrite flag. Throws on any error. */
  const runInit = async (destStr: string, overwrite: boolean) => {
    const entrypoint = await packageInitTemplate(entry.name, entry.version, destStr, overwrite);
    // Open the freshly-populated folder as the workspace. The workspace store
    // has no `openWorkspaceByPath` method, so drive the backend directly and
    // then re-hydrate the store (getWorkspace now returns the new meta).
    await openWorkspaceByPath(destStr);
    await hydrate();
    // Auto-open the template entrypoint (e.g. main.typ) so the user lands on
    // a compilable document. Use the platform path joiner so the separator is
    // correct on Windows (backslash).
    const entryAbs = await join(destStr, entrypoint);
    await openFile(entryAbs);
    // Switch to the Explorer so the user sees their new project's file tree.
    setActiveView("workbench.explorer");
  };

  const applyTemplate = async () => {
    const dest = await openDialog({
      directory: true,
      multiple: false,
      title: t("pickTemplateDir"),
    });
    if (!dest || Array.isArray(dest)) return;
    const destStr = String(dest);
    try {
      const isEmpty = await packageDirIsEmpty(destStr);
      if (!isEmpty && !confirm(t("confirmOverwrite"))) {
        return;
      }
      await runInit(destStr, !isEmpty);
    } catch (e) {
      const ipc = toIpcError(e);
      if (ipc.code === "template_init_failed") {
        const openDocs = extractOpenDocs(ipc.details);
        if (openDocs.length > 0) {
          alert(
            i18n.t("templateInitBlockedByOpenDocs", {
              ns: "errors",
              names: openDocs.join("\n"),
            }),
          );
          return;
        }
        // Confirm before overwriting existing files at the destination.
        if (confirm(t("confirmOverwrite"))) {
          try {
            await runInit(destStr, true);
          } catch (e2) {
            alert(
              i18n.t("templateInitFailed", {
                ns: "errors",
                message: toIpcError(e2).message,
              }),
            );
          }
        }
      } else {
        alert(
          i18n.t("templateInitFailed", {
            ns: "errors",
            message: ipc.message,
          }),
        );
      }
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
      <PackageReadme name={entry.name} version={entry.version} />
      <div className="pkg-detail-actions">
        {isTemplate && (
          <button className="pkg-btn-primary" onClick={applyTemplate}>
            {t("useTemplate")}
          </button>
        )}
        {(() => {
          const key = `${entry.name}@${entry.version}`;
          const isInstalled = installed.some(
            (p) => p.name === entry.name && p.version === entry.version,
          );
          const isInstalling = !!installing[key];
          return (
            <button
              className={isTemplate ? "pkg-btn-secondary" : "pkg-btn-primary"}
              disabled={isInstalled || isInstalling}
              onClick={async () => {
                const ok = await install(entry.name, entry.version);
                if (!ok) alert(t("installFailed"));
              }}
            >
              {isInstalled
                ? t("installed")
                : isInstalling
                  ? t("installing")
                  : t("install")}
            </button>
          );
        })()}
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

function extractOpenDocs(details: unknown): string[] {
  if (typeof details !== "object" || details === null) return [];
  const openDocs = (details as { openDocs?: unknown }).openDocs;
  if (!Array.isArray(openDocs)) return [];
  return openDocs
    .map((doc) =>
      typeof doc === "object" && doc !== null
        ? (doc as { path?: unknown }).path
        : null,
    )
    .filter((path): path is string => typeof path === "string");
}
