//! The Universe `index.json` cache lifecycle.
//!
//! Completely isolated from typst-kit's package-download path: this is
//! presentation data only (never participates in compilation). Fetch goes
//! through the shared async [`HttpClient`](crate::net::client::HttpClient);
//! the cache lives under the app's private config dir (NOT typst's own dirs,
//! so uninstalling one tool never disturbs the other).
//!
//! See docs/superpowers/specs/2026-07-07-packages-templates-design.md §3.2.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;

use crate::domain::package_catalog::PackageEntry;
use crate::net::client::{FetchOptions, HttpClient};

/// The canonical registry index URL.
pub const INDEX_URL: &str = "https://packages.typst.org/preview/index.json";

/// Why an index refresh failed.
#[derive(Debug)]
pub enum IndexFetchError {
    Network(crate::net::error::NetError),
    Io(std::io::Error),
    Parse(serde_json::Error),
}

impl std::fmt::Display for IndexFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(e) => write!(f, "network error: {e}"),
            Self::Io(e) => write!(f, "io error: {e}"),
            Self::Parse(e) => write!(f, "parse error: {e}"),
        }
    }
}

impl std::error::Error for IndexFetchError {}

/// In-memory catalog snapshot. `latest` is the deduped-by-highest-version
/// view used for default listing; `all` keeps every entry for the
/// historical-version detail view.
#[derive(Debug, Clone, Default)]
pub struct Catalog {
    /// One entry per name — the highest version.
    pub latest: Vec<PackageEntry>,
    /// Every entry the index has ever reported (all versions). In v1 this is
    /// the same set as `latest` (we only persist the deduped view); kept as a
    /// distinct field so future "show all versions" work has a home.
    pub all: Vec<PackageEntry>,
    /// When the on-disk cache was last fetched (Unix seconds), if known.
    pub fetched_at: Option<i64>,
}

impl Catalog {
    /// Build a `Catalog` from a raw `index.json` byte slice, deduping to the
    /// highest version per name. Unparseable individual versions sort lowest
    /// but never panic; a wholly malformed document errors.
    pub fn from_index_bytes(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        let all: Vec<PackageEntry> = serde_json::from_slice(bytes)?;
        use std::collections::BTreeMap;
        let mut by_name: BTreeMap<String, Vec<PackageEntry>> = BTreeMap::new();
        for e in all {
            by_name.entry(e.name.clone()).or_default().push(e);
        }
        let mut latest = Vec::with_capacity(by_name.len());
        for (_, mut versions) in by_name {
            // Sort descending by parsed version; keep the max. Entries whose
            // version fails to parse sort lowest (stable).
            versions.sort_by(|a, b| cmp_version_desc(&b.version, &a.version));
            if let Some(top) = versions.into_iter().next() {
                latest.push(top);
            }
        }
        latest.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(Self {
            latest: latest.clone(),
            all: latest,
            fetched_at: None,
        })
    }
}

/// Compare two version strings descending. Unparseable versions sort below
/// parseable ones. Used only for "keep latest per name" dedup.
fn cmp_version_desc(a: &str, b: &str) -> std::cmp::Ordering {
    use std::str::FromStr;
    match (
        typst::syntax::package::PackageVersion::from_str(a),
        typst::syntax::package::PackageVersion::from_str(b),
    ) {
        (Ok(va), Ok(vb)) => va.cmp(&vb),
        (Ok(_), Err(_)) => std::cmp::Ordering::Greater,
        (Err(_), Ok(_)) => std::cmp::Ordering::Less,
        (Err(_), Err(_)) => a.cmp(b),
    }
}

/// Owns the on-disk index cache + the in-memory `Catalog`. Shared behind an
/// `Arc` (the service wraps it); the `RwLock<Option<Catalog>>` keeps the
/// snapshot cheap to clone.
pub struct PackageIndex {
    http: Arc<HttpClient>,
    cache_path: PathBuf,
    snapshot: RwLock<Option<Catalog>>,
}

impl PackageIndex {
    /// `cache_path` is `<config>/typst-studio/cache/package-index.json`.
    pub fn new(http: Arc<HttpClient>, cache_path: PathBuf) -> Self {
        Self {
            http,
            cache_path,
            snapshot: RwLock::new(None),
        }
    }

    /// Load the on-disk cache into memory if present; return a clone of the
    /// snapshot. Does NOT fetch — call [`refresh`](Self::refresh) for that.
    /// Subsequent calls are cheap (in-memory snapshot reused).
    pub fn load_cached(&self) -> Option<Catalog> {
        if let Some(snap) = self.snapshot.read().clone() {
            return Some(snap);
        }
        let bytes = std::fs::read(&self.cache_path).ok()?;
        match Catalog::from_index_bytes(&bytes) {
            Ok(mut cat) => {
                cat.fetched_at = std::fs::metadata(&self.cache_path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64);
                *self.snapshot.write() = Some(cat.clone());
                Some(cat)
            }
            Err(_) => None,
        }
    }

    /// Fetch the live index, write it to disk, refresh the in-memory snapshot.
    /// Returns the new snapshot.
    pub async fn refresh(&self) -> Result<Catalog, IndexFetchError> {
        let bytes = self
            .http
            .fetch_bytes(
                INDEX_URL,
                &FetchOptions {
                    // index.json is ~2MB; allow headroom.
                    max_bytes: 16 * 1024 * 1024,
                    ..FetchOptions::default()
                },
            )
            .await
            .map_err(IndexFetchError::Network)?;
        if let Some(parent) = self.cache_path.parent() {
            std::fs::create_dir_all(parent).map_err(IndexFetchError::Io)?;
        }
        std::fs::write(&self.cache_path, &bytes).map_err(IndexFetchError::Io)?;
        let mut cat = Catalog::from_index_bytes(&bytes).map_err(IndexFetchError::Parse)?;
        cat.fetched_at = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        );
        *self.snapshot.write() = Some(cat.clone());
        Ok(cat)
    }

    /// Path used for the on-disk cache (exposed for diagnostics/tests).
    pub fn cache_path(&self) -> &Path {
        &self.cache_path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupes_to_latest_version_per_name() {
        let raw = r#"[
            {"name":"abbr","version":"0.1.0","entrypoint":"lib.typ","updatedAt":1},
            {"name":"abbr","version":"0.3.0","entrypoint":"lib.typ","updatedAt":2},
            {"name":"abbr","version":"0.2.0","entrypoint":"lib.typ","updatedAt":3},
            {"name":"cetz","version":"0.4.0","entrypoint":"lib.typ","updatedAt":4}
        ]"#;
        let cat = Catalog::from_index_bytes(raw.as_bytes()).unwrap();
        let names: Vec<&str> = cat.latest.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["abbr", "cetz"]);
        let abbr = cat.latest.iter().find(|e| e.name == "abbr").unwrap();
        assert_eq!(abbr.version, "0.3.0", "highest version wins");
    }

    #[test]
    fn unparseable_version_does_not_panic() {
        let raw = r#"[{"name":"x","version":"weird","entrypoint":"lib.typ","updatedAt":1}]"#;
        let cat = Catalog::from_index_bytes(raw.as_bytes()).unwrap();
        assert_eq!(cat.latest.len(), 1);
        assert_eq!(cat.latest[0].version, "weird");
    }

    #[test]
    fn missing_updated_at_defaults_to_zero() {
        // Older entries may omit updatedAt; must not fail deserialization.
        let raw = r#"[{"name":"x","version":"0.1.0","entrypoint":"lib.typ"}]"#;
        let cat = Catalog::from_index_bytes(raw.as_bytes()).unwrap();
        assert_eq!(cat.latest[0].updated_at, 0);
    }

    #[test]
    fn malformed_json_errors() {
        let res = Catalog::from_index_bytes(b"not json");
        assert!(res.is_err());
    }
}
