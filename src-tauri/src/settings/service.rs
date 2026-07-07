//! `SettingsService` — the dynamic JSON configuration store with manifest
//! validation.
//!
//! Mirrors the [`WorkspaceService`](crate::service::workspace_service::WorkspaceService)
//! pattern: runtime state behind a `parking_lot::RwLock`, persistence via
//! [`JsonFileStore`], and an `on_change` callback that decouples broadcast (the
//! IPC layer wires it to `app.emit("settings_changed", ..)`).
//!
//! Reads/writes are path-based (`editor.fontSize`) and translate to JSON
//! pointers (`/editor/fontSize`) internally. There is no typed schema: the
//! runtime document is a free-form `serde_json::Value`, and `set` validates
//! every write against the embedded [`Manifest`].

use parking_lot::RwLock;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{AppError, Result};

use super::manifest::{Manifest, SettingDef};
use super::store::JsonFileStore;

/// The settings orchestration service.
pub struct SettingsService {
    /// The full runtime config document.
    data: RwLock<Value>,
    /// Build-time-embedded catalog of known settings + defaults/constraints.
    manifest: Manifest,
    /// Persistence handle.
    store: JsonFileStore,
    /// Fired with the full document after every successful `set`. The IPC
    /// layer wires this to a Tauri `settings_changed` broadcast.
    on_change: Box<dyn Fn(&Value) + Send + Sync>,
}

impl SettingsService {
    pub fn new(
        store: JsonFileStore,
        manifest: Manifest,
        on_change: impl Fn(&Value) + Send + Sync + 'static,
    ) -> Result<Self> {
        let data = store.load_value();
        Ok(Self {
            data: RwLock::new(data),
            manifest,
            store,
            on_change: Box::new(on_change),
        })
    }

    /// The full runtime config document (a deep clone).
    pub fn get_all(&self) -> Value {
        self.data.read().clone()
    }

    /// Borrow the embedded manifest.
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// Read a path, returning `default` when missing or type-mismatched.
    pub fn get<T: DeserializeOwned>(&self, path: &str, default: T) -> T {
        let ptr = dotted_to_pointer(path);
        let val = self.data.read().pointer(&ptr).cloned();
        match val {
            Some(v) => match serde_json::from_value::<T>(v) {
                Ok(t) => t,
                Err(_) => default,
            },
            None => default,
        }
    }

    /// Read a path, defaulting to the manifest's `default` for that key.
    /// Panics only if `path` is not a known manifest key (programmer error) or
    /// its manifest default does not deserialize into `T`.
    pub fn get_or_default<T: DeserializeOwned>(&self, path: &str) -> T {
        let dv = self
            .manifest
            .find(path)
            .map(|d| d.default.clone())
            .unwrap_or(Value::Null);
        let default = serde_json::from_value::<T>(dv)
            .expect("get_or_default: manifest default does not match requested type");
        self.get(path, default)
    }

    /// Validate against the manifest, write into the document, persist, and
    /// broadcast. Unknown keys and constraint violations return `AppError`.
    pub fn set(&self, path: &str, value: Value) -> Result<()> {
        let def = self
            .manifest
            .find(path)
            .ok_or_else(|| AppError::InvalidInput(format!("unknown setting key: {path}")))?;
        if def
            .extra
            .get("readonly")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return Err(AppError::InvalidInput(format!(
                "setting '{path}' is readonly"
            )));
        }
        validate(def, &value)?;

        // Apply, then clone a snapshot so persistence/broadcast happen outside
        // the write lock (no IO or reentrant reads under the guard).
        let snapshot = {
            let mut guard = self.data.write();
            set_pointer(&mut guard, path, value);
            guard.clone()
        };
        self.store.save_value(&snapshot)?;
        (self.on_change)(&snapshot);
        Ok(())
    }
}

/// Convert a dotted key (`editor.fontSize`) to a JSON pointer (`/editor/fontSize`).
fn dotted_to_pointer(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 1);
    for seg in path.split('.') {
        out.push('/');
        // The manifest keys never contain `~` or `/`, so JSON-pointer escape
        // rules (~0 / ~1) don't apply here. `include_str`'d keys are trusted.
        out.push_str(seg);
    }
    out
}

/// Write `value` at the dotted `path` inside `root`, creating intermediate
/// objects as needed. `serde_json::Value::pointer` is read-only, so we walk the
/// segments ourselves.
fn set_pointer(root: &mut Value, dotted: &str, value: Value) {
    let segments: Vec<&str> = dotted.split('.').collect();
    if segments.is_empty() {
        return;
    }
    let last = segments.len() - 1;
    let mut cur = root;
    for (i, seg) in segments.iter().enumerate() {
        if !cur.is_object() {
            *cur = Value::Object(serde_json::Map::new());
        }
        let map = cur.as_object_mut().expect("ensured to be an object");
        if i == last {
            map.insert((*seg).to_string(), value);
            return;
        }
        if !map.contains_key(*seg) {
            map.insert((*seg).to_string(), Value::Object(serde_json::Map::new()));
        }
        cur = map
            .get_mut(*seg)
            .expect("inserted missing intermediate object");
    }
}

/// Type + constraint validation for one setting write.
fn validate(def: &SettingDef, value: &Value) -> Result<()> {
    let key = def.key.as_str();
    match def.setting_type.as_str() {
        "number" => {
            let f = value
                .as_f64()
                .ok_or_else(|| AppError::InvalidInput(format!("{key} expects a number")))?;
            check_range(&def.extra, key, f)?;
        }
        "integer" => {
            let f = value
                .as_f64()
                .ok_or_else(|| AppError::InvalidInput(format!("{key} expects an integer")))?;
            if f.fract() != 0.0 {
                return Err(AppError::InvalidInput(format!(
                    "{key} expects an integer value"
                )));
            }
            check_range(&def.extra, key, f)?;
        }
        "string" => {
            if !value.is_string() {
                return Err(AppError::InvalidInput(format!(
                    "{key} expects a string"
                )));
            }
        }
        // `font` and `path` are string-valued (font family name / filesystem
        // path) but rendered with specialized pickers. We don't whitelist the
        // value set: a `font` may be a system font not present on this machine
        // (e.g. a config carried over from another OS), and a `path` may point
        // anywhere the OS allows. Empty string = "unset" (use the default
        // stack / no path). Only the type is enforced here.
        "font" | "path" => {
            if !value.is_string() {
                return Err(AppError::InvalidInput(format!(
                    "{key} expects a string"
                )));
            }
        }
        "boolean" => {
            if value.as_bool().is_none() {
                return Err(AppError::InvalidInput(format!(
                    "{key} expects a boolean"
                )));
            }
        }
        "paths" => {
            let arr = value.as_array().ok_or_else(|| {
                AppError::InvalidInput(format!("{key} expects an array of strings"))
            })?;
            if !arr.iter().all(|v| v.is_string()) {
                return Err(AppError::InvalidInput(format!(
                    "{key} expects an array of strings"
                )));
            }
        }
        "select" => {
            let s = value
                .as_str()
                .ok_or_else(|| AppError::InvalidInput(format!("{key} expects a string")))?;
            // `dynamicOptions` marks selects whose valid value set is defined
            // elsewhere at runtime (e.g. `appearance.theme`, whose ids come from
            // ThemeService — built-ins + disk discovery — not this manifest
            // list). For those we skip the static options whitelist (still
            // requiring a non-empty string); the runtime source is authoritative.
            if def
                .extra
                .get("dynamicOptions")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                if s.is_empty() {
                    return Err(AppError::InvalidInput(format!(
                        "{key} expects a non-empty string"
                    )));
                }
                return Ok(());
            }
            let opts = def.extra.get("options").and_then(|v| v.as_array()).ok_or_else(
                || AppError::InvalidInput(format!("{key} has no options defined")),
            )?;
            let valid = opts.iter().filter_map(|v| v.as_str()).any(|o| o == s);
            if !valid {
                return Err(AppError::InvalidInput(format!(
                    "{key} '{s}' is not a valid option"
                )));
            }
        }
        other => {
            return Err(AppError::InvalidInput(format!(
                "unknown setting type '{other}' for {key}"
            )));
        }
    }
    Ok(())
}

/// Enforce manifest `min`/`max` (stored in `extra`) for numeric types.
fn check_range(extra: &serde_json::Map<String, Value>, key: &str, f: f64) -> Result<()> {
    if let Some(min) = extra.get("min").and_then(|v| v.as_f64()) {
        if f < min {
            return Err(AppError::InvalidInput(format!("{key} must be >= {min}")));
        }
    }
    if let Some(max) = extra.get("max").and_then(|v| v.as_f64()) {
        if f > max {
            return Err(AppError::InvalidInput(format!("{key} must be <= {max}")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex as StdMutex};

    fn tmp_store() -> JsonFileStore {
        let p = std::env::temp_dir().join(format!("typst-settings-{}.json", uuid::Uuid::new_v4()));
        JsonFileStore::new(p)
    }

    fn make_service() -> SettingsService {
        SettingsService::new(tmp_store(), Manifest::embedded(), |_| {}).unwrap()
    }

    #[test]
    fn pointer_conversion() {
        assert_eq!(dotted_to_pointer("editor.fontSize"), "/editor/fontSize");
        assert_eq!(dotted_to_pointer("a.b.c"), "/a/b/c");
        assert_eq!(dotted_to_pointer("compiler.debounceMs"), "/compiler/debounceMs");
    }

    #[test]
    fn get_returns_explicit_default_when_unset() {
        let svc = make_service();
        let n: i64 = svc.get("editor.fontSize", 99);
        assert_eq!(n, 99);
    }

    #[test]
    fn get_or_default_uses_manifest() {
        let svc = make_service();
        let n: f64 = svc.get_or_default("preview.zoomLevel");
        assert!((n - 1.0).abs() < 1e-9);
        let b: bool = svc.get_or_default("editor.wordWrap");
        assert!(!b);
    }

    #[test]
    fn set_and_get_roundtrip() {
        let svc = make_service();
        svc.set("editor.fontSize", json!(20)).unwrap();
        let n: i64 = svc.get("editor.fontSize", 0);
        assert_eq!(n, 20);
    }

    #[test]
    fn set_nested_does_not_clobber_siblings() {
        let svc = make_service();
        svc.set("editor.fontSize", json!(14)).unwrap();
        svc.set("editor.wordWrap", json!(true)).unwrap();
        let fs: i64 = svc.get("editor.fontSize", 0);
        let ww: bool = svc.get("editor.wordWrap", false);
        assert_eq!(fs, 14);
        assert!(ww);
    }

    #[test]
    fn set_creates_intermediate_objects() {
        let svc = make_service();
        svc.set("editor.fontSize", json!(16)).unwrap();
        let all = svc.get_all();
        // The full nested object exists.
        assert_eq!(all.pointer("/editor/fontSize"), Some(&json!(16)));
    }

    #[test]
    fn set_rejects_unknown_key() {
        let svc = make_service();
        assert!(svc.set("nope.nope", json!(1)).is_err());
    }

    #[test]
    fn set_rejects_wrong_type() {
        let svc = make_service();
        assert!(svc.set("editor.fontSize", json!("big")).is_err());
        assert!(svc.set("editor.wordWrap", json!("yes")).is_err());
        assert!(svc.set("preview.background", json!(5)).is_err());
    }

    #[test]
    fn set_rejects_out_of_range() {
        let svc = make_service();
        assert!(svc.set("editor.fontSize", json!(999)).is_err());
        assert!(svc.set("editor.fontSize", json!(1)).is_err());
        assert!(svc.set("compiler.debounceMs", json!(-5)).is_err());
    }

    #[test]
    fn set_rejects_non_integer_for_integer() {
        let svc = make_service();
        assert!(svc.set("compiler.debounceMs", json!(1.5)).is_err());
    }

    #[test]
    fn set_rejects_invalid_option() {
        let svc = make_service();
        assert!(svc.set("preview.background", json!("purple")).is_err());
        assert!(svc.set("preview.background", json!("light")).is_ok());
    }

    /// `appearance.theme` is a `dynamicOptions` select: its valid value set is
    /// defined at runtime by ThemeService (built-ins + disk discovery), not the
    /// manifest's static `options`. The whitelist must NOT reject ids that only
    /// appear there (built-ins like "carbon-dark", or any user theme), but a
    /// non-string / empty value still fails type validation.
    #[test]
    fn dynamic_options_select_accepts_runtime_ids() {
        let svc = make_service();
        assert!(svc.set("appearance.theme", json!("carbon-dark")).is_ok());
        assert!(svc.set("appearance.theme", json!("my-own-user-theme")).is_ok());
        assert!(svc.set("appearance.theme", json!("default")).is_ok());
        // Type + non-empty checks still apply.
        assert!(svc.set("appearance.theme", json!(5)).is_err());
        assert!(svc.set("appearance.theme", json!("")).is_err());
    }

    #[test]
    fn set_rejects_paths_with_non_strings() {
        let svc = make_service();
        assert!(svc.set("compiler.extraFontDirs", json!(["/a", 3])).is_err());
        assert!(svc.set("compiler.extraFontDirs", json!(["/a", "/b"])).is_ok());
    }

    /// `font` is a string-valued type (rendered as a font picker). Any string
    /// is accepted — including one not on this machine (a config ported from
    /// another OS) and the empty string (= unset, use the default stack). Only
    /// the type is enforced; no whitelist.
    #[test]
    fn font_setting_accepts_string() {
        let svc = make_service();
        assert!(svc.set("editor.fontFamily", json!("Fira Code")).is_ok());
        // Empty string = unset.
        assert!(svc.set("editor.fontFamily", json!("")).is_ok());
        // A family that doesn't exist on this machine is still stored verbatim;
        // the editor/typst fall back at render time.
        assert!(svc.set("editor.fontFamily", json!("Imaginary Font XYZ")).is_ok());
    }

    #[test]
    fn font_setting_rejects_non_string() {
        let svc = make_service();
        assert!(svc.set("editor.fontFamily", json!(14)).is_err());
        assert!(svc.set("editor.fontFamily", json!(true)).is_err());
        assert!(svc.set("editor.fontFamily", json!(["Fira Code"])).is_err());
    }

    /// `path` is a string-valued type rendered with a native path picker. No
    /// `path` setting exists in the manifest yet (the type ships available but
    /// unused), so we validate directly against a hand-built descriptor rather
    /// than round-tripping through `SettingsService::set` (which would reject
    /// the unknown key).
    #[test]
    fn path_setting_validates_string_values() {
        use super::{validate, SettingDef};
        let def = SettingDef {
            key: "demo.path".into(),
            setting_type: "path".into(),
            label: "Demo".into(),
            default: json!(""),
            extra: serde_json::Map::new(),
        };
        assert!(validate(&def, &json!("/home/user/docs")).is_ok());
        assert!(validate(&def, &json!("")).is_ok()); // empty = unset
        assert!(validate(&def, &json!(42)).is_err());
        assert!(validate(&def, &json!(null)).is_err());
        assert!(validate(&def, &json!([ "/a" ])).is_err());
    }

    #[test]
    fn set_rejects_readonly() {
        let svc = make_service();
        assert!(svc.set("window.recentWorkspaces", json!(["/x"])).is_err());
    }

    #[test]
    fn empty_config_loads_ok() {
        // Missing file -> {} -> service constructs fine; manifest defaults apply.
        let svc = make_service();
        assert!(svc.get_all().is_object());
    }

    #[test]
    fn on_change_fires_after_set() {
        let fired = Arc::new(StdMutex::new(false));
        let f = Arc::clone(&fired);
        let svc = SettingsService::new(tmp_store(), Manifest::embedded(), move |_| {
            *f.lock().unwrap() = true;
        })
        .unwrap();
        assert!(*fired.lock().unwrap() == false);
        svc.set("editor.fontSize", json!(16)).unwrap();
        assert!(*fired.lock().unwrap());
    }

    #[test]
    fn set_persists_to_disk() {
        let store = tmp_store();
        let path = store.path.clone();
        let svc = SettingsService::new(store, Manifest::embedded(), |_| {}).unwrap();
        svc.set("editor.fontSize", json!(24)).unwrap();
        // A fresh service over the same file sees the persisted value.
        let svc2 = SettingsService::new(JsonFileStore::new(path.clone()), Manifest::embedded(), |_| {}).unwrap();
        let n: i64 = svc2.get("editor.fontSize", 0);
        assert_eq!(n, 24);
        let _ = std::fs::remove_file(&path);
    }
}
