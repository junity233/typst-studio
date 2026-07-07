//! Package catalog + install orchestration.
//!
//! Holds the [`PackageIndex`] snapshot and a handle to the process-wide
//! [`SystemPackages`](typst_kit::packages::SystemPackages) singleton. Every
//! install goes through `SystemPackages::obtain` — the SAME path the compiler
//! uses at `#import` time — so installs and compiles share one cache dir and
//! never conflict. See spec §3.3 + §6.6 (compile unaffected).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use typst_kit::packages::SystemPackages;
use typst::syntax::package::PackageSpec;

use crate::domain::package_catalog::{
    CatalogFilter, InstalledPackage, PackageEntry,
};
use crate::fs::package_index::{Catalog, PackageIndex};

/// Outcome of `list_catalog`: the filtered, deduped entries plus status.
#[derive(Debug, Clone)]
pub struct CatalogListing {
    pub entries: Vec<PackageEntry>,
    pub fetched_at: Option<i64>,
    /// True when no in-memory snapshot existed and we fell back to disk/empty.
    pub stale: bool,
}

/// Why an install/init failed (mapped to IPC error codes in the command layer).
#[derive(Debug)]
pub enum PackageOpError {
    NotFound,
    Install(String),
    Uninstall(String),
    TemplateInit { copied: Vec<PathBuf>, cause: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum InstallState {
    InProgress,
    Done,
}

pub struct PackageService {
    index: Arc<PackageIndex>,
    packages: Arc<SystemPackages>,
    in_flight: Mutex<HashMap<(String, String), InstallState>>,
}

impl PackageService {
    pub fn new(
        index: Arc<PackageIndex>,
        packages: Arc<SystemPackages>,
    ) -> Self {
        Self {
            index,
            packages,
            in_flight: Mutex::new(HashMap::new()),
        }
    }

    /// Read the cached index, apply `filter`, return the listing.
    pub fn list_catalog(&self, filter: &CatalogFilter) -> CatalogListing {
        let latest_only = filter.latest_only.unwrap_or(true);
        let cat = self.index.load_cached();
        let (entries, fetched_at, stale) = match cat {
            Some(c) => (filter_catalog(&c, filter, latest_only), c.fetched_at, false),
            None => (Vec::new(), None, true),
        };
        CatalogListing { entries, fetched_at, stale }
    }

    /// Trigger a refresh; returns the fresh snapshot. The caller runs this on
    /// the async runtime (it awaits the HTTP fetch).
    pub async fn refresh_index(
        &self,
    ) -> Result<Catalog, crate::fs::package_index::IndexFetchError> {
        self.index.refresh().await
    }

    /// Install (pre-download) `name:version` into the standard cache via
    /// typst-kit. Dedupes concurrent calls. typst-kit's API is synchronous, so
    /// the IPC layer MUST run this in `spawn_blocking`.
    pub fn install_blocking(&self, name: &str, version: &str) -> Result<(), PackageOpError> {
        let key = (name.to_string(), version.to_string());
        {
            let mut g = self.in_flight.lock();
            if matches!(g.get(&key), Some(InstallState::InProgress)) {
                return Ok(()); // another caller is doing it
            }
            g.insert(key.clone(), InstallState::InProgress);
        }
        let result = self.obtain(name, version);
        let mut g = self.in_flight.lock();
        match result {
            Ok(()) => {
                g.insert(key, InstallState::Done);
                Ok(())
            }
            Err(e) => {
                g.remove(&key);
                Err(PackageOpError::Install(e))
            }
        }
    }

    fn obtain(&self, name: &str, version: &str) -> Result<(), String> {
        // typst's PackageSpec FromStr wants "@preview/name:version"
        // (colon before version). Build the canonical form.
        let spec_str = format!("@preview/{name}:{version}");
        let spec: PackageSpec = spec_str
            .parse()
            .map_err(|e| format!("invalid spec {spec_str}: {e}"))?;
        self.packages
            .obtain(&spec)
            .map(|_| ())
            .map_err(|e| format!("obtain {spec_str}: {e}"))
    }

    fn cache_root(&self) -> Option<PathBuf> {
        self.packages.cache().map(|c| c.path().to_path_buf())
    }

    /// Resolve the on-disk package dir for `name:version`.
    pub fn package_dir(&self, name: &str, version: &str) -> Option<PathBuf> {
        self.cache_root()
            .map(|root| root.join("preview").join(name).join(version))
    }

    /// Delete the cached version dir.
    pub fn uninstall(&self, name: &str, version: &str) -> Result<(), PackageOpError> {
        let Some(dir) = self.package_dir(name, version) else {
            return Err(PackageOpError::Uninstall("no cache dir configured".into()));
        };
        if !dir.exists() {
            return Err(PackageOpError::NotFound);
        }
        std::fs::remove_dir_all(&dir).map_err(|e| PackageOpError::Uninstall(e.to_string()))
    }

    /// Scan the cache root for installed `@preview` packages.
    pub fn list_installed(&self) -> Vec<InstalledPackage> {
        let Some(root) = self.cache_root() else {
            return Vec::new();
        };
        let preview = root.join("preview");
        let mut out = Vec::new();
        let names = match std::fs::read_dir(&preview) {
            Ok(rd) => rd,
            Err(_) => return out,
        };
        for name_entry in names.flatten() {
            let name = match name_entry.file_name().to_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            let versions = match std::fs::read_dir(name_entry.path()) {
                Ok(rd) => rd,
                Err(_) => continue,
            };
            for ver_entry in versions.flatten() {
                let version = match ver_entry.file_name().to_str() {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                let dir = ver_entry.path();
                let size_bytes = dir_size(&dir);
                let has_template = has_template_table(&dir);
                let installed_at = std::fs::metadata(&dir)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64);
                out.push(InstalledPackage {
                    name: name.clone(),
                    version,
                    namespace: "preview".into(),
                    size_bytes,
                    has_template,
                    installed_at,
                });
            }
        }
        out
    }

    /// Initialize a template: ensure cached, then copy `template.path/` into
    /// `dest`. When `overwrite` is false, aborts on the first file conflict;
    /// when true, overwrites existing files (user confirmed). Returns the
    /// entrypoint path (relative to dest) to open as the first tab.
    pub fn init_template(
        &self,
        name: &str,
        version: &str,
        dest: &Path,
        overwrite: bool,
    ) -> Result<String, PackageOpError> {
        self.install_blocking(name, version)?;
        let Some(pkg_dir) = self.package_dir(name, version) else {
            return Err(PackageOpError::TemplateInit {
                copied: vec![],
                cause: "no cache dir configured".into(),
            });
        };
        let manifest = read_manifest(&pkg_dir).map_err(|e| PackageOpError::TemplateInit {
            copied: vec![],
            cause: format!("read manifest: {e}"),
        })?;
        let template = manifest.template.ok_or_else(|| PackageOpError::TemplateInit {
            copied: vec![],
            cause: "package has no [template] table".into(),
        })?;
        let src_dir = pkg_dir.join(template.path.as_str());
        let mut copied = Vec::new();
        std::fs::create_dir_all(dest).map_err(|e| PackageOpError::TemplateInit {
            copied: copied.clone(),
            cause: format!("create dest: {e}"),
        })?;
        copy_tree(&src_dir, dest, &mut copied, overwrite).map_err(|e| PackageOpError::TemplateInit {
            copied,
            cause: e,
        })?;
        Ok(template.entrypoint.to_string())
    }

    /// Build the `#import "@preview/name:version": *` snippet.
    pub fn import_snippet(name: &str, version: &str) -> String {
        format!("#import \"@preview/{name}:{version}\": *")
    }

    /// Read a cached package's README (markdown or plain). `None` when the
    /// package isn't cached or has no README.
    pub fn get_readme(&self, name: &str, version: &str) -> Option<String> {
        let dir = self.package_dir(name, version)?;
        for cand in ["README.md", "README.markdown", "README", "readme.md"] {
            if let Ok(text) = std::fs::read_to_string(dir.join(cand)) {
                return Some(text);
            }
        }
        None
    }
}

/// Apply a `CatalogFilter` to a catalog snapshot.
fn filter_catalog(cat: &Catalog, filter: &CatalogFilter, latest_only: bool) -> Vec<PackageEntry> {
    let source: &[PackageEntry] = if latest_only { &cat.latest } else { &cat.all };
    let query = filter.query.as_deref().map(|s| s.to_ascii_lowercase());
    let only_templates = filter.only_templates == Some(true);
    let only_packages = filter.only_packages == Some(true);
    let mut out: Vec<PackageEntry> = source
        .iter()
        .filter(|e| {
            if only_templates && !e.is_template() {
                return false;
            }
            if only_packages && e.is_template() {
                return false;
            }
            if !filter.categories.is_empty()
                && !e.categories.iter().any(|c| filter.categories.contains(c))
            {
                return false;
            }
            if let Some(q) = &query {
                let hay = format!(
                    "{} {} {} {}",
                    e.name,
                    e.description.as_deref().unwrap_or(""),
                    e.keywords.join(" "),
                    e.authors.join(" ")
                )
                .to_ascii_lowercase();
                if !hay.contains(q) {
                    return false;
                }
            }
            true
        })
        .cloned()
        .collect();
    out.sort_by(|a, b| (a.is_template(), &a.name).cmp(&(b.is_template(), &b.name)));
    out
}

fn dir_size(path: &Path) -> u64 {
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

fn has_template_table(pkg_dir: &Path) -> bool {
    read_manifest(pkg_dir)
        .map(|m| m.template.is_some())
        .unwrap_or(false)
}

fn read_manifest(pkg_dir: &Path) -> Result<typst::syntax::package::PackageManifest, String> {
    let text = std::fs::read_to_string(pkg_dir.join("typst.toml"))
        .map_err(|e| format!("read typst.toml: {e}"))?;
    toml::from_str(&text).map_err(|e| format!("parse typst.toml: {e}"))
}

fn copy_tree(
    src: &Path,
    dest: &Path,
    copied: &mut Vec<PathBuf>,
    overwrite: bool,
) -> Result<(), String> {
    for entry in walkdir::WalkDir::new(src).into_iter() {
        let entry = entry.map_err(|e| e.to_string())?;
        let rel = entry.path().strip_prefix(src).map_err(|e| e.to_string())?;
        let target = dest.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else {
            if target.exists() && !overwrite {
                return Err(format!("refusing to overwrite existing file: {}", target.display()));
            }
            std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
            copied.push(target);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::package_catalog::TemplateMeta;

    #[test]
    fn import_snippet_uses_exact_version_and_wildcard_target() {
        assert_eq!(
            PackageService::import_snippet("cetz", "0.4.0"),
            "#import \"@preview/cetz:0.4.0\": *"
        );
    }

    #[test]
    fn filter_only_templates() {
        let mk = |name: &str, t: bool| PackageEntry {
            name: name.into(),
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
            template: t.then(|| TemplateMeta {
                path: "t".into(),
                entrypoint: "main.typ".into(),
                thumbnail: None,
            }),
        };
        let cat = Catalog {
            latest: vec![mk("alpha", true), mk("beta", false), mk("gamma", true)],
            all: vec![],
            fetched_at: None,
        };
        let f = CatalogFilter { only_templates: Some(true), ..Default::default() };
        let out = filter_catalog(&cat, &f, true);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|e| e.is_template()));
    }

    #[test]
    fn filter_query_matches_name_or_description() {
        let mk = |name: &str, desc: Option<&str>| PackageEntry {
            name: name.into(),
            version: "0.1.0".into(),
            entrypoint: "lib.typ".into(),
            description: desc.map(String::from),
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
        let cat = Catalog {
            latest: vec![
                mk("cetz", Some("Vector graphics")),
                mk("blah", Some("unrelated")),
            ],
            all: vec![],
            fetched_at: None,
        };
        let f = CatalogFilter { query: Some("vector".into()), ..Default::default() };
        let out = filter_catalog(&cat, &f, true);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "cetz");
    }

    #[test]
    fn read_manifest_parses_typst_toml() {
        let tmp = std::env::temp_dir().join(format!("ts-pkg-manifest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(
            tmp.join("typst.toml"),
            r#"
[package]
name = "demo"
version = "0.1.0"
entrypoint = "lib.typ"

[template]
path = "template"
entrypoint = "main.typ"
thumbnail = "thumbnail.png"
"#,
        )
        .unwrap();
        let m = read_manifest(&tmp).unwrap();
        assert_eq!(m.package.name, "demo");
        assert!(m.template.is_some());
        assert_eq!(m.template.unwrap().thumbnail.as_deref(), Some("thumbnail.png"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn copy_tree_aborts_on_existing_file_without_overwrite() {
        let tmp = std::env::temp_dir().join(format!("ts-copy-{}", uuid::Uuid::new_v4()));
        let src = tmp.join("src");
        let dest = tmp.join("dest");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.typ"), "x").unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("a.typ"), "EXISTING").unwrap();
        let mut copied = Vec::new();
        let res = copy_tree(&src, &dest, &mut copied, false);
        assert!(res.is_err(), "must abort when a target exists and overwrite is false");
        // The pre-existing file must be untouched on abort.
        assert_eq!(std::fs::read_to_string(dest.join("a.typ")).unwrap(), "EXISTING");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn copy_tree_overwrites_existing_file_when_confirmed() {
        let tmp = std::env::temp_dir().join(format!("ts-copy-{}", uuid::Uuid::new_v4()));
        let src = tmp.join("src");
        let dest = tmp.join("dest");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.typ"), "NEW").unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("a.typ"), "EXISTING").unwrap();
        let mut copied = Vec::new();
        copy_tree(&src, &dest, &mut copied, true).expect("overwrite=true must succeed");
        // The file is now the template's content, and it's recorded as copied.
        assert_eq!(std::fs::read_to_string(dest.join("a.typ")).unwrap(), "NEW");
        assert_eq!(copied.len(), 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
