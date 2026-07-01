//! IPC layer — thin Tauri command/event wrappers.
//!
//! Filled in across Phase 5. Commands intentionally only do parameter
//! conversion and delegate to services.

pub mod commands;
pub mod events;
pub mod state;
