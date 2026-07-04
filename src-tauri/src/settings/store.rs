//! JSON file-backed store for the runtime `serde_json::Value` config document.
//!
//! The dynamic settings model has no fixed schema, so the store reads/writes a
//! free-form JSON document rather than a typed struct. A missing file or parse
//! error degrades to an empty object (`{}`); callers then fall back to the
//! manifest defaults. [`SettingsService`](super::service::SettingsService)
//! owns a `JsonFileStore` directly — no trait is needed for a single impl.
//!
//! ## Crash/corrupt recovery (§5.2)
//! On load the main file is read first; if it is missing or corrupt we fall
//! back to `settings.json.bak` (the last known-good, rotated by every save),
//! and a corrupt main is quarantined to `*.corrupt-<ts>.json` for diagnosis.
//! Both main and `.bak` missing/corrupt yields `{}` (defaults). Every save
//! rotates the previous content into the `.bak`.
//!
//! ## schemaVersion (§7.3)
//! Settings is a free-form document (no typed struct), so there is no
//! `Migrator<Settings>` the way there is for `Session`. Instead, on load the
//! top-level `schemaVersion` key is added if absent (defaulting to 0), and a
//! migration **hook** is exposed ([`migrate_settings_value`]) for future use.
//! Today it is a version tag + a no-op hook point: real migrations happen as
//! the documented settings schema evolves (e.g. renaming/retiring keys).

use std::path::PathBuf;

use crate::error::Result;
use crate::persistence::{load_json_with_backup, write_with_backup, LoadOutcome};

/// The current settings schema version (§7.3). A free-form Value has no rigid
/// shape to migrate today, so this is primarily a version tag for future
/// structured migrations; it defaults to 0 in old/absent files.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Persists the runtime config as pretty-printed JSON at a fixed path.
pub struct JsonFileStore {
    pub path: PathBuf,
}

impl JsonFileStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Load the document with `.bak` fallback (§5.2). A missing file, a corrupt
    /// main with a usable `.bak`, or both missing/corrupt all degrade to an
    /// empty object so a fresh install behaves like an unconfigured one. The
    /// returned object always carries a top-level `schemaVersion` (added if
    /// absent; §7.3), and the migration hook has been run (today a no-op).
    pub fn load_value(&self) -> serde_json::Value {
        let mut value = match load_json_with_backup(&self.path, |s: &str| {
            serde_json::from_str::<serde_json::Value>(s)
        }) {
            Ok(LoadOutcome::Primary(v)) => v,
            Ok(LoadOutcome::RestoredFromBackup { value, corrupt_path }) => {
                tracing::warn!(
                    path = ?self.path, ?corrupt_path,
                    "settings: main corrupt; restored from .bak (corrupt copy preserved)",
                );
                value
            }
            Ok(LoadOutcome::MissingOrUnrecoverable) => {
                // Both missing/corrupt → fresh install / unrecoverable. Empty
                // object (defaults applied by callers).
                serde_json::json!({})
            }
            // A read error on an existing file (e.g. permission denied) with no
            // usable .bak. Don't abort startup over settings → degrade to {}.
            Err(e) => {
                tracing::warn!(
                    path = ?self.path, error = %e,
                    "settings: load failed; degrading to empty object",
                );
                serde_json::json!({})
            }
        };

        // Ensure the document is an object we can attach schemaVersion to. A
        // non-object settings file (rare, but hand-edited) is tolerated by
        // wrapping; this keeps the version-tag invariant without dropping the
        // user's data.
        ensure_object_with_schema_version(&mut value);
        migrate_settings_value(&mut value);
        value
    }

    /// Write the document, creating parent directories as needed, and rotate
    /// the previous known-good into `settings.json.bak` (§5.2).
    pub fn save_value(&self, value: &serde_json::Value) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Serialize once; write_with_backup writes the main atomically AND
        // rotates the previous content into the .bak.
        let bytes = serde_json::to_vec_pretty(value)?;
        write_with_backup(&self.path, &bytes)?;
        Ok(())
    }
}

/// Ensure `value` is a JSON object carrying a top-level `schemaVersion` key.
/// A non-object value is wrapped as `{"value": <orig>}` so we never drop the
/// user's data; a missing `schemaVersion` defaults to `0` (pre-versioning).
/// Mutates in place.
fn ensure_object_with_schema_version(value: &mut serde_json::Value) {
    if !value.is_object() {
        // Wrap rather than discard (could be a hand-edited array/scalar).
        let original = std::mem::take(value);
        *value = serde_json::json!({ "value": original });
    }
    let obj = value.as_object_mut().expect("wrapped to object above");
    if !obj.contains_key("schemaVersion") {
        obj.insert(
            "schemaVersion".to_string(),
            serde_json::Value::from(0u32),
        );
    }
}

/// Settings migration hook (§7.3). Runs registered transforms based on the
/// document's `schemaVersion`. Today there are no structured settings
/// migrations — settings is free-form Value, so this is a version tag and a
/// future hook point. It does ensure the on-disk tag advances to current on
/// the next save (the caller writes whatever `load_value` returned).
fn migrate_settings_value(value: &mut serde_json::Value) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    let current = obj
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .unwrap_or(0);
    if current < CURRENT_SCHEMA_VERSION {
        // No structured migration steps yet. Real migrations go here as the
        // documented settings schema evolves (rename/retire keys, etc.).
        obj.insert(
            "schemaVersion".to_string(),
            serde_json::Value::from(CURRENT_SCHEMA_VERSION),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path() -> PathBuf {
        std::env::temp_dir().join(format!("typst-settings-{}.json", uuid::Uuid::new_v4()))
    }

    /// Canonicalized temp dir (macOS `/var` → `/private/var`).
    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("typst-settings-it-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::domain::path::canonicalize_for_identity(&dir)
            .unwrap_or_else(|_| dir.canonicalize().unwrap_or(dir))
    }

    #[test]
    fn missing_file_loads_empty_object() {
        let store = JsonFileStore::new(tmp_path());
        let v = store.load_value();
        // Empty + schemaVersion present.
        assert!(v.is_object());
        assert_eq!(v["schemaVersion"], CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let path = tmp_path();
        let store = JsonFileStore::new(path.clone());
        let doc = serde_json::json!({ "editor": { "fontSize": 14 } });
        store.save_value(&doc).unwrap();
        let loaded = store.load_value();
        assert_eq!(loaded["editor"]["fontSize"], 14, "user data must round-trip");
        assert_eq!(loaded["schemaVersion"], CURRENT_SCHEMA_VERSION);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn garbage_file_loads_empty_object() {
        let path = tmp_path();
        std::fs::write(&path, "{ not json").unwrap();
        let store = JsonFileStore::new(path.clone());
        let v = store.load_value();
        assert!(v.is_object(), "garbage must degrade to an object");
        assert_eq!(v["schemaVersion"], CURRENT_SCHEMA_VERSION);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_adds_schemaversion_to_old_file() {
        // A pre-versioning settings.json (no schemaVersion) must load and get
        // the tag added.
        let dir = tmp_dir();
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{"editor":{"fontSize":12}}"#).unwrap();
        let store = JsonFileStore::new(path);
        let v = store.load_value();
        assert_eq!(v["editor"]["fontSize"], 12);
        assert_eq!(v["schemaVersion"], CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn corrupt_main_falls_back_to_bak() {
        let dir = tmp_dir();
        let path = dir.join("settings.json");
        let bak = path.with_extension("json.bak");
        // Good .bak, garbage main.
        std::fs::write(&bak, r#"{"editor":{"fontSize":99}}"#).unwrap();
        std::fs::write(&path, "{ broken").unwrap();

        let store = JsonFileStore::new(path.clone());
        let v = store.load_value();
        assert_eq!(v["editor"]["fontSize"], 99, "should restore .bak content");
        assert_eq!(v["schemaVersion"], CURRENT_SCHEMA_VERSION);
        assert!(!path.exists(), "corrupt main must have been quarantined");
    }

    #[test]
    fn save_rotates_previous_to_bak() {
        let dir = tmp_dir();
        let path = dir.join("settings.json");
        let bak = path.with_extension("json.bak");
        let store = JsonFileStore::new(path.clone());

        store.save_value(&serde_json::json!({ "a": 1 })).unwrap();
        assert!(!bak.exists(), "first save: no .bak yet");
        store.save_value(&serde_json::json!({ "a": 2 })).unwrap();
        // Parse both back rather than substring-match (pretty-print spacing is
        // fiddly); what matters is main = latest, bak = previous.
        let main: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let bak_val: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&bak).unwrap()).unwrap();
        assert_eq!(main["a"], 2, "main must hold the latest write");
        assert_eq!(bak_val["a"], 1, ".bak must hold the previous write");
    }

    #[test]
    fn non_object_load_is_wrapped_not_discarded() {
        // A hand-edited scalar/array should not be silently dropped: it's
        // wrapped under "value" and gets a schemaVersion tag.
        let dir = tmp_dir();
        let path = dir.join("settings.json");
        std::fs::write(&path, "[1, 2, 3]").unwrap();
        let store = JsonFileStore::new(path);
        let v = store.load_value();
        assert_eq!(v["value"], serde_json::json!([1, 2, 3]));
        assert_eq!(v["schemaVersion"], CURRENT_SCHEMA_VERSION);
    }
}
