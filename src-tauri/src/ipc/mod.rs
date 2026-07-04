//! IPC layer — thin Tauri command/event wrappers.
//!
//! Commands intentionally only do parameter conversion and delegate to services.

pub mod commands;
pub mod events;
pub mod fs_commands;
pub mod menu;
pub mod net_commands;
pub mod recovery_commands;
pub mod session_commands;
pub mod settings_commands;
pub mod state;
