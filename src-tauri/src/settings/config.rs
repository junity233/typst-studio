//! `AppConfig` — runtime application configuration.
//!
//! Filled in by a later phase (currently a placeholder so the structure is in
//! place). Font / package paths and editor options live here.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Application-wide configuration. Loaded at startup, mutable via settings UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// Extra font directories to scan in addition to system + embedded fonts.
    pub extra_font_dirs: Vec<PathBuf>,
    /// Editor: debounce delay in milliseconds.
    pub compile_debounce_ms: u64,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            extra_font_dirs: Vec::new(),
            compile_debounce_ms: 300,
        }
    }
}
