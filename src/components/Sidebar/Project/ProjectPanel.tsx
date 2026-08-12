import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Save, Trash2, StarOff } from "lucide-react";
import { useProjectConfigStore } from "../../../store/projectConfigStore";
import { useWorkspaceStore } from "../../../store/workspaceStore";
import { useUiStore } from "../../../store/uiStore";
import { useDialogStore } from "../../../store/dialogStore";

/**
 * The Project sidebar view: edits the workspace's `.typstpro` (main compile
 * file + project title) and toggles project-preview mode.
 *
 * The store follows the live-apply pattern (no optimistic update): every change
 * round-trips through the backend, which validates + persists + broadcasts
 * `project_config_changed`. The form keeps local state for the two text inputs
 * and commits them together on Save; the preview-mode radio writes a UI pref
 * immediately (it is not part of `.typstpro`).
 *
 * Only shown when a folder is open (`when: "workspace"` in the extension).
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

  // Local form state. A backend broadcast (after Save / Clear / external edit /
  // multi-window change) replaces `config`, but we must NOT clobber a field the
  // user is actively editing: e.g. clearing the main file fires a broadcast that
  // must not discard an in-progress title edit. So we adopt an incoming value
  // for a field ONLY when the local value still equals the *previous* config
  // value (i.e. the user hasn't touched it since the last sync). Field values
  // are read via refs so the effect can depend on `config` alone (no stale
  // closure, no exhaustive-deps churn).
  const [main, setMain] = useState(config?.main ?? "");
  const [title, setTitle] = useState(config?.title ?? "");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const mainRef = useRef(main);
  mainRef.current = main;
  const titleRef = useRef(title);
  titleRef.current = title;
  const prevConfig = useRef(config);

  useEffect(() => {
    const prev = prevConfig.current;
    if (mainRef.current === (prev?.main ?? "")) setMain(config?.main ?? "");
    if (titleRef.current === (prev?.title ?? "")) setTitle(config?.title ?? "");
    prevConfig.current = config;
  }, [config]);

  // No workspace: the view is gated `when: "workspace"`, but guard defensively.
  if (rootPath === null) {
    return <div className="project-panel empty">{t("noWorkspace")}</div>;
  }

  const storedMain = config?.main ?? "";
  const storedTitle = config?.title ?? "";
  const dirty = main !== storedMain || title !== storedTitle;

  const mainMissing = storedMain !== "" && !typFiles.includes(storedMain);

  const handleSave = async () => {
    setSaving(true);
    try {
      await update({ main: main || null, title: title || null });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1200);
    } catch (e) {
      console.error("[project] save failed:", e);
    } finally {
      setSaving(false);
    }
  };

  const handleClearMain = async () => {
    setMain("");
    try {
      // Clearing main is a single-field change — apply immediately and keep the
      // rest of the config (title) intact.
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
      {/* Main compile file */}
      <div className="project-field">
        <label className="project-label" htmlFor="project-main-file">
          {t("mainFile")}
        </label>
        <select
          id="project-main-file"
          className="project-select"
          value={main}
          onChange={(e) => setMain(e.target.value)}
        >
          <option value="">{t("mainFileNone")}</option>
          {typFiles.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        {typFiles.length === 0 && (
          <p className="project-hint">{t("mainFileEmpty")}</p>
        )}
        {mainMissing && <p className="project-hint warn">{t("mainFileMissing")}</p>}
      </div>

      {/* Project title */}
      <div className="project-field">
        <label className="project-label" htmlFor="project-title">
          {t("projectTitle")}
        </label>
        <input
          id="project-title"
          className="project-input"
          type="text"
          value={title}
          placeholder={t("projectTitlePlaceholder")}
          onChange={(e) => setTitle(e.target.value)}
        />
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
          <button
            type="button"
            className="project-btn"
            onClick={() => void handleClearMain()}
            title={t("clearMainFile")}
          >
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
        <button
          type="button"
          className="project-btn danger"
          onClick={() => void handleDelete()}
        >
          <Trash2 size={14} />
          {t("deleteConfig")}
        </button>
      )}
    </div>
  );
}
