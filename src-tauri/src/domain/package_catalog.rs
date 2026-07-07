//! Package catalog domain types — the wire shape shared by the IPC layer and
//! the package service. Pure data (no IO). See
//! docs/superpowers/specs/2026-07-07-packages-templates-design.md §3.1.

use serde::{Deserialize, Serialize};

/// A template's `[template]` table from `index.json` / `typst.toml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct TemplateMeta {
    /// Directory within the package holding the template files.
    pub path: String,
    /// File relative to `path` that is the compile entrypoint.
    pub entrypoint: String,
    /// Optional path (relative to package root) to a PNG/WebP thumbnail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
}

/// One entry from the Universe `index.json`. A package is also a template
/// when `template` is `Some` (i.e. its `typst.toml` has a `[template]` table).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct PackageEntry {
    pub name: String,
    pub version: String,
    pub entrypoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub disciplines: Vec<String>,
    /// Minimum required compiler version, e.g. "0.13.0".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compiler: Option<String>,
    /// Unix seconds (the registry's `updatedAt` field).
    #[serde(rename = "updatedAt", default)]
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub updated_at: i64,
    /// `Some` ⇒ this entry is also a template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<TemplateMeta>,
}

impl PackageEntry {
    /// True when the entry exposes a `[template]` table.
    pub fn is_template(&self) -> bool {
        self.template.is_some()
    }
}

/// A package found in the local cache dir (from `package_list_installed`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct InstalledPackage {
    pub name: String,
    pub version: String,
    /// Fixed `"preview"` in v1.
    pub namespace: String,
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub size_bytes: u64,
    /// True when the on-disk `typst.toml` has a `[template]` table.
    pub has_template: bool,
    /// Dir mtime as Unix seconds (best-effort).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
    pub installed_at: Option<i64>,
}

/// Query parameters for `package_list_catalog`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct CatalogFilter {
    /// Fuzzy on name/description/keywords/authors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only_templates: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only_packages: Option<bool>,
    /// Match-any category filter.
    #[serde(default)]
    pub categories: Vec<String>,
    /// Dedupe to the highest version per name. Default `true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_only: Option<bool>,
}

/// Compare a package's required `compiler` string against the embedded Typst
/// version. Returns `None` when the package declares no requirement or the
/// string cannot be parsed; `Some(true)` when the requirement exceeds the
/// embedded version (the "incompatible" warning condition).
pub fn requires_newer_compiler(required: &str) -> Option<bool> {
    use std::str::FromStr;
    let req = typst::syntax::package::PackageVersion::from_str(required).ok()?;
    Some(typst::syntax::package::PackageVersion::compiler() < req)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_with_template_is_template() {
        let e = PackageEntry {
            name: "t".into(),
            version: "0.1.0".into(),
            entrypoint: "lib.typ".into(),
            description: None,
            authors: vec![],
            license: None,
            repository: None,
            homepage: None,
            keywords: vec![],
            categories: vec!["thesis".into()],
            disciplines: vec![],
            compiler: None,
            updated_at: 0,
            template: Some(TemplateMeta {
                path: "template".into(),
                entrypoint: "main.typ".into(),
                thumbnail: Some("thumbnail.png".into()),
            }),
        };
        assert!(e.is_template());
    }

    #[test]
    fn entry_without_template_is_not_template() {
        let e = PackageEntry {
            name: "p".into(),
            version: "0.1.0".into(),
            entrypoint: "lib.typ".into(),
            description: None,
            authors: vec![],
            license: None,
            repository: None,
            homepage: None,
            keywords: vec![],
            categories: vec![],
            disciplines: vec![],
            compiler: None,
            updated_at: 0,
            template: None,
        };
        assert!(!e.is_template());
    }

    #[test]
    fn parses_index_json_snake_case_updated_at() {
        // The registry emits `updatedAt`; serde rename maps it to updated_at.
        let raw = r#"[{"name":"x","version":"0.1.0","entrypoint":"lib.typ","updatedAt":1700000000}]"#;
        let v: Vec<PackageEntry> = serde_json::from_str(raw).unwrap();
        assert_eq!(v[0].updated_at, 1700000000);
        assert!(v[0].template.is_none());
    }

    #[test]
    fn compiler_compare_detects_newer_requirement() {
        // Require something clearly newer than 0.15 → Some(true).
        assert_eq!(requires_newer_compiler("999.0.0"), Some(true));
        // Require something older → Some(false).
        assert_eq!(requires_newer_compiler("0.1.0"), Some(false));
        // Garbage → None.
        assert_eq!(requires_newer_compiler("not-a-version"), None);
    }

    #[test]
    fn catalog_filter_defaults_are_empty() {
        let f = CatalogFilter::default();
        assert!(f.query.is_none());
        assert!(f.only_templates.is_none());
        assert!(f.categories.is_empty());
    }

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        PackageEntry::export(&cfg).unwrap();
        TemplateMeta::export(&cfg).unwrap();
        InstalledPackage::export(&cfg).unwrap();
        CatalogFilter::export(&cfg).unwrap();
    }
}
