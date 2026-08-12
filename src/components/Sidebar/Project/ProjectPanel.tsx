import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Save, Trash2, StarOff } from "lucide-react";
import { useProjectConfigStore } from "../../../store/projectConfigStore";
import { useWorkspaceStore } from "../../../store/workspaceStore";
import { useUiStore } from "../../../store/uiStore";
import { useDialogStore } from "../../../store/dialogStore";
import { packageCompilerVersion } from "../../../lib/tauri";
import type { ProjectConfig } from "../../../lib/types";

/** The editable form shape. List fields are comma-separated strings for input. */
interface Form {
  main: string;
  title: string;
  template: string;
  typstVersion: string;
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
  template: "",
  typstVersion: "",
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
    template: cfg.template ?? "",
    typstVersion: cfg.typstVersion ?? "",
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
    template: form.template || null,
    typstVersion: form.typstVersion || null,
    bibliography: parseList(form.bibliography),
    newFileTemplate: form.newFileTemplate || null,
    exclude: parseList(form.exclude),
    compile,
    export: exportCfg,
  };
}

/** Compare two "M.m.p" version strings; returns >0 if a is newer, 0 equal, <0 older. NaN-safe. */
function compareVersion(a: string, b: string): number {
  const pa = a.trim().split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.trim().split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
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
  const [embeddedVersion, setEmbeddedVersion] = useState<string | null>(null);

  const formRef = useRef(form);
  formRef.current = form;
  const prevFormRef = useRef<Form>(form);

  // Fetch the embedded Typst version once for the drift hint.
  useEffect(() => {
    void packageCompilerVersion()
      .then(setEmbeddedVersion)
      .catch(() => setEmbeddedVersion(null));
  }, []);

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

  // Typst version drift hint.
  let versionHint: { key: string; opts?: Record<string, string> } | null = null;
  if (form.typstVersion.trim() && embeddedVersion) {
    const cmp = compareVersion(form.typstVersion, embeddedVersion);
    const opts = { project: form.typstVersion.trim(), embedded: embeddedVersion };
    versionHint =
      cmp > 0
        ? { key: "typstVersionAhead", opts }
        : cmp < 0
          ? { key: "typstVersionDrift", opts }
          : { key: "typstVersionUpToDate", opts };
  }

  return (
    <div className="project-panel">
      <div className="project-section">{t("generalSection")}</div>

      <div className="project-field">
        <label className="project-label" htmlFor="project-main-file">
          {t("mainFile")}
        </label>
        <select id="project-main-file" className="project-select" value={form.main} onChange={set("main")}>
          <option value="">{t("mainFileNone")}</option>
          {typFiles.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        {typFiles.length === 0 && <p className="project-hint">{t("mainFileEmpty")}</p>}
        {mainMissing && <p className="project-hint warn">{t("mainFileMissing")}</p>}
      </div>

      <div className="project-field">
        <label className="project-label" htmlFor="project-title">
          {t("projectTitle")}
        </label>
        <input
          id="project-title"
          className="project-input"
          type="text"
          value={form.title}
          placeholder={t("projectTitlePlaceholder")}
          onChange={set("title")}
        />
      </div>

      <div className="project-field">
        <label className="project-label" htmlFor="project-template">
          {t("template")}
        </label>
        <input
          id="project-template"
          className="project-input"
          type="text"
          value={form.template}
          placeholder={t("templatePlaceholder")}
          onChange={set("template")}
        />
      </div>

      <div className="project-field">
        <label className="project-label" htmlFor="project-typst-version">
          {t("typstVersion")}
        </label>
        <input
          id="project-typst-version"
          className="project-input"
          type="text"
          value={form.typstVersion}
          placeholder={t("typstVersionPlaceholder")}
          onChange={set("typstVersion")}
        />
        {versionHint && (
          <p className={`project-hint${versionHint.key === "typstVersionAhead" ? " warn" : ""}`}>
            {t(versionHint.key, versionHint.opts)}
          </p>
        )}
      </div>

      <div className="project-field">
        <label className="project-label" htmlFor="project-bib">
          {t("bibliography")}
        </label>
        <input
          id="project-bib"
          className="project-input"
          type="text"
          value={form.bibliography}
          placeholder="refs.bib, extra.yml"
          onChange={set("bibliography")}
        />
        <p className="project-hint">{t("bibliographyHint")}</p>
      </div>

      <div className="project-section">{t("compileSection")}</div>

      <div className="project-field">
        <label className="project-label" htmlFor="project-compile-root">
          {t("compileRoot")}
        </label>
        <input
          id="project-compile-root"
          className="project-input"
          type="text"
          value={form.compileRoot}
          placeholder="src"
          onChange={set("compileRoot")}
        />
        <p className="project-hint">{t("compileRootHint")}</p>
      </div>

      <div className="project-field">
        <label className="project-label" htmlFor="project-font-dirs">
          {t("extraFontDirs")}
        </label>
        <input
          id="project-font-dirs"
          className="project-input"
          type="text"
          value={form.extraFontDirs}
          placeholder="fonts, vendor/fonts"
          onChange={set("extraFontDirs")}
        />
        <p className="project-hint">
          {t("extraFontDirsHint")} · <em>{t("restartRequired")}</em>
        </p>
      </div>

      <div className="project-section">{t("exportSection")}</div>

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

      {/* New file template + exclude */}
      <div className="project-field">
        <label className="project-label" htmlFor="project-new-file-template">
          {t("newFileTemplate")}
        </label>
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

      {/* Save row */}
      <div className="project-actions">
        <button
          type="button"
          className="project-btn primary"
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
        >
          <Save size={14} />
          {savedFlash ? t("saved") : t("save")}
        </button>
        {storedMain && (
          <button type="button" className="project-btn" onClick={() => void handleClearMain()} title={t("clearMainFile")}>
            <StarOff size={14} />
            {t("clearMainFile")}
          </button>
        )}
      </div>

      {/* Preview mode (UI pref; only meaningful with a main file) */}
      <div className="project-field">
        <span className="project-label">{t("previewMode")}</span>
        <div className="project-radio-group">
          <label className="project-radio">
            <input
              type="radio"
              name="project-preview-mode"
              checked={projectPreview}
              onChange={() => setProjectPreview(true)}
              disabled={!storedMain}
            />
            {t("previewMain")}
          </label>
          <label className="project-radio">
            <input
              type="radio"
              name="project-preview-mode"
              checked={!projectPreview}
              onChange={() => setProjectPreview(false)}
              disabled={!storedMain}
            />
            {t("previewActive")}
          </label>
        </div>
        <p className="project-hint">{t("previewMainHint")}</p>
      </div>

      {/* Status row */}
      <div className="project-status">
        <span className="project-status-label">{t("configPath")}</span>
        <code className="project-status-path" title={configPath ?? undefined}>
          {configPath ?? t("noConfig")}
        </code>
      </div>

      {config && (
        <button type="button" className="project-btn danger" onClick={() => void handleDelete()}>
          <Trash2 size={14} />
          {t("deleteConfig")}
        </button>
      )}
    </div>
  );
}
