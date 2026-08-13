//! Project config domain type — the `.typstpro` file at the workspace root.
//!
//! Pure data (no IO). Shared by the IPC layer and
//! [`ProjectConfigService`](crate::service::project_config_service). The
//! on-disk format is TOML; the same struct serializes to the wire (camelCase)
//! so the frontend reads one generated type.
//!
//! ```toml
//! schemaVersion = 2
//! main = "paper.typ"
//! title = "My Paper"
//! bibliography = ["refs.bib"]
//! newFileTemplate = "templates/chapter.typ"
//! exclude = ["build/**", "out/**"]
//!
//! [compile]
//! root = "src"
//! extraFontDirs = ["fonts"]
//!
//! [export]
//! format = "pdf"
//! outputPath = "build/${title}.pdf"
//! ```

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::persistence::migrate::Migrator;

/// The current `.typstpro` schema version. Bump + register a migration step in
/// [`ProjectConfig::migrator`] whenever the shape changes.
pub const CURRENT_SCHEMA_VERSION: u32 = 2;

/// The `[compile]` table: compile-time project overrides.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct CompileConfig {
    /// Workspace-relative directory Typst treats as `--root` for absolute-path
    /// / `#image()` resolution. `None` = the workspace root itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// Workspace-relative font directories (e.g. a `fonts/` folder checked into
    /// the project). Takes effect after restart (folded into the startup font
    /// scan, like the global `compiler.extraFontDirs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_font_dirs: Option<Vec<String>>,
}

/// The `[export]` table: export defaults.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct ExportConfig {
    /// Default export format: `"pdf"` / `"png"` / `"svg"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// Output path pattern (e.g. `"build/${title}.pdf"`). When set, export
    /// writes directly here (skipping the save dialog). Macros expand on the
    /// frontend (mirrors paste-image path macros).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
}

/// The project-level config stored in `<workspace>/.typstpro`.
///
/// All fields are optional — an empty/missing file is a valid "no project
/// metadata" state. Path-typed fields (`main`, `bibliography[]`,
/// `new_file_template`, `compile.root`, `compile.extra_font_dirs[]`) are
/// workspace-relative and validated to stay within the workspace.
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
    /// Workspace-relative path to the project's main compile file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main: Option<String>,
    /// Optional human-readable project title. Also the `${title}` macro source
    /// for `[export] outputPath`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Declared bibliography files (workspace-relative). The Bibliography panel
    /// prefers these over scan-discovery when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bibliography: Option<Vec<String>>,
    /// Workspace-relative file whose contents seed a new document. Precedence
    /// in `new_tab`: explicit content > this > global `document.defaultTemplate`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_file_template: Option<String>,
    /// Per-project ignore globs (matched against workspace-relative paths with
    /// forward slashes), applied to workspace search + the main-file picker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude: Option<Vec<String>>,
    /// The `[compile]` table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compile: Option<CompileConfig>,
    /// The `[export]` table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export: Option<ExportConfig>,
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            main: None,
            title: None,
            bibliography: None,
            new_file_template: None,
            exclude: None,
            compile: None,
            export: None,
        }
    }
}

impl ProjectConfig {
    /// Build the forward-only migrator for `.typstpro`. v2 adds optional
    /// fields on top of v1 — no value transform is needed, so the single step
    /// is a no-op version bump.
    pub fn migrator() -> Migrator<Self> {
        Migrator::new(CURRENT_SCHEMA_VERSION).step(|_| Ok(()))
    }

    /// The `[compile].root`, if designated.
    pub fn compile_root(&self) -> Option<&str> {
        self.compile.as_ref()?.root.as_deref()
    }

    /// Iterator over `[compile].extraFontDirs` entries (empty if absent).
    pub fn extra_font_dirs(&self) -> impl Iterator<Item = &str> {
        self.compile
            .as_ref()
            .and_then(|c| c.extra_font_dirs.as_deref())
            .map(|v| v.iter().map(String::as_str))
            .into_iter()
            .flatten()
    }
}

/// Validate a workspace-relative `path` for `field`: non-empty, relative, no
/// `..` / absolute / Windows-drive components, so it can never resolve outside
/// the workspace root. Existence is NOT checked — the path may be designated
/// before it is created.
pub fn validate_workspace_relative_path(path: &str, field: &str) -> Result<()> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput(format!("{field} must not be empty")));
    }
    let p = std::path::Path::new(path);
    if !p.is_relative() {
        return Err(AppError::InvalidInput(format!(
            "{field} must be relative to the workspace root (got '{path}')"
        )));
    }
    for comp in p.components() {
        use std::path::Component;
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            // ParentDir would let `../sibling` escape the workspace; Prefix
            // (Windows drive letter) implies an absolute path.
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(AppError::InvalidInput(format!(
                    "{field} must stay within the workspace (got '{path}')"
                )));
            }
        }
    }
    Ok(())
}

/// Back-compat delegate for the main-file field. Prefer
/// [`validate_workspace_relative_path`] at new call sites.
pub fn validate_main_path(main: &str) -> Result<()> {
    validate_workspace_relative_path(main, "main file path")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_toml() {
        let raw = "schemaVersion = 2\nmain = \"paper.typ\"\ntitle = \"My Paper\"\n";
        let cfg: ProjectConfig = toml::from_str(raw).unwrap();
        assert_eq!(cfg.schema_version, 2);
        assert_eq!(cfg.main.as_deref(), Some("paper.typ"));
        assert_eq!(cfg.title.as_deref(), Some("My Paper"));
    }

    #[test]
    fn parses_nested_tables() {
        let raw = r#"
schemaVersion = 2
main = "paper.typ"
bibliography = ["refs.bib", "extra.yml"]
exclude = ["build/**"]
newFileTemplate = "templates/chapter.typ"

[compile]
root = "src"
extraFontDirs = ["fonts"]

[export]
format = "pdf"
outputPath = "build/${title}.pdf"
"#;
        let cfg: ProjectConfig = toml::from_str(raw).unwrap();
        assert_eq!(cfg.main.as_deref(), Some("paper.typ"));
        assert_eq!(cfg.bibliography.as_deref(), Some(&["refs.bib".to_string(), "extra.yml".to_string()][..]));
        assert_eq!(cfg.exclude.as_deref(), Some(&["build/**".to_string()][..]));
        assert_eq!(cfg.new_file_template.as_deref(), Some("templates/chapter.typ"));
        let compile = cfg.compile.unwrap();
        assert_eq!(compile.root.as_deref(), Some("src"));
        assert_eq!(compile.extra_font_dirs.as_deref(), Some(&["fonts".to_string()][..]));
        let export = cfg.export.unwrap();
        assert_eq!(export.format.as_deref(), Some("pdf"));
        assert_eq!(export.output_path.as_deref(), Some("build/${title}.pdf"));
    }

    #[test]
    fn removed_fields_are_ignored_on_load() {
        // `template` and `typstVersion` were removed; an old `.typstpro` that
        // still carries them must load (serde ignores unknown keys by default),
        // and the surviving fields are parsed as usual.
        let raw = "schemaVersion = 2\nmain = \"paper.typ\"\ntemplate = \"@preview/foo:0.1.0\"\ntypstVersion = \"0.13.0\"\n";
        let cfg: ProjectConfig = toml::from_str(raw).unwrap();
        assert_eq!(cfg.main.as_deref(), Some("paper.typ"));
    }

    #[test]
    fn missing_fields_default() {
        let raw = "main = \"x.typ\"\n";
        let cfg: ProjectConfig = toml::from_str(raw).unwrap();
        assert_eq!(cfg.schema_version, 0);
        assert_eq!(cfg.main.as_deref(), Some("x.typ"));
        assert!(cfg.title.is_none());
        assert!(cfg.bibliography.is_none());
        assert!(cfg.compile.is_none());
        assert!(cfg.export.is_none());
    }

    #[test]
    fn empty_file_parses_to_defaults() {
        let cfg: ProjectConfig = toml::from_str("").unwrap();
        assert_eq!(cfg.schema_version, 0);
        assert!(cfg.main.is_none());
        assert!(cfg.compile.is_none());
    }

    #[test]
    fn serializes_skip_none_fields() {
        let cfg = ProjectConfig {
            schema_version: 2,
            main: Some("paper.typ".into()),
            title: None,
            bibliography: None,
            new_file_template: None,
            exclude: None,
            compile: None,
            export: None,
        };
        let raw = toml::to_string_pretty(&cfg).unwrap();
        assert!(raw.contains("schemaVersion = 2"));
        assert!(raw.contains("main = \"paper.typ\""));
        assert!(!raw.contains("title"));
        assert!(!raw.contains("[compile]"));
    }

    #[test]
    fn camel_case_on_wire() {
        let cfg = ProjectConfig {
            schema_version: 2,
            main: Some("a.typ".into()),
            title: Some("T".into()),
            bibliography: None,
            new_file_template: None,
            exclude: None,
            compile: Some(CompileConfig { root: Some("src".into()), extra_font_dirs: None }),
            export: None,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"schemaVersion\""));
        assert!(json.contains("\"newFileTemplate\"") || !json.contains("newFileTemplate"));
        assert!(json.contains("\"compile\""));
        assert!(json.contains("\"extraFontDirs\"") || !json.contains("extraFontDirs"));
    }

    #[test]
    fn migrator_bumps_version_zero_to_current() {
        let mut cfg = ProjectConfig {
            schema_version: 0,
            main: Some("x.typ".into()),
            title: None,
            bibliography: None,
            new_file_template: None,
            exclude: None,
            compile: None,
            export: None,
        };
        let v = ProjectConfig::migrator()
            .migrate(&mut cfg, |c| c.schema_version, |c, v| c.schema_version = v)
            .unwrap();
        assert_eq!(v, CURRENT_SCHEMA_VERSION);
        assert_eq!(cfg.main.as_deref(), Some("x.typ")); // migration preserves data
    }

    #[test]
    fn migrator_bumps_v1_to_v2() {
        // A v1 file (no new fields) migrates to v2 with new fields = None.
        let mut cfg = ProjectConfig {
            schema_version: 1,
            main: Some("x.typ".into()),
            title: Some("T".into()),
            bibliography: None,
            new_file_template: None,
            exclude: None,
            compile: None,
            export: None,
        };
        let v = ProjectConfig::migrator()
            .migrate(&mut cfg, |c| c.schema_version, |c, v| c.schema_version = v)
            .unwrap();
        assert_eq!(v, 2);
        assert_eq!(cfg.schema_version, 2);
        assert_eq!(cfg.main.as_deref(), Some("x.typ"));
        assert_eq!(cfg.title.as_deref(), Some("T"));
    }

    #[test]
    fn validate_accepts_relative_paths() {
        assert!(validate_workspace_relative_path("paper.typ", "main").is_ok());
        assert!(validate_workspace_relative_path("chapters/intro.typ", "bibliography entry").is_ok());
        assert!(validate_workspace_relative_path("src", "compile.root").is_ok());
        assert!(validate_main_path("a/b/c.typ").is_ok());
    }

    #[test]
    fn validate_rejects_empty_absolute_parent_escape() {
        assert!(validate_workspace_relative_path("", "main").is_err());
        assert!(validate_workspace_relative_path("/etc/x", "main").is_err());
        assert!(validate_workspace_relative_path("C:\\x", "main").is_err());
        assert!(validate_workspace_relative_path("../x", "main").is_err());
        assert!(validate_main_path("../sibling.typ").is_err());
    }

    #[test]
    fn compile_root_and_font_dirs_accessors() {
        let mut cfg = ProjectConfig::default();
        assert!(cfg.compile_root().is_none());
        assert_eq!(cfg.extra_font_dirs().count(), 0);
        cfg.compile = Some(CompileConfig {
            root: Some("src".into()),
            extra_font_dirs: Some(vec!["fonts".into(), "more".into()]),
        });
        assert_eq!(cfg.compile_root(), Some("src"));
        assert_eq!(cfg.extra_font_dirs().collect::<Vec<_>>(), vec!["fonts", "more"]);
    }

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        ProjectConfig::export(&cfg).unwrap();
        CompileConfig::export(&cfg).unwrap();
        ExportConfig::export(&cfg).unwrap();
    }
}
