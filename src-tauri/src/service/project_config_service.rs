//! `ProjectConfigService` — workspace-scoped `.typstpro` config orchestration.
//!
//! Mirrors the [`SettingsService`](crate::settings::SettingsService) pattern:
//! runtime state behind a `parking_lot::RwLock`, persistence via the
//! [`persistence`] atomic-write helpers, and an `on_change` callback that
//! decouples broadcast (the IPC layer wires it to
//! `app.emit("project_config_changed", ..)`). Unlike settings, the config is
//! bound to the open workspace rather than the app config dir, so it is loaded
//! on workspace open and cleared on close.
//!
//! The on-disk format is TOML (see [`ProjectConfig`](crate::domain::project_config));
//! a missing or unreadable file degrades to `None` (logged, never panics) the
//! same way settings degrades to `{}`.

use std::path::{Path, PathBuf};

use parking_lot::RwLock;

use crate::domain::project_config::{
    validate_export_format, validate_workspace_relative_path, ProjectConfig,
    CURRENT_SCHEMA_VERSION,
};
use crate::error::{AppError, Result};
use crate::persistence;

/// The fixed filename of the project config at the workspace root.
pub const CONFIG_FILENAME: &str = ".typstpro";

/// Workspace-scoped project config store.
///
/// Holds `None` when no workspace is open or the workspace has no `.typstpro`.
/// All mutators take the workspace `root` explicitly (the service itself is
/// root-agnostic so it can follow a workspace switch without reConstruction).
pub struct ProjectConfigService {
    config: RwLock<Option<ProjectConfig>>,
    on_change: Box<dyn Fn(Option<ProjectConfig>) + Send + Sync>,
}

impl ProjectConfigService {
    /// Construct with no config loaded (the caller loads on workspace open).
    pub fn new(on_change: impl Fn(Option<ProjectConfig>) + Send + Sync + 'static) -> Self {
        Self {
            config: RwLock::new(None),
            on_change: Box::new(on_change),
        }
    }

    /// Load `<root>/.typstpro`, migrating + caching the result, then fire
    /// `on_change`. A missing or corrupt file clears the cache to `None` (and
    /// still fires `on_change`, so the frontend drops stale state). Returns the
    /// loaded config for the caller's convenience.
    pub fn load(&self, root: &Path) -> Option<ProjectConfig> {
        let loaded = read_and_parse(root);
        self.replace(loaded)
    }

    /// Read `<root>/.typstpro` WITHOUT caching or firing `on_change` — a pure
    /// peek used at workspace-open time to resolve `compile.root` BEFORE the
    /// resolver is built (see `WorkspaceService::open`).
    pub fn peek(root: &Path) -> Option<ProjectConfig> {
        read_and_parse(root)
    }

    /// The cached config (a clone), or `None`.
    pub fn get(&self) -> Option<ProjectConfig> {
        self.config.read().clone()
    }

    /// Validate, persist, cache, and broadcast a full config. `schema_version`
    /// is stamped to current before writing. All path-typed fields are
    /// validated to stay within the workspace. Returns the saved config.
    pub fn set(&self, root: &Path, mut cfg: ProjectConfig) -> Result<ProjectConfig> {
        validate_config_paths(&cfg)?;
        cfg.schema_version = CURRENT_SCHEMA_VERSION;
        write_config(root, &cfg)?;
        self.replace(Some(cfg.clone()));
        Ok(cfg)
    }

    /// Merge a new `main` path into the current config (or start a fresh one if
    /// none exists), then persist. `None` clears the main field (the rest of
    /// the config is preserved).
    pub fn set_main_file(&self, root: &Path, main: Option<String>) -> Result<ProjectConfig> {
        if let Some(m) = main.as_deref() {
            validate_workspace_relative_path(m, "main file path")?;
        }
        let mut cfg = self.get().unwrap_or_default();
        cfg.main = main;
        self.set(root, cfg)
    }

    /// Delete the `.typstpro` file (if present) and clear the cache. Idempotent
    /// — a missing file is success. Fires `on_change(None)`.
    pub fn clear(&self, root: &Path) -> Result<()> {
        let path = root.join(CONFIG_FILENAME);
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        self.replace(None);
        Ok(())
    }

    /// Drop the in-memory cache and broadcast `on_change(None)` WITHOUT touching
    /// disk. Used on workspace close / switch so the frontend clears its stale
    /// config but the `.typstpro` file is preserved.
    pub fn reset(&self) {
        self.replace(None);
    }

    /// Recursively enumerate `.typ` files under `root`, returning
    /// workspace-relative paths (forward slashes) sorted lexicographically.
    /// Hidden entries (leading `.`), `node_modules`, and `target` are always
    /// skipped; entries/dirs matching `exclude` (workspace-relative globs) are
    /// skipped too. Returns an empty vec when `root` is missing or unreadable.
    pub fn list_typ_files(root: &Path, exclude: Option<&globset::GlobSet>) -> Vec<String> {
        let mut out = Vec::new();
        walk_typ(root, root, exclude, &mut out);
        out.sort();
        out
    }

    /// Swap the cache + fire `on_change`, returning the new value.
    fn replace(&self, cfg: Option<ProjectConfig>) -> Option<ProjectConfig> {
        *self.config.write() = cfg.clone();
        (self.on_change)(cfg.clone());
        cfg
    }
}

/// Read `<root>/.typstpro`, parse, and migrate. Missing/unreadable/corrupt →
/// `None` with a warning (mirrors settings' degrade-gracefully contract).
fn read_and_parse(root: &Path) -> Option<ProjectConfig> {
    let path = root.join(CONFIG_FILENAME);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!(?path, error = %e, ".typstpro unreadable; ignoring");
            return None;
        }
    };
    match toml::from_str::<ProjectConfig>(&text) {
        Ok(mut cfg) => {
            if let Err(e) = ProjectConfig::migrator().migrate(
                &mut cfg,
                |c| c.schema_version,
                |c, v| c.schema_version = v,
            ) {
                tracing::warn!(?path, error = %e, ".typstpro migration failed; ignoring");
                return None;
            }
            // `.typstpro` is hand-editable and may come from an untrusted
            // workspace clone, so re-validate every path field here (set() only
            // guards user edits via the panel). Drop — don't honor — any field
            // that escapes the workspace, so peek/load/get never yield a path
            // that could read/write outside the root.
            sanitize_loaded_paths(&mut cfg);
            Some(cfg)
        }
        Err(e) => {
            tracing::warn!(?path, error = %e, ".typstpro parse failed; ignoring");
            None
        }
    }
}

/// Serialize `cfg` as pretty TOML and atomically write it to `<root>/.typstpro`.
fn write_config(root: &Path, cfg: &ProjectConfig) -> Result<()> {
    let bytes = toml::to_string_pretty(cfg)
        .map_err(|e| AppError::Other(format!("serialize .typstpro: {e}")))?
        .into_bytes();
    let path: PathBuf = root.join(CONFIG_FILENAME);
    persistence::write_bytes(&path, &bytes)
}

/// Validate every workspace-relative path field (and the `export.format`
/// enum) of `cfg`. Collects the first violation (the field that names it in
/// the error message).
fn validate_config_paths(cfg: &ProjectConfig) -> Result<()> {
    if let Some(main) = cfg.main.as_deref() {
        validate_workspace_relative_path(main, "main file path")?;
    }
    if let Some(bib) = cfg.bibliography.as_deref() {
        for e in bib {
            validate_workspace_relative_path(e, "bibliography entry")?;
        }
    }
    if let Some(t) = cfg.new_file_template.as_deref() {
        validate_workspace_relative_path(t, "newFileTemplate")?;
    }
    if let Some(compile) = cfg.compile.as_ref() {
        if let Some(root) = compile.root.as_deref() {
            validate_workspace_relative_path(root, "compile.root")?;
        }
        if let Some(dirs) = compile.extra_font_dirs.as_deref() {
            for d in dirs {
                validate_workspace_relative_path(d, "compile.extraFontDirs entry")?;
            }
        }
    }
    // export.format is an enum, not a path — a hand-typed "PDF " / "jpeg" has
    // no export command behind it, so reject it here (the panel path) with a
    // named error. Loaded configs tolerate it (frontend falls back to pdf).
    if let Some(export) = cfg.export.as_ref() {
        if let Some(format) = export.format.as_deref() {
            validate_export_format(format)?;
        }
    }
    Ok(())
}

/// True iff `value` is a workspace-relative path that stays under the root
/// (logs + returns false on a violation). Used by [`sanitize_loaded_paths`].
fn path_ok(field: &str, value: &str) -> bool {
    match validate_workspace_relative_path(value, field) {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!(
                field, value, error = %e,
                ".typstpro path escapes the workspace; ignoring this field"
            );
            false
        }
    }
}

/// Drop (set to `None`) any path field of a LOADED config that escapes the
/// workspace. The config is hand-editable / may come from an untrusted clone,
/// and `set()` only guards panel edits — so this is the trust boundary for
/// every path-typed field consumed downstream (main, bibliography[],
/// newFileTemplate, compile.root, compile.extraFontDirs[]). Non-path fields
/// (title, template, typstVersion, exclude globs, export) are left as-is.
fn sanitize_loaded_paths(cfg: &mut ProjectConfig) {
    if let Some(m) = cfg.main.take() {
        cfg.main = path_ok("main", &m).then_some(m);
    }
    if let Some(t) = cfg.new_file_template.take() {
        cfg.new_file_template = path_ok("newFileTemplate", &t).then_some(t);
    }
    if let Some(mut bib) = cfg.bibliography.take() {
        bib.retain(|e| path_ok("bibliography entry", e));
        cfg.bibliography = if bib.is_empty() { None } else { Some(bib) };
    }
    if let Some(mut c) = cfg.compile.take() {
        if let Some(root) = c.root.take() {
            c.root = path_ok("compile.root", &root).then_some(root);
        }
        if let Some(mut dirs) = c.extra_font_dirs.take() {
            dirs.retain(|d| path_ok("compile.extraFontDirs entry", d));
            c.extra_font_dirs = if dirs.is_empty() { None } else { Some(dirs) };
        }
        // Avoid re-serializing an all-empty `[compile]` table on the next save.
        cfg.compile = if c.root.is_none() && c.extra_font_dirs.is_none() {
            None
        } else {
            Some(c)
        };
    }
}

/// Build a `GlobSet` from the project's `exclude` patterns. Returns `None` when
/// there are no patterns or every pattern fails to compile. Match against
/// workspace-relative paths with forward slashes.
pub fn build_exclude_globset(exclude: Option<&[String]>) -> Option<globset::GlobSet> {
    let patterns = exclude?;
    let mut builder = globset::GlobSetBuilder::new();
    let mut added = 0;
    for p in patterns {
        match globset::GlobBuilder::new(p)
            .literal_separator(true)
            .build()
        {
            Ok(g) => {
                builder.add(g);
                added += 1;
            }
            Err(e) => tracing::warn!(pattern = %p, error = %e, "exclude glob failed to compile; skipping"),
        }
    }
    if added == 0 {
        return None;
    }
    builder.build().ok()
}

/// True if a directory at workspace-relative `rel` should be pruned. A dir
/// matches when the globset hits its own path OR a synthetic child path, so
/// patterns like `build`, `build/**`, and `build/*` all prune the subtree
/// (shared logic: [`crate::fs::search::path_excluded`]).
fn dir_excluded(exclude: &globset::GlobSet, rel: &str) -> bool {
    crate::fs::search::path_excluded(Some(exclude), rel, true)
}

/// Recursive `.typ` collector. `base` is the root used to compute the relative
/// path; `dir` is the current traversal position. `exclude` optionally prunes
/// dirs/files by workspace-relative glob.
fn walk_typ(base: &Path, dir: &Path, exclude: Option<&globset::GlobSet>, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // Skip hidden entries (`.git`, `.typstpro`, …), `node_modules`, and
        // `target` (aligned with fs::tree::IGNORED_DIRS).
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        let rel = path.strip_prefix(base).ok().map(|r| {
            // Forward-slash relative path for cross-platform wire + glob matching.
            r.to_string_lossy().replace('\\', "/")
        });
        if ft.is_dir() {
            if let Some(rel) = &rel {
                if let Some(gs) = exclude {
                    if dir_excluded(gs, rel) {
                        continue;
                    }
                }
            }
            walk_typ(base, &path, exclude, out);
        } else if ft.is_file() && name.ends_with(".typ") {
            if let Some(rel) = &rel {
                if let Some(gs) = exclude {
                    if gs.is_match(rel) {
                        continue;
                    }
                }
                out.push(rel.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    fn tmp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("typst-pro-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn capturing_service() -> (ProjectConfigService, Arc<StdMutex<Vec<Option<ProjectConfig>>>>) {
        let captured = Arc::new(StdMutex::new(Vec::new()));
        let c = Arc::clone(&captured);
        let svc = ProjectConfigService::new(move |cfg| c.lock().unwrap().push(cfg));
        (svc, captured)
    }

    #[test]
    fn load_missing_file_is_none() {
        let root = tmp_root();
        let (svc, cap) = capturing_service();
        assert!(svc.load(&root).is_none());
        // load still fires on_change(None) so the frontend clears stale state.
        assert_eq!(cap.lock().unwrap().len(), 1);
    }

    #[test]
    fn load_corrupt_file_is_none() {
        let root = tmp_root();
        std::fs::write(root.join(CONFIG_FILENAME), "this = not = toml").unwrap();
        let (svc, _cap) = capturing_service();
        assert!(svc.load(&root).is_none());
    }

    #[test]
    fn set_then_get_roundtrips_and_persists() {
        let root = tmp_root();
        let (svc, cap) = capturing_service();
        let cfg = svc
            .set(
                &root,
                ProjectConfig {
                    schema_version: 0, // set() stamps current
                    main: Some("paper.typ".into()),
                    title: Some("T".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(cfg.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(svc.get(), Some(cfg));
        // Persisted to disk as TOML.
        let disk = std::fs::read_to_string(root.join(CONFIG_FILENAME)).unwrap();
        assert!(disk.contains("main = \"paper.typ\""));
        // set fired on_change exactly once with the new config.
        assert_eq!(cap.lock().unwrap().len(), 1);
    }

    #[test]
    fn fresh_service_loads_persisted_file() {
        let root = tmp_root();
        let (svc, _) = capturing_service();
        svc.set(&root, ProjectConfig {
            schema_version: CURRENT_SCHEMA_VERSION,
            main: Some("a.typ".into()),
            ..Default::default()
        })
        .unwrap();

        let (svc2, _) = capturing_service();
        let loaded = svc2.load(&root).unwrap();
        assert_eq!(loaded.main.as_deref(), Some("a.typ"));
        assert!(loaded.title.is_none());
    }

    #[test]
    fn set_main_file_merges_preserving_title() {
        let root = tmp_root();
        let (svc, _) = capturing_service();
        svc.set(&root, ProjectConfig {
            schema_version: CURRENT_SCHEMA_VERSION,
            main: Some("a.typ".into()),
            title: Some("Title".into()),
            ..Default::default()
        })
        .unwrap();
        let cfg = svc.set_main_file(&root, Some("b.typ".into())).unwrap();
        assert_eq!(cfg.main.as_deref(), Some("b.typ"));
        assert_eq!(cfg.title.as_deref(), Some("Title")); // preserved
    }

    #[test]
    fn set_main_file_none_clears_main_keeps_config() {
        let root = tmp_root();
        let (svc, _) = capturing_service();
        svc.set(&root, ProjectConfig {
            schema_version: CURRENT_SCHEMA_VERSION,
            main: Some("a.typ".into()),
            title: Some("Title".into()),
            ..Default::default()
        })
        .unwrap();
        let cfg = svc.set_main_file(&root, None).unwrap();
        assert!(cfg.main.is_none());
        assert_eq!(cfg.title.as_deref(), Some("Title"));
        // File still on disk (config not deleted, only main cleared).
        assert!(root.join(CONFIG_FILENAME).exists());
    }

    #[test]
    fn set_rejects_invalid_main_path() {
        let root = tmp_root();
        let (svc, _) = capturing_service();
        let err = svc
            .set(
                &root,
                ProjectConfig {
                    schema_version: 1,
                    main: Some("../escape.typ".into()),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(err.to_string().to_lowercase().contains("workspace"));
    }

    #[test]
    fn set_rejects_invalid_compile_root() {
        let root = tmp_root();
        let (svc, _) = capturing_service();
        use crate::domain::project_config::CompileConfig;
        let err = svc
            .set(
                &root,
                ProjectConfig {
                    schema_version: 2,
                    compile: Some(CompileConfig {
                        root: Some("../outside".into()),
                        extra_font_dirs: None,
                    }),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(err.to_string().to_lowercase().contains("compile.root"));
    }

    #[test]
    fn set_rejects_invalid_bibliography_entry() {
        let root = tmp_root();
        let (svc, _) = capturing_service();
        let err = svc
            .set(
                &root,
                ProjectConfig {
                    schema_version: 2,
                    bibliography: Some(vec!["/abs.bib".into()]),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(err.to_string().to_lowercase().contains("bibliography"));
    }

    #[test]
    fn set_rejects_unknown_export_format() {
        // A hand-edited panel value like "jpeg" has no export command behind
        // it; set() must reject it with a named error instead of persisting a
        // config the exporter silently ignores (falling back to pdf).
        let root = tmp_root();
        let (svc, _) = capturing_service();
        use crate::domain::project_config::ExportConfig;
        let err = svc
            .set(
                &root,
                ProjectConfig {
                    schema_version: 2,
                    export: Some(ExportConfig {
                        format: Some("jpeg".into()),
                        output_path: None,
                    }),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(
            err.to_string().contains("export.format"),
            "error must name the field, got: {err}"
        );
        // The known formats persist fine.
        svc.set(
            &root,
            ProjectConfig {
                schema_version: 2,
                export: Some(ExportConfig {
                    format: Some("png".into()),
                    output_path: None,
                }),
                ..Default::default()
            },
        )
        .unwrap();
    }

    #[test]
    fn clear_removes_file_and_cache() {
        let root = tmp_root();
        let (svc, cap) = capturing_service();
        svc.set(&root, ProjectConfig {
            schema_version: 1,
            main: Some("a.typ".into()),
            ..Default::default()
        })
        .unwrap();
        assert!(root.join(CONFIG_FILENAME).exists());
        let cap_len_before = cap.lock().unwrap().len();

        svc.clear(&root).unwrap();
        assert!(!root.join(CONFIG_FILENAME).exists());
        assert!(svc.get().is_none());
        // clear fires on_change(None).
        assert_eq!(cap.lock().unwrap().len(), cap_len_before + 1);

        // Idempotent: clearing again is fine.
        svc.clear(&root).unwrap();
    }

    #[test]
    fn list_typ_files_walks_recursively() {
        let root = tmp_root();
        std::fs::write(root.join("a.typ"), b"x").unwrap();
        std::fs::create_dir_all(root.join("ch")).unwrap();
        std::fs::write(root.join("ch").join("b.typ"), b"x").unwrap();
        std::fs::write(root.join("ignored.txt"), b"x").unwrap();
        // Hidden + node_modules + target are skipped.
        std::fs::write(root.join(".hidden.typ"), b"x").unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules").join("nm.typ"), b"x").unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::write(root.join("target").join("t.typ"), b"x").unwrap();

        let files = ProjectConfigService::list_typ_files(&root, None);
        assert_eq!(files, vec!["a.typ".to_string(), "ch/b.typ".to_string()]);
    }

    #[test]
    fn list_typ_files_applies_exclude() {
        let root = tmp_root();
        std::fs::write(root.join("keep.typ"), b"x").unwrap();
        std::fs::create_dir_all(root.join("build")).unwrap();
        std::fs::write(root.join("build").join("out.typ"), b"x").unwrap();
        std::fs::write(root.join("notes.bak.typ"), b"x").unwrap();

        let gs = build_exclude_globset(Some(&["build/**".to_string(), "*.bak.typ".to_string()])).unwrap();
        let files = ProjectConfigService::list_typ_files(&root, Some(&gs));
        // build/ pruned by build/**; notes.bak.typ dropped by *.bak.typ.
        assert_eq!(files, vec!["keep.typ".to_string()]);
    }

    #[test]
    fn build_exclude_globset_none_when_empty() {
        assert!(build_exclude_globset(None).is_none());
        assert!(build_exclude_globset(Some(&[])).is_none());
    }

    #[test]
    fn list_typ_files_missing_root_is_empty() {
        let files = ProjectConfigService::list_typ_files(&PathBuf::from("/does/not/exist"), None);
        assert!(files.is_empty());
    }

    #[test]
    fn load_drops_paths_that_escape_the_workspace() {
        // A hand-edited / untrusted `.typstpro` with escaping path fields: the
        // valid `main` is preserved, every escaping field is dropped to None.
        let root = tmp_root();
        std::fs::write(
            root.join(CONFIG_FILENAME),
            "schemaVersion = 2\n\
             main = \"paper.typ\"\n\
             newFileTemplate = \"../../../etc/passwd\"\n\
             bibliography = [\"refs.bib\", \"/abs.bib\"]\n\
             \n[compile]\nroot = \"../../outside\"\nextraFontDirs = [\"fonts\", \"..\"]\n",
        )
        .unwrap();
        let (svc, _cap) = capturing_service();
        let cfg = svc.load(&root).expect("valid v2 config loads");
        assert_eq!(cfg.main.as_deref(), Some("paper.typ")); // valid, kept
        assert!(cfg.new_file_template.is_none(), "escaping newFileTemplate dropped");
        // bibliography: "refs.bib" kept, "/abs.bib" (absolute) dropped.
        assert_eq!(cfg.bibliography.as_deref(), Some(&["refs.bib".to_string()][..]));
        let compile = cfg.compile.expect("compile table kept");
        assert!(compile.root.is_none(), "escaping compile.root dropped");
        // extraFontDirs: "fonts" kept, ".." dropped.
        assert_eq!(
            compile.extra_font_dirs.as_deref(),
            Some(&["fonts".to_string()][..])
        );
    }
}
