//! Shared settings manifest — the catalog of known settings and their
//! defaults/constraints. The single source of truth that both the backend
//! (compile-time `include_str!`) and the frontend (Vite JSON import) read.
//!
//! The dynamic model intentionally has no fixed Rust struct for the runtime
//! config: adding a setting is a one-line change to `settings/manifest.json`,
//! with no Rust edits and no ts-rs type re-export.

use serde::{Deserialize, Serialize};

/// The top-level manifest document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub categories: Vec<Category>,
}

/// A grouping of settings rendered as a section in the settings UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub label: String,
    pub settings: Vec<SettingDef>,
}

/// A single setting descriptor. `extra` absorbs the optional constraints
/// (`min` / `max` / `step` / `options` / `readonly`) via `#[serde(flatten)]`,
/// so the struct stays stable as new constraints are added to the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingDef {
    pub key: String,
    #[serde(rename = "type")]
    pub setting_type: String,
    pub label: String,
    pub default: serde_json::Value,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Manifest {
    /// Embed and parse the build-time manifest. Panics on invalid JSON — it is
    /// static, version-controlled data, so a parse failure is a build error.
    pub fn embedded() -> Self {
        serde_json::from_str(include_str!("../../settings/manifest.json"))
            .expect("settings manifest must be valid JSON")
    }

    /// Look up a setting descriptor by dotted key (e.g. `editor.fontSize`).
    pub fn find(&self, key: &str) -> Option<&SettingDef> {
        self.categories
            .iter()
            .flat_map(|c| c.settings.iter())
            .find(|s| s.key == key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_parses() {
        let m = Manifest::embedded();
        assert_eq!(m.version, 1);
        assert!(m.categories.len() >= 4);
    }

    #[test]
    fn find_returns_known_key() {
        let m = Manifest::embedded();
        let def = m.find("editor.fontSize").expect("editor.fontSize in manifest");
        assert_eq!(def.setting_type, "number");
        assert_eq!(def.default, serde_json::json!(14));
        // extra absorbs min/max.
        assert_eq!(def.extra.get("min"), Some(&serde_json::json!(8)));
        assert_eq!(def.extra.get("max"), Some(&serde_json::json!(32)));
    }

    #[test]
    fn find_rejects_unknown_key() {
        let m = Manifest::embedded();
        assert!(m.find("nope.does-not-exist").is_none());
    }

    #[test]
    fn select_has_options() {
        let m = Manifest::embedded();
        let def = m.find("preview.background").unwrap();
        assert_eq!(def.setting_type, "select");
        assert_eq!(
            def.extra.get("options"),
            Some(&serde_json::json!(["light", "dark"]))
        );
    }

    #[test]
    fn readonly_flag_absorbed() {
        let m = Manifest::embedded();
        let def = m.find("window.recentWorkspaces").unwrap();
        assert_eq!(def.extra.get("readonly"), Some(&serde_json::json!(true)));
    }
}
