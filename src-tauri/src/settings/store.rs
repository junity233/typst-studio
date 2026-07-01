//! `ConfigStore` trait + `JsonFileStore` implementation.
//!
//! Stub for now; concrete persistence arrives with the settings UI phase.

#![allow(dead_code)]

use crate::error::Result;
use std::path::PathBuf;

use super::config::AppConfig;

/// Persistence abstraction for user settings.
pub trait ConfigStore: Send + Sync {
    fn load(&self) -> Result<AppConfig>;
    fn save(&self, cfg: &AppConfig) -> Result<()>;
}

/// JSON file-backed store. Default location is the platform config dir.
pub struct JsonFileStore {
    pub path: PathBuf,
}

impl JsonFileStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl ConfigStore for JsonFileStore {
    fn load(&self) -> Result<AppConfig> {
        if !self.path.exists() {
            return Ok(AppConfig::default());
        }
        let raw = std::fs::read_to_string(&self.path)?;
        let cfg: AppConfig = serde_json::from_str(&raw).unwrap_or_default();
        Ok(cfg)
    }

    fn save(&self, cfg: &AppConfig) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(cfg)?;
        std::fs::write(&self.path, raw)?;
        Ok(())
    }
}
