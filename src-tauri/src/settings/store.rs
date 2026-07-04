//! JSON file-backed store for the runtime `serde_json::Value` config document.
//!
//! The dynamic settings model has no fixed schema, so the store reads/writes a
//! free-form JSON document rather than a typed struct. A missing file or parse
//! error degrades to an empty object (`{}`); callers then fall back to the
//! manifest defaults. [`SettingsService`](super::service::SettingsService)
//! owns a `JsonFileStore` directly — no trait is needed for a single impl.

use std::path::PathBuf;

use crate::error::Result;

/// Persists the runtime config as pretty-printed JSON at a fixed path.
pub struct JsonFileStore {
    pub path: PathBuf,
}

impl JsonFileStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Load the document. A missing file or read/parse error yields an empty
    /// object so a fresh install behaves like an unconfigured one.
    pub fn load_value(&self) -> serde_json::Value {
        if !self.path.exists() {
            return serde_json::json!({});
        }
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(s) => s,
            Err(_) => return serde_json::json!({}),
        };
        serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}))
    }

    /// Write the document, creating parent directories as needed.
    pub fn save_value(&self, value: &serde_json::Value) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Atomic write (§5.2): settings.json is overwritten in place, so use
        // the temp-file-then-rename protocol to avoid corruption on crash.
        crate::persistence::atomic::write_json(&self.path, value)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path() -> PathBuf {
        std::env::temp_dir().join(format!("typst-settings-{}.json", uuid::Uuid::new_v4()))
    }

    #[test]
    fn missing_file_loads_empty_object() {
        let store = JsonFileStore::new(tmp_path());
        assert_eq!(store.load_value(), serde_json::json!({}));
    }

    #[test]
    fn save_then_load_roundtrips() {
        let path = tmp_path();
        let store = JsonFileStore::new(path.clone());
        let doc = serde_json::json!({ "editor": { "fontSize": 14 } });
        store.save_value(&doc).unwrap();
        assert_eq!(store.load_value(), doc);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn garbage_file_loads_empty_object() {
        let path = tmp_path();
        std::fs::write(&path, "{ not json").unwrap();
        let store = JsonFileStore::new(path.clone());
        assert_eq!(store.load_value(), serde_json::json!({}));
        let _ = std::fs::remove_file(&path);
    }
}
