//! Project config domain type — the `.typstpro` file at the workspace root.
//!
//! Pure data (no IO). Shared by the IPC layer and
//! [`ProjectConfigService`](crate::service::project_config_service). The
//! on-disk format is TOML; the same struct serializes to the wire (camelCase)
//! so the frontend reads one generated type.
//!
//! ```toml
//! schemaVersion = 1
//! main = "paper.typ"     # relative to the workspace root
//! title = "My Paper"     # optional
//! ```

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::persistence::migrate::Migrator;

/// The current `.typstpro` schema version. Bump + register a migration step in
/// [`project_config_migrator`] whenever the shape changes.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// The project-level config stored in `<workspace>/.typstpro`.
///
/// All fields are optional — an empty/missing file is a valid "no project
/// metadata" state. `main` is the project's compile entry file (relative to the
/// workspace root); `title` is a human-readable project title.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct ProjectConfig {
    /// Schema version. Defaults to `0` when absent on disk so the migrator can
    /// forward it to [`CURRENT_SCHEMA_VERSION`]; always stamped to the current
    /// version on write.
    #[serde(default)]
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub schema_version: u32,
    /// Workspace-relative path to the project's main compile file. `None` (or
    /// the TOML key absent) means "no main file designated".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main: Option<String>,
    /// Optional human-readable project title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            main: None,
            title: None,
        }
    }
}

impl ProjectConfig {
    /// Build the forward-only migrator for `.typstpro`. v1 is the first
    /// version, so there are no transform steps yet; the migrator still bumps a
    /// version-0 (or absent-`schemaVersion`) file up to current on load.
    pub fn migrator() -> Migrator<Self> {
        Migrator::new(CURRENT_SCHEMA_VERSION)
    }
}

/// Validate a candidate `main` path: it must be a non-empty relative path with
/// no `..` components, so it can never resolve outside the workspace root.
/// Absolute paths and parent-dir escapes are rejected. Existence of the file is
/// NOT checked here — the file may be designated before it is created.
pub fn validate_main_path(main: &str) -> Result<()> {
    if main.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "main file path must not be empty".into(),
        ));
    }
    let path = std::path::Path::new(main);
    if !path.is_relative() {
        return Err(AppError::InvalidInput(format!(
            "main file path must be relative to the workspace root (got '{main}')"
        )));
    }
    for comp in path.components() {
        use std::path::Component;
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            // ParentDir would let `../sibling.typ` escape the workspace;
            // Prefix (Windows drive letter) implies an absolute path.
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(AppError::InvalidInput(format!(
                    "main file path must stay within the workspace (got '{main}')"
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_toml() {
        let raw = "schemaVersion = 1\nmain = \"paper.typ\"\ntitle = \"My Paper\"\n";
        let cfg: ProjectConfig = toml::from_str(raw).unwrap();
        assert_eq!(cfg.schema_version, 1);
        assert_eq!(cfg.main.as_deref(), Some("paper.typ"));
        assert_eq!(cfg.title.as_deref(), Some("My Paper"));
    }

    #[test]
    fn missing_fields_default() {
        // No schemaVersion → 0 (migrator forwards it); no main/title → None.
        let raw = "main = \"x.typ\"\n";
        let cfg: ProjectConfig = toml::from_str(raw).unwrap();
        assert_eq!(cfg.schema_version, 0);
        assert_eq!(cfg.main.as_deref(), Some("x.typ"));
        assert!(cfg.title.is_none());
    }

    #[test]
    fn empty_file_parses_to_defaults() {
        let cfg: ProjectConfig = toml::from_str("").unwrap();
        assert_eq!(cfg.schema_version, 0);
        assert!(cfg.main.is_none());
        assert!(cfg.title.is_none());
    }

    #[test]
    fn serializes_skip_none_fields() {
        let cfg = ProjectConfig {
            schema_version: 1,
            main: Some("paper.typ".into()),
            title: None,
        };
        let raw = toml::to_string_pretty(&cfg).unwrap();
        assert!(raw.contains("schemaVersion = 1"));
        assert!(raw.contains("main = \"paper.typ\""));
        assert!(!raw.contains("title")); // skipped when None
    }

    #[test]
    fn camel_case_on_wire() {
        let cfg = ProjectConfig {
            schema_version: 1,
            main: Some("a.typ".into()),
            title: Some("T".into()),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"schemaVersion\""));
        assert!(json.contains("\"main\""));
        assert!(json.contains("\"title\""));
    }

    #[test]
    fn migrator_bumps_version_zero_to_current() {
        let mut cfg = ProjectConfig {
            schema_version: 0,
            main: Some("x.typ".into()),
            title: None,
        };
        let v = ProjectConfig::migrator()
            .migrate(
                &mut cfg,
                |c| c.schema_version,
                |c, v| c.schema_version = v,
            )
            .unwrap();
        assert_eq!(v, CURRENT_SCHEMA_VERSION);
        assert_eq!(cfg.schema_version, CURRENT_SCHEMA_VERSION);
        // Migration must not drop data.
        assert_eq!(cfg.main.as_deref(), Some("x.typ"));
    }

    #[test]
    fn validate_accepts_relative_paths() {
        assert!(validate_main_path("paper.typ").is_ok());
        assert!(validate_main_path("chapters/intro.typ").is_ok());
        assert!(validate_main_path("./paper.typ").is_ok());
        assert!(validate_main_path("a/b/c.typ").is_ok());
    }

    #[test]
    fn validate_rejects_empty() {
        assert!(validate_main_path("").is_err());
        assert!(validate_main_path("   ").is_err());
    }

    #[test]
    fn validate_rejects_absolute() {
        assert!(validate_main_path("/etc/passwd").is_err());
        assert!(validate_main_path("C:\\Users\\x.typ").is_err());
    }

    #[test]
    fn validate_rejects_parent_escape() {
        assert!(validate_main_path("../sibling.typ").is_err());
        assert!(validate_main_path("a/../../escape.typ").is_err());
    }

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        ProjectConfig::export(&cfg).unwrap();
    }
}
