//! Package-related Tauri commands — thin adapters over [`PackageService`].
//!
//! Blocking operations (install, template init) run on `spawn_blocking` since
//! typst-kit's `Downloader` trait is synchronous and the service does real IO.

use std::path::PathBuf;

use tauri::State;

use crate::domain::package_catalog::{CatalogFilter, InstalledPackage, PackageEntry};
use crate::error::{AppError, Result};
use crate::fs::package_index::IndexFetchError;
use crate::ipc::error::ErrorCode;
use crate::ipc::state::AppState;
use crate::service::package_service::{CatalogListing, PackageOpError, PackageService};

/// The filtered catalog listing payload (camelCase on the wire).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogListingPayload {
    pub entries: Vec<PackageEntry>,
    pub fetched_at: Option<i64>,
    pub stale: bool,
}

impl From<CatalogListing> for CatalogListingPayload {
    fn from(l: CatalogListing) -> Self {
        Self {
            entries: l.entries,
            fetched_at: l.fetched_at,
            stale: l.stale,
        }
    }
}

#[tauri::command]
pub async fn package_list_catalog(
    filter: CatalogFilter,
    state: State<'_, AppState>,
) -> Result<CatalogListingPayload> {
    Ok(state.packages.list_catalog(&filter).into())
}

#[tauri::command]
pub async fn package_refresh_index(state: State<'_, AppState>) -> Result<()> {
    state
        .packages
        .refresh_index()
        .await
        .map_err(map_index_err)
        .map(|_| ())
}

#[tauri::command]
pub async fn package_install(
    name: String,
    version: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let svc = state.packages.clone();
    tauri::async_runtime::spawn_blocking(move || svc.install_blocking(&name, &version))
        .await
        .map_err(|e| AppError::Other(format!("install join: {e}")))?
        .map_err(map_op_err)
}

#[tauri::command]
pub async fn package_uninstall(
    name: String,
    version: String,
    state: State<'_, AppState>,
) -> Result<()> {
    state
        .packages
        .uninstall(&name, &version)
        .map_err(map_op_err)
}

#[tauri::command]
pub async fn package_list_installed(state: State<'_, AppState>) -> Result<Vec<InstalledPackage>> {
    let svc = state.packages.clone();
    let res = tauri::async_runtime::spawn_blocking(move || svc.list_installed())
        .await
        .map_err(|e| AppError::Other(format!("list_installed join: {e}")))?;
    Ok(res)
}

#[tauri::command]
pub async fn package_init_template(
    name: String,
    version: String,
    dest: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let dest = PathBuf::from(&dest);
    if !dest.is_absolute() {
        return Err(AppError::InvalidInput("dest must be absolute".into()));
    }
    let svc = state.packages.clone();
    let entrypoint = tauri::async_runtime::spawn_blocking(move || {
        svc.init_template(&name, &version, &dest)
    })
    .await
    .map_err(|e| AppError::Other(format!("init_template join: {e}")))?
    .map_err(map_op_err)?;
    Ok(entrypoint)
}

#[tauri::command]
pub async fn package_insert_import(name: String, version: String) -> Result<String> {
    Ok(PackageService::import_snippet(&name, &version))
}

#[tauri::command]
pub async fn package_get_readme(
    name: String,
    version: String,
    state: State<'_, AppState>,
) -> Result<Option<String>> {
    Ok(state.packages.get_readme(&name, &version))
}

#[tauri::command]
pub async fn package_get_thumbnail(
    name: String,
    version: String,
    state: State<'_, AppState>,
) -> Result<Option<String>> {
    Ok(state
        .packages
        .ensure_thumbnail(&name, &version)
        .map(|p| p.to_string_lossy().into_owned()))
}

fn map_op_err(e: PackageOpError) -> AppError {
    match e {
        PackageOpError::NotFound => ipc(ErrorCode::PackageNotFound, "package not found", false, None),
        PackageOpError::Install(msg) => {
            ipc(ErrorCode::PackageInstallFailed, &msg, true, None)
        }
        PackageOpError::Uninstall(msg) => {
            ipc(ErrorCode::PackageUninstallFailed, &msg, true, None)
        }
        PackageOpError::TemplateInit { copied, cause } => ipc(
            ErrorCode::TemplateInitFailed,
            &cause,
            false,
            Some(serde_json::json!({
                "copiedFiles": copied.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>()
            })),
        ),
    }
}

fn map_index_err(e: IndexFetchError) -> AppError {
    ipc(ErrorCode::IndexFetchFailed, &e.to_string(), true, None)
}

/// Build an `AppError::Code` (the structured escape hatch in error.rs) from an
/// IPC code/message/recoverability + optional details.
fn ipc(
    code: ErrorCode,
    message: &str,
    recoverable: bool,
    details: Option<serde_json::Value>,
) -> AppError {
    AppError::Code {
        code,
        message: message.to_string(),
        recoverable,
        details,
    }
}
