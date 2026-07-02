//! Session memory: remembers the last-opened workspace root and file path
//! across launches, persisted as `session.json` in the app config dir.
//!
//! This is intentionally separate from the settings system — it is opaque
//! program state (not user-facing configuration), read/written via two simple
//! commands. A missing or malformed file degrades to an empty session.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;

/// What we remember between launches. Both fields are absolute paths and may
/// be empty strings when nothing has been opened yet.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Session {
    /// Absolute path of the last workspace folder the user opened, or "".
    #[serde(default)]
    pub last_workspace: String,
    /// Absolute path of the last file the user opened, or "".
    #[serde(default)]
    pub last_file: String,
}

/// Owns the session document behind a lock, persisted to `session.json`.
pub struct SessionService {
    inner: Mutex<Session>,
    path: PathBuf,
}

impl SessionService {
    /// Load the session from `path` (missing/malformed → empty session).
    pub fn load(path: PathBuf) -> Result<Self> {
        let session = if path.exists() {
            let raw = std::fs::read_to_string(&path).unwrap_or_default();
            serde_json::from_str::<Session>(&raw).unwrap_or_default()
        } else {
            Session::default()
        };
        Ok(Self { inner: Mutex::new(session), path })
    }

    /// Current snapshot.
    pub fn get(&self) -> Session {
        self.inner.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Merge a partial update (`{ lastWorkspace?, lastFile? }`) into the
    /// session, persist it, and return the new snapshot.
    pub fn update(&self, patch: Value) -> Result<Session> {
        let mut s = self.inner.lock().map_err(|e| {
            crate::error::AppError::Other(format!("session lock: {e}"))
        })?;
        if let Some(obj) = patch.as_object() {
            if let Some(v) = obj.get("lastWorkspace").and_then(|v| v.as_str()) {
                s.last_workspace = v.to_string();
            }
            if let Some(v) = obj.get("lastFile").and_then(|v| v.as_str()) {
                s.last_file = v.to_string();
            }
        }
        let snapshot = s.clone();
        drop(s);
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    fn persist(&self, session: &Session) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(session)?;
        std::fs::write(&self.path, raw)?;
        Ok(())
    }
}
