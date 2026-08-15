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

use parking_lot::{Mutex, RwLock};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{AppError, Result};

use super::manifest::{Manifest, SettingDef};
use super::store::JsonFileStore;

/// The settings orchestration service.
pub struct SettingsService {
    /// The full runtime config document.
    data: RwLock<Value>,
    /// Serializes `set` writers across their whole clone→mutate→save (+
    /// rollback) sequence. Without it two racing `set`s interleave: a failed
    /// save's rollback could restore a stale whole-document clone and erase a
    /// concurrent successful write from memory (while disk and `on_change`
    /// announced it), and a snapshot taken before another writer's mutation
    /// could be persisted over it (lost update). Plain sync mutex — the
    /// critical section is short and contains no awaits. `data` stays a
    /// `RwLock` so `get`/`get_all` never contend with it.
    write_lock: Mutex<()>,
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
            write_lock: Mutex::new(()),
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

        // Serialize against other `set` calls for the whole mutate+save
        // sequence (see `write_lock`): the snapshot is taken and persisted
        // atomically w.r.t. other writers, so a save can neither clobber a
        // concurrent writer's key from disk nor roll memory back past one.
        // The callback fires after the guard is dropped — `on_change` stays
        // reentrancy-safe (it may probe `get`/`set` itself).
        let snapshot = {
            let _writer = self.write_lock.lock();
            // Apply, then clone a snapshot so persistence/broadcast happen
            // outside the document write lock (no IO or reentrant reads under
            // that guard). The pre-mutation document is cloned too, so a
            // failed save can roll the in-memory state back — otherwise later
            // `get`s would serve a value that was never persisted (and
            // `on_change` never fired for it).
            let (snapshot, previous) = {
                let mut guard = self.data.write();
                let previous = guard.clone();
                set_pointer(&mut guard, path, value);
                (guard.clone(), previous)
            };
            if let Err(e) = self.store.save_value(&snapshot) {
                // Persistence failed: restore the pre-mutation document so
                // memory keeps matching what's on disk. Writers are
                // serialized, so `previous` is exactly the last state that
                // was handed to `save_value`.
                *self.data.write() = previous;
                return Err(e);
            }
            snapshot
        };
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
        // `keybinding` is a string-valued VS Code / Tauri accelerator, e.g.
        // "CmdOrCtrl+Shift+P" or "Ctrl+B". Empty string = "disabled" (no
        // shortcut bound) and is allowed. A non-empty value must parse to
        // exactly one main key plus zero or more modifiers — a bare
        // "Ctrl+Shift" (no key) or a malformed "Ctrl++B" is rejected. This
        // mirrors the frontend parseKeybinding; we keep the Rust check lighter
        // (no per-platform CmdOrCtrl resolution) since the frontend re-validates
        // at match time.
        "keybinding" => {
            let s = value.as_str().ok_or_else(|| {
                AppError::InvalidInput(format!("{key} expects a string"))
            })?;
            if !validate_keybinding(s) {
                return Err(AppError::InvalidInput(format!(
                    "{key} '{s}' is not a valid keybinding (use e.g. 'Ctrl+B'; empty to disable)"
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

/// Recognized keybinding modifier tokens (matched case-insensitively).
const KEYBINDING_MODIFIERS: &[&str] = &["cmdorctrl", "ctrl", "cmd", "shift", "alt"];

/// Recognized named special-key tokens (the non-modifier main key of a binding,
/// matched case-insensitively). Mirrors the frontend `NAMED_KEYS` table — a
/// binding authored as `Ctrl+Enter` or captured from an Enter keydown parses to
/// the token "enter", and this table is what lets the backend validator accept
/// it instead of rejecting the multi-char token as malformed. Single-character
/// keys (letters/digits/punctuation) are validated separately and aren't listed
/// here. Function keys F1–F24 are recognized by pattern (see `is_fn_key`).
const KEYBINDING_NAMED_KEYS: &[&str] = &[
    "space", "enter", "return", "escape", "esc", "tab", "backspace", "delete", "del",
    "insert", "home", "end", "pageup", "pagedown",
    "up", "down", "left", "right",
    "arrowup", "arrowdown", "arrowleft", "arrowright",
];

/// Is `lower` (already lowercased) a function-key token f1..f24?
fn is_fn_key(lower: &str) -> bool {
    let rest = match lower.strip_prefix('f').filter(|r| !r.is_empty()) {
        Some(r) => r,
        None => return false,
    };
    rest.bytes().all(|b| b.is_ascii_digit())
        && rest.parse::<u32>().map(|n| (1..=24).contains(&n)).unwrap_or(false)
}

/// Validate a `keybinding`-type setting value: empty (disabled) is allowed;
/// otherwise it must be `mod(+mod)*+key` with exactly one non-modifier part.
/// Mirrors the frontend `parseKeybinding` grammar — kept lightweight (no
/// per-platform CmdOrCtrl resolution) since the frontend re-validates at match
/// time and the input was authored by our own control. Accepts single-char
/// keys, the named special keys in [`KEYBINDING_NAMED_KEYS`], and F1–F24.
fn validate_keybinding(s: &str) -> bool {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return true; // empty = disabled
    }
    let mut has_key = false;
    for part in trimmed.split('+') {
        let p = part.trim();
        if p.is_empty() {
            return false; // "Ctrl++B" or leading/trailing "+"
        }
        let lower = p.to_ascii_lowercase();
        if KEYBINDING_MODIFIERS.contains(&lower.as_str()) {
            continue;
        }
        // First non-modifier token is the main key; a second one is malformed.
        if has_key {
            return false;
        }
        // A single character (letter/digit/punctuation) is always a valid key.
        if p.chars().count() == 1 {
            has_key = true;
            continue;
        }
        // Otherwise it must be a recognized named key or F1–F24.
        if KEYBINDING_NAMED_KEYS.contains(&lower.as_str()) || is_fn_key(&lower) {
            has_key = true;
            continue;
        }
        return false;
    }
    has_key
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

    /// `keybinding` settings accept well-formed accelerator strings and empty
    /// (disabled); reject non-strings, bare modifiers, malformed chords, and
    /// multi-char junk keys.
    #[test]
    fn keybinding_setting_validates() {
        use super::{validate, SettingDef};
        let def = SettingDef {
            key: "demo.kb".into(),
            setting_type: "keybinding".into(),
            label: "Demo".into(),
            default: json!("Ctrl+B"),
            extra: serde_json::Map::new(),
        };
        assert!(validate(&def, &json!("Ctrl+B")).is_ok());
        assert!(validate(&def, &json!("CmdOrCtrl+Shift+P")).is_ok());
        assert!(validate(&def, &json!("Shift+Alt+F")).is_ok());
        assert!(validate(&def, &json!("Ctrl+`")).is_ok());
        assert!(validate(&def, &json!("Ctrl+1")).is_ok());
        assert!(validate(&def, &json!("")).is_ok()); // empty = disabled
        // Named special keys and F1–F24 (the capture flow emits these tokens).
        assert!(validate(&def, &json!("Ctrl+Enter")).is_ok());
        assert!(validate(&def, &json!("CmdOrCtrl+F5")).is_ok());
        assert!(validate(&def, &json!("Shift+ArrowLeft")).is_ok());
        assert!(validate(&def, &json!("Alt+Space")).is_ok());
        assert!(validate(&def, &json!("Ctrl+F24")).is_ok());
        assert!(validate(&def, &json!(42)).is_err());
        assert!(validate(&def, &json!(null)).is_err());
        assert!(validate(&def, &json!("Ctrl+Shift")).is_err()); // bare modifiers
        assert!(validate(&def, &json!("Ctrl++B")).is_err()); // dangling separator
        assert!(validate(&def, &json!("Ctrl+A+B")).is_err()); // two main keys
        assert!(validate(&def, &json!("Ctrl+Junk")).is_err()); // multi-char junk
        assert!(validate(&def, &json!("Ctrl+F25")).is_err()); // F-key out of range
        assert!(validate(&def, &json!("Ctrl+F0")).is_err()); // F0 isn't a key
        assert!(validate(&def, &json!("Ctrl+BogusKey")).is_err()); // unknown named key
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

    /// A `set` whose persistence fails must roll the in-memory document back
    /// to the pre-mutation state and never fire `on_change` — otherwise later
    /// `get`s would serve a value that only ever existed in memory (a
    /// memory/persistence divergence until restart).
    #[test]
    fn set_rolls_back_when_persistence_fails() {
        // The store's parent "directory" is actually a regular file, so
        // `save_value` can never succeed.
        let dir = std::env::temp_dir().join(format!("typst-settings-rb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, b"not a dir").unwrap();

        let fired = Arc::new(StdMutex::new(false));
        let f = Arc::clone(&fired);
        let svc = SettingsService::new(
            JsonFileStore::new(blocker.join("settings.json")),
            Manifest::embedded(),
            move |_| {
                *f.lock().unwrap() = true;
            },
        )
        .unwrap();

        assert!(
            svc.set("editor.fontSize", json!(20)).is_err(),
            "saving under a file-as-parent path must fail"
        );
        // Rolled back: memory must not hold the never-persisted value.
        let n: i64 = svc.get("editor.fontSize", 99);
        assert_eq!(n, 99, "in-memory document must roll back on save failure");
        assert!(!*fired.lock().unwrap(), "on_change must not fire for a failed set");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Concurrent `set`s to distinct keys must all land — in memory, on disk,
    /// and in the broadcast count. This is the regression test for serializing
    /// writers: without the writer mutex a `set` whose save interleaves with
    /// another's mutate could persist a snapshot missing the other's key (lost
    /// update on disk), and a failed save's rollback could restore a clone
    /// taken before the other's successful write (lost update in memory).
    #[test]
    fn concurrent_sets_to_distinct_keys_all_land() {
        let store = tmp_store();
        let path = store.path.clone();
        let fired = Arc::new(StdMutex::new(0usize));
        let f = Arc::clone(&fired);
        let svc = Arc::new(
            SettingsService::new(store, Manifest::embedded(), move |_| {
                *f.lock().unwrap() += 1;
            })
            .unwrap(),
        );

        const THREADS: usize = 8;
        const ITERATIONS: usize = 25;
        let pairs: Vec<(&str, Value)> = vec![
            ("editor.fontSize", json!(18)),
            ("editor.wordWrap", json!(true)),
            ("compiler.debounceMs", json!(250)),
            ("preview.background", json!("light")),
        ];
        let pairs = Arc::new(pairs);
        let handles: Vec<_> = (0..THREADS)
            .map(|t| {
                let svc = Arc::clone(&svc);
                let pairs = Arc::clone(&pairs);
                std::thread::spawn(move || {
                    for i in 0..ITERATIONS {
                        let (key, val) = pairs[(t + i) % pairs.len()].clone();
                        svc.set(key, val).expect("every serialized set succeeds");
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().expect("writer thread must not panic");
        }

        // In memory: every key survived every interleaving.
        let all = svc.get_all();
        assert_eq!(all.pointer("/editor/fontSize"), Some(&json!(18)));
        assert_eq!(all.pointer("/editor/wordWrap"), Some(&json!(true)));
        assert_eq!(all.pointer("/compiler/debounceMs"), Some(&json!(250)));
        assert_eq!(all.pointer("/preview/background"), Some(&json!("light")));
        // On disk: the same document (no stale-snapshot lost update).
        let svc2 = SettingsService::new(
            JsonFileStore::new(path.clone()),
            Manifest::embedded(),
            |_| {},
        )
        .unwrap();
        assert_eq!(svc2.get_all(), all, "disk must hold exactly what memory does");
        // Broadcast: one fire per successful set, no more, no fewer.
        assert_eq!(*fired.lock().unwrap(), THREADS * ITERATIONS);
        let _ = std::fs::remove_file(&path);
    }
}
