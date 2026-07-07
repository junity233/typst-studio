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
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct CatalogListingPayload {
    pub entries: Vec<PackageEntry>,
    #[cfg_attr(feature = "export-types", ts(type = "number"))]
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
    overwrite: Option<bool>,
    state: State<'_, AppState>,
) -> Result<String> {
    let dest = PathBuf::from(&dest);
    if !dest.is_absolute() {
        return Err(AppError::InvalidInput("dest must be absolute".into()));
    }
    let overwrite = overwrite.unwrap_or(false);
    let svc = state.packages.clone();
    let plan = tauri::async_runtime::spawn_blocking(move || {
        svc.template_init_plan(&name, &version, &dest)
    })
    .await
    .map_err(|e| AppError::Other(format!("init_template join: {e}")))?
    .map_err(map_op_err)?;

    let open_docs = state.editor.document().docs_at_paths(&plan.target_files);
    if !open_docs.is_empty() {
        let affected_docs: Vec<_> = open_docs
            .iter()
            .map(|doc| {
                serde_json::json!({
                    "id": doc.id,
                    "path": doc.path.to_string_lossy().to_string(),
                })
            })
            .collect();
        return Err(ipc(
            ErrorCode::TemplateInitFailed,
            "template would overwrite or create files that are currently open; close or resolve those tabs first",
            true,
            Some(serde_json::json!({ "openDocs": affected_docs })),
        ));
    }

    let entrypoint = plan.entrypoint.clone();
    let svc = state.packages.clone();
    tauri::async_runtime::spawn_blocking(move || svc.init_template_from_plan(&plan, overwrite))
        .await
        .map_err(|e| AppError::Other(format!("init_template join: {e}")))?
        .map_err(map_op_err)?;
    Ok(entrypoint)
}

#[tauri::command]
pub async fn package_insert_import(name: String, version: String) -> Result<String> {
    Ok(PackageService::import_snippet(&name, &version))
}

/// Whether the absolute `path` directory is empty (no entries). Used by the
/// template-apply flow to warn before writing into a non-empty folder (§4.1).
/// Uses `std::fs` directly (NOT the fs-plugin), so it works on any absolute
/// path the user picks in the dialog. Returns an error for a non-directory or
/// unreadable path so the caller can fall back to "proceed and let init
/// surface the error".
#[tauri::command]
pub async fn package_dir_is_empty(path: String) -> Result<bool> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() {
        return Err(AppError::InvalidInput("path must be absolute".into()));
    }
    let read = std::fs::read_dir(&p)
        .map_err(|e| AppError::Other(format!("read_dir {}: {e}", p.display())))?;
    Ok(read.take(1).next().is_none())
}

/// The embedded Typst compiler version (e.g. "0.15.0"), for the
/// compiler-compat warning in the detail view (§4.3). Returns it as a string
/// so the frontend can compare against `PackageEntry.compiler`.
#[tauri::command]
pub async fn package_compiler_version() -> Result<String> {
    let v = typst::syntax::package::PackageVersion::compiler();
    Ok(format!("{}.{}.{}", v.major, v.minor, v.patch))
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
    // The registry hosts template preview images as small WebP files at a
    // fixed URL pattern — they are NOT inside the package tarball (the tarball
    // only carries typst.toml + source, despite the manifest's `thumbnail`
    // field). Fetch the WebP directly and inline it as a data URI so it
    // renders in <img> without configuring the Tauri asset protocol. Returns
    // None on any miss (404 / network) so the gallery shows the placeholder.
    let url = format!(
        "https://packages.typst.org/preview/thumbnails/{name}-{version}-small.webp"
    );
    match state
        .net
        .fetch_bytes(
            &url,
            &crate::net::client::FetchOptions {
                max_bytes: 2 * 1024 * 1024,
                ..crate::net::client::FetchOptions::default()
            },
        )
        .await
    {
        Ok(bytes) => {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            Ok(Some(format!("data:image/webp;base64,{b64}")))
        }
        Err(_) => Ok(None),
    }
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

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        super::CatalogListingPayload::export(&cfg).unwrap();
    }
}
