import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Save, Trash2, StarOff, FolderOpen, FileText } from "lucide-react";
import { useProjectConfigStore } from "../../../store/projectConfigStore";
import { useWorkspaceStore } from "../../../store/workspaceStore";
import { useUiStore } from "../../../store/uiStore";
import { useDialogStore } from "../../../store/dialogStore";
import { pickPath } from "../../../lib/tauri";
import { relativeWithinWorkspace } from "../../../lib/workspacePath";
import type { ProjectConfig } from "../../../lib/types";

/** The editable form shape. List fields are comma-separated strings for input. */
interface Form {
  main: string;
  title: string;
  bibliography: string;
  newFileTemplate: string;
  exclude: string;
  compileRoot: string;
  extraFontDirs: string;
  exportFormat: string; // "" | pdf | png | svg
  exportPath: string;
}

const EMPTY_FORM: Form = {
  main: "",
  title: "",
  bibliography: "",
  newFileTemplate: "",
  exclude: "",
  compileRoot: "",
  extraFontDirs: "",
  exportFormat: "",
  exportPath: "",
};

function parseList(s: string): string[] {
  return s
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Derive the form fields from a (possibly null) config. */
function configToForm(cfg: ProjectConfig | null): Form {
  if (!cfg) return { ...EMPTY_FORM };
  return {
    main: cfg.main ?? "",
    title: cfg.title ?? "",
    bibliography: (cfg.bibliography ?? []).join(", "),
    newFileTemplate: cfg.newFileTemplate ?? "",
    exclude: (cfg.exclude ?? []).join(", "),
    compileRoot: cfg.compile?.root ?? "",
    extraFontDirs: (cfg.compile?.extraFontDirs ?? []).join(", "),
    exportFormat: cfg.export?.format ?? "",
    exportPath: cfg.export?.outputPath ?? "",
  };
}

/** Build a config patch (only non-empty / changed fields) from the form. */
function formToConfig(form: Form): ProjectConfig {
  const compile =
    form.compileRoot !== "" || form.extraFontDirs !== ""
      ? {
          root: form.compileRoot || null,
          extraFontDirs: parseList(form.extraFontDirs),
        }
      : null;
  const exportCfg =
    form.exportFormat !== "" || form.exportPath !== ""
      ? {
          format: form.exportFormat || null,
          outputPath: form.exportPath || null,
        }
      : null;
  return {
    schemaVersion: 2,
    main: form.main || null,
    title: form.title || null,
    bibliography: parseList(form.bibliography),
    newFileTemplate: form.newFileTemplate || null,
    exclude: parseList(form.exclude),
    compile,
    export: exportCfg,
  };
}

/** Append `rel` to a comma-separated list string, deduping + trimming. */
function appendRel(list: string, rel: string): string {
  const items = parseList(list);
  if (items.includes(rel)) return list;
  return [...items, rel].join(", ");
}

/**
 * The Project sidebar view: edits the workspace's `.typstpro`. Every field is
 * optional; the panel writes the whole config on Save (live-apply — the
 * backend validates + broadcasts `project_config_changed`, which re-syncs the
 * form without clobbering fields the user is still editing).
 */
export function ProjectPanel() {
  const { t } = useTranslation("project");
  const rootPath = useWorkspaceStore((s) => s.rootPath);

  const config = useProjectConfigStore((s) => s.config);
  const typFiles = useProjectConfigStore((s) => s.typFiles);
  const configPath = useProjectConfigStore((s) => s.configPath);
  const update = useProjectConfigStore((s) => s.update);
  const setMainFile = useProjectConfigStore((s) => s.setMainFile);
  const clear = useProjectConfigStore((s) => s.clear);

  const projectPreview = useUiStore((s) => s.projectPreview);
  const setProjectPreview = useUiStore((s) => s.setProjectPreview);

  const [form, setForm] = useState<Form>(() => configToForm(config));
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [browseWarning, setBrowseWarning] = useState<string | null>(null);

  const formRef = useRef(form);
  formRef.current = form;
  const prevFormRef = useRef<Form>(form);

  // Sync the form when the backend-broadcast config changes, WITHOUT clobbering
  // a field the user is actively editing. For each field, adopt the incoming
  // value only when the local value still equals the previous config's value.
  useEffect(() => {
    const prev = prevFormRef.current;
    const incoming = configToForm(config);
    setForm((cur) => {
      const next = { ...cur };
      (Object.keys(incoming) as (keyof Form)[]).forEach((k) => {
        if (cur[k] === prev[k]) next[k] = incoming[k];
      });
      return next;
    });
    prevFormRef.current = incoming;
  }, [config]);

  if (rootPath === null) {
    return <div className="project-panel empty">{t("noWorkspace")}</div>;
  }

  const dirty = Object.keys(form).some(
    (k) => form[k as keyof Form] !== configToForm(config)[k as keyof Form],
  );
  const storedMain = config?.main ?? "";
  const mainMissing = storedMain !== "" && !typFiles.includes(storedMain);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  // Open a native file/folder picker, convert the absolute result back to a
  // workspace-relative path (the backend rejects absolute paths for `.typstpro`),
  // and hand it to `apply`. A pick outside the workspace is rejected with an
  // inline warning rather than silently dropped.
  const browse = async (
    kind: "file" | "folder",
    apply: (rel: string) => void,
  ) => {
    if (rootPath === null) return;
    const abs = await pickPath(kind).catch((e) => {
      console.warn("[project] path picker failed:", e);
      return null;
    });
    if (abs === null) return;
    const rel = relativeWithinWorkspace(rootPath, abs);
    if (rel === null) {
      setBrowseWarning(t("pathOutsideWorkspace"));
      return;
    }
    setBrowseWarning(null);
    apply(rel);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await update(formToConfig(form));
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1200);
    } catch (e) {
      console.error("[project] save failed:", e);
    } finally {
      setSaving(false);
    }
  };

  const handleClearMain = async () => {
    const result = await useDialogStore.getState().confirm({
      title: t("confirmClearMainTitle"),
      message: t("confirmClearMainMessage"),
      confirmLabel: t("clearMainFile"),
    });
    if (result !== "confirm") return;
    setForm((f) => ({ ...f, main: "" }));
    try {
      await setMainFile(null);
    } catch (e) {
      console.error("[project] clear main failed:", e);
    }
  };

  const handleDelete = async () => {
    const result = await useDialogStore.getState().confirm({
      title: t("confirmDeleteTitle"),
      message: t("confirmDeleteMessage"),
      confirmLabel: t("deleteConfig"),
    });
    if (result !== "confirm") return;
    try {
      await clear();
    } catch (e) {
      console.error("[project] delete failed:", e);
    }
  };

  return (
    <div className="project-panel">
      {/* Header: the project name as a hero title, not a buried field. */}
      <header className="project-header">
        <label className="project-header-label" htmlFor="project-title">
          {t("projectTitle")}
        </label>
        <input
          id="project-title"
          className="project-title-input"
          type="text"
          value={form.title}
          placeholder={t("projectTitlePlaceholder")}
          onChange={set("title")}
        />
      </header>

      <div className="project-scroll">
        {/* Inline "outside workspace" warning after a failed pick. */}
        {browseWarning && <p className="project-warning">{browseWarning}</p>}

        {/* General */}
        <section className="project-card">
          <h3 className="project-card-title">{t("generalSection")}</h3>

          <div className="project-field">
            <label className="project-label" htmlFor="project-main-file">
              {t("mainFile")}
            </label>
            <div className="project-path-row">
              <select id="project-main-file" className="project-select" value={form.main} onChange={set("main")}>
                <option value="">{t("mainFileNone")}</option>
                {typFiles.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="project-browse"
                title={t("browseFile")}
                aria-label={t("browseFile")}
                onClick={() => void browse("file", (rel) => setForm((f) => ({ ...f, main: rel })))}
              >
                <FileText size={15} />
              </button>
            </div>
            {typFiles.length === 0 && <p className="project-hint">{t("mainFileEmpty")}</p>}
            {mainMissing && <p className="project-hint warn">{t("mainFileMissing")}</p>}
          </div>

          <div className="project-field">
            <label className="project-label" htmlFor="project-bib">
              {t("bibliography")}
            </label>
            <div className="project-path-row">
              <input
                id="project-bib"
                className="project-input"
                type="text"
                value={form.bibliography}
                placeholder="refs.bib, extra.yml"
                onChange={set("bibliography")}
              />
              <button
                type="button"
                className="project-browse"
                title={t("browseFile")}
                aria-label={t("browseFile")}
                onClick={() => void browse("file", (rel) => setForm((f) => ({ ...f, bibliography: appendRel(f.bibliography, rel) })))}
              >
                <FileText size={15} />
              </button>
            </div>
            <p className="project-hint">{t("bibliographyHint")}</p>
          </div>
        </section>

        {/* Compile */}
        <section className="project-card">
          <h3 className="project-card-title">{t("compileSection")}</h3>

          <div className="project-field">
            <label className="project-label" htmlFor="project-compile-root">
              {t("compileRoot")}
            </label>
            <div className="project-path-row">
              <input
                id="project-compile-root"
                className="project-input"
                type="text"
                value={form.compileRoot}
                placeholder="src"
                onChange={set("compileRoot")}
              />
              <button
                type="button"
                className="project-browse"
                title={t("browseFolder")}
                aria-label={t("browseFolder")}
                onClick={() => void browse("folder", (rel) => setForm((f) => ({ ...f, compileRoot: rel })))}
              >
                <FolderOpen size={15} />
              </button>
            </div>
            <p className="project-hint">{t("compileRootHint")}</p>
          </div>

          <div className="project-field">
            <label className="project-label" htmlFor="project-font-dirs">
              {t("extraFontDirs")}
            </label>
            <div className="project-path-row">
              <input
                id="project-font-dirs"
                className="project-input"
                type="text"
                value={form.extraFontDirs}
                placeholder="fonts, vendor/fonts"
                onChange={set("extraFontDirs")}
              />
              <button
                type="button"
                className="project-browse"
                title={t("browseFolder")}
                aria-label={t("browseFolder")}
                onClick={() => void browse("folder", (rel) => setForm((f) => ({ ...f, extraFontDirs: appendRel(f.extraFontDirs, rel) })))}
              >
                <FolderOpen size={15} />
              </button>
            </div>
            <span className="project-pill">{t("restartRequired")}</span>
            <p className="project-hint">{t("extraFontDirsHint")}</p>
          </div>
        </section>

        {/* Export */}
        <section className="project-card">
          <h3 className="project-card-title">{t("exportSection")}</h3>

          <div className="project-field">
            <label className="project-label" htmlFor="project-export-format">
              {t("exportFormat")}
            </label>
            <select
              id="project-export-format"
              className="project-select"
              value={form.exportFormat}
              onChange={set("exportFormat")}
            >
              <option value="">{t("exportFormatNone")}</option>
              <option value="pdf">PDF</option>
              <option value="png">PNG</option>
              <option value="svg">SVG</option>
            </select>
          </div>

          <div className="project-field">
            <label className="project-label" htmlFor="project-export-path">
              {t("exportPath")}
            </label>
            <input
              id="project-export-path"
              className="project-input"
              type="text"
              value={form.exportPath}
              placeholder="build/${title}.pdf"
              onChange={set("exportPath")}
            />
            <p className="project-hint">{t("exportPathHint")}</p>
          </div>
        </section>

        {/* Workspace */}
        <section className="project-card">
          <h3 className="project-card-title">{t("workspaceSection")}</h3>

          <div className="project-field">
            <label className="project-label" htmlFor="project-new-file-template">
              {t("newFileTemplate")}
            </label>
            <div className="project-path-row">
              <select
                id="project-new-file-template"
                className="project-select"
                value={form.newFileTemplate}
                onChange={set("newFileTemplate")}
              >
                <option value="">{t("newFileTemplateNone")}</option>
                {typFiles.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="project-browse"
                title={t("browseFile")}
                aria-label={t("browseFile")}
                onClick={() => void browse("file", (rel) => setForm((f) => ({ ...f, newFileTemplate: rel })))}
              >
                <FileText size={15} />
              </button>
            </div>
          </div>

          <div className="project-field">
            <label className="project-label" htmlFor="project-exclude">
              {t("exclude")}
            </label>
            <input
              id="project-exclude"
              className="project-input"
              type="text"
              value={form.exclude}
              placeholder="build/**, out/**"
              onChange={set("exclude")}
            />
            <p className="project-hint">{t("excludeHint")}</p>
          </div>
        </section>

        {/* Preview mode */}
        <section className="project-card">
          <h3 className="project-card-title">{t("previewMode")}</h3>
          <div className="project-segmented" role="tablist" aria-label={t("previewMode")}>
            <button
              type="button"
              className={`project-segmented-btn${projectPreview ? " active" : ""}`}
              role="tab"
              aria-selected={projectPreview}
              disabled={!storedMain}
              onClick={() => setProjectPreview(true)}
            >
              {t("previewMain")}
            </button>
            <button
              type="button"
              className={`project-segmented-btn${!projectPreview ? " active" : ""}`}
              role="tab"
              aria-selected={!projectPreview}
              disabled={!storedMain}
              onClick={() => setProjectPreview(false)}
            >
              {t("previewActive")}
            </button>
          </div>
          <p className="project-hint">{t("previewMainHint")}</p>
        </section>
      </div>

      {/* Footer: config path + pinned actions. */}
      <footer className="project-footer">
        <div className="project-status">
          <span className="project-status-label">{t("configPath")}</span>
          <code className="project-status-path" title={configPath ?? undefined}>
            {configPath ?? t("noConfig")}
          </code>
        </div>
        <div className="project-footer-actions">
          <button
            type="button"
            className="project-save"
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
          >
            <Save size={14} />
            {savedFlash ? t("saved") : t("save")}
          </button>
          {storedMain && (
            <button
              type="button"
              className="project-icon-btn"
              onClick={() => void handleClearMain()}
              title={t("clearMainFile")}
              aria-label={t("clearMainFile")}
            >
              <StarOff size={16} />
            </button>
          )}
          {config && (
            <button
              type="button"
              className="project-icon-btn danger"
              onClick={() => void handleDelete()}
              title={t("deleteConfig")}
              aria-label={t("deleteConfig")}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
