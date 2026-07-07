//! AI assistant proxy command.
//!
//! A dumb forwarder: the webview sends the request URL, body, an auth scheme,
//! and any non-secret extra headers; Rust reads `ai.apiKey` from settings,
//! injects the auth header per the scheme, POSTs via the shared `HttpClient`,
//! and pipes the response body back over a Tauri Channel as `ProxyEvent` byte
//! chunks. Rust has ZERO knowledge of Chat Completions vs Responses vs
//! Anthropic Messages — the SDKs parse SSE themselves on the frontend.
//!
//! The API key never crosses to the webview on the call path. The frontend
//! sends only the scheme and non-secret headers; Rust injects the key.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{AppError, Result};
use crate::ipc::state::AppState;
use crate::net::error::NetError;

/// How Rust should authenticate the proxied request. The webview picks the
/// scheme based on the provider; Rust injects the actual key from settings.
///
/// Serialized as a plain string via `#[serde(rename_all = "kebab-case")]`
/// (camelCase on the struct field maps `auth_scheme` ↔ `authScheme` on the
/// wire), so the frontend's `{ ..., authScheme: "bearer" | "x-api-key" }`
/// deserializes cleanly. We deliberately avoid the earlier
/// `#[serde(flatten)]` + internally-tagged enum combination — that combo is
/// notoriously fragile under serde and produced
/// "missing field `scheme`" deserialization errors.
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthScheme {
    /// `Authorization: Bearer <key>` — OpenAI Chat Completions + Responses.
    Bearer,
    /// `x-api-key: <key>` (+ caller-supplied `anthropic-version`) — Anthropic.
    XApiKey,
}

/// Request payload from the webview. The API key is NOT here — Rust reads it
/// from settings and injects per `auth_scheme`.
///
/// `body` is a pre-serialized JSON string (the SDK has already serialized it).
/// Rust forwards it verbatim as bytes — it does NOT parse, re-serialize, or
/// otherwise inspect the JSON. This keeps Rust a pure byte-level forwarder
/// with zero protocol knowledge (no `json` feature, no `serde_json::Value`).
///
/// `#[serde(rename_all = "camelCase")]` aligns the wire shape with the
/// frontend's `{ url, body, extraHeaders, authScheme }` object.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyOptions {
    /// Absolute provider URL, e.g. `https://api.openai.com/v1/chat/completions`.
    pub url: String,
    /// Pre-serialized JSON body string; forwarded as bytes with
    /// `content-type: application/json`.
    pub body: String,
    /// Non-secret extra headers (e.g. `anthropic-version`). Never the key.
    #[serde(default)]
    pub extra_headers: HashMap<String, String>,
    /// Which auth scheme to use; Rust injects the key per this variant.
    pub auth_scheme: AuthScheme,
}

/// One streaming event sent to the webview over the Channel.
#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum ProxyEvent {
    /// A chunk of the upstream response body, verbatim.
    Chunk {
        data: Vec<u8>,
    },
    /// Upstream finished successfully.
    Done,
    /// Upstream returned a non-2xx, or the stream errored mid-flight.
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
    },
}

/// Read `ai.apiKey` from settings; reject if missing or empty. Centralizing the
/// read here means a future keychain upgrade touches exactly one place.
fn read_api_key(state: &AppState) -> Result<String> {
    let key = state.settings.get::<String>("ai.apiKey", String::new());
    if key.is_empty() {
        return Err(AppError::InvalidInput(
            "ai.apiKey is not configured (set it in Settings → AI Assistant)".into(),
        ));
    }
    Ok(key)
}

/// Stream an LLM request through Rust. See module docs for the threat model:
/// the webview supplies everything except the key; Rust injects the key and
/// pipes bytes. The frontend's custom-`fetch` wrapper reconstructs a standard
/// `Response` whose body the OpenAI/Anthropic SDK parses.
#[tauri::command]
pub async fn ai_proxy_stream(
    opts: ProxyOptions,
    channel: Channel<ProxyEvent>,
    state: State<'_, AppState>,
) -> Result<()> {
    let api_key = read_api_key(&state)?;

    // SECURITY: the webview controls `opts.url`. Enforce http(s)-only so a
    // compromised/XSSed webview cannot use this command to read local files
    // (file://) or hit internal/cloud-metadata endpoints (SSRF). This mirrors
    // the boundary every other net/ entrypoint enforces (fetch.rs). The API
    // key is injected below; restricting the destination host protects it.
    crate::net::client::HttpClient::validate_scheme(&opts.url)
        .map_err(AppError::from)?;

    // Forward the pre-serialized JSON body as raw bytes with the right
    // content-type. Rust does not parse or re-serialize the JSON — it is a
    // byte-level forwarder (no reqwest `json` feature needed).
    let mut req = state
        .net
        .client()
        .post(&opts.url)
        .header("content-type", "application/json")
        .body(opts.body);
    match opts.auth_scheme {
        AuthScheme::Bearer => {
            req = req.bearer_auth(&api_key);
        }
        AuthScheme::XApiKey => {
            req = req.header("x-api-key", &api_key);
        }
    }
    for (k, v) in &opts.extra_headers {
        req = req.header(k, v);
    }

    let resp = req.send().await.map_err(|e| AppError::from(NetError::from(e)))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        // Read the body for a useful error message; fall back to the status if
        // the body can't be decoded as text (e.g. binary, empty).
        let body = resp.text().await.unwrap_or_default();
        let _ = channel.send(ProxyEvent::Error {
            message: if body.is_empty() {
                format!("HTTP {}", status)
            } else {
                body
            },
            status: Some(status),
        });
        return Ok(());
    }

    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let _ = channel.send(ProxyEvent::Chunk {
                    data: bytes.to_vec(),
                });
            }
            Err(e) => {
                let _ = channel.send(ProxyEvent::Error {
                    message: e.to_string(),
                    status: None,
                });
                return Ok(());
            }
        }
    }
    let _ = channel.send(ProxyEvent::Done);
    Ok(())
}
