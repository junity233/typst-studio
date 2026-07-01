//! Settings layer — dynamic JSON configuration, manifest catalog, persistence,
//! and the orchestration service.
//!
//! The runtime config is a free-form [`serde_json::Value`]; the [`Manifest`]
//! catalog describes known settings/defaults/constraints and is shared with the
//! frontend. [`SettingsService`] ties the two together with validation.

pub mod manifest;
pub mod service;
pub mod store;
pub mod window;

pub use manifest::Manifest;
pub use service::SettingsService;
pub use store::JsonFileStore;
