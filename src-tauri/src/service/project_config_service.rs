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

use crate::domain::project_config::{validate_main_path, ProjectConfig, CURRENT_SCHEMA_VERSION};
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

    /// The cached config (a clone), or `None`.
    pub fn get(&self) -> Option<ProjectConfig> {
        self.config.read().clone()
    }

    /// Validate, persist, cache, and broadcast a full config. `schema_version`
    /// is stamped to current before writing. Returns the saved config.
    pub fn set(&self, root: &Path, mut cfg: ProjectConfig) -> Result<ProjectConfig> {
        if let Some(main) = cfg.main.as_deref() {
            validate_main_path(main)?;
        }
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
            validate_main_path(m)?;
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
    /// Hidden entries (leading `.`) and `node_modules` are skipped. Returns an
    /// empty vec when `root` is missing or unreadable.
    pub fn list_typ_files(root: &Path) -> Vec<String> {
        let mut out = Vec::new();
        walk_typ(root, root, &mut out);
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

/// Recursive `.typ` collector. `base` is the root used to compute the relative
/// path; `dir` is the current traversal position.
fn walk_typ(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // Skip hidden entries (`.git`, `.typstpro`, …) and `node_modules`.
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            walk_typ(base, &path, out);
        } else if ft.is_file() && name.ends_with(".typ") {
            if let Ok(rel) = path.strip_prefix(base) {
                // Forward-slash relative path for cross-platform wire stability.
                let rel = rel.to_string_lossy().replace('\\', "/");
                out.push(rel);
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
            title: None,
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
                    title: None,
                },
            )
            .unwrap_err();
        assert!(err.to_string().to_lowercase().contains("workspace"));
    }

    #[test]
    fn clear_removes_file_and_cache() {
        let root = tmp_root();
        let (svc, cap) = capturing_service();
        svc.set(&root, ProjectConfig {
            schema_version: 1,
            main: Some("a.typ".into()),
            title: None,
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
        // Hidden + node_modules are skipped.
        std::fs::write(root.join(".hidden.typ"), b"x").unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules").join("nm.typ"), b"x").unwrap();

        let files = ProjectConfigService::list_typ_files(&root);
        assert_eq!(files, vec!["a.typ".to_string(), "ch/b.typ".to_string()]);
    }

    #[test]
    fn list_typ_files_missing_root_is_empty() {
        let files = ProjectConfigService::list_typ_files(&PathBuf::from("/does/not/exist"));
        assert!(files.is_empty());
    }
}
