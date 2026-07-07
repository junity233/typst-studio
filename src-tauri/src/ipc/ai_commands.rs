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

/// The default base URL for a provider, used when the user leaves `ai.baseUrl`
/// empty. Must stay in sync with the frontend's SDK defaults.
fn provider_default_base_url(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "https://api.anthropic.com",
        // OpenAI and any OpenAI-compatible service (DeepSeek, Moonshot, Ollama,
        // …) — the OpenAI SDK defaults to this when no baseURL is set.
        _ => "https://api.openai.com",
    }
}

/// Resolve the single origin (`scheme://host[:port]`, no path) the proxy is
/// allowed to send the API key to. Sources, in priority order:
///   1. `ai.baseUrl` (user-configured) — the origin is extracted from it.
///   2. provider default (from `ai.provider`).
///
/// `ai.baseUrl` is what the user explicitly trusted; if they point it at a
/// local Ollama or a proxy, that is the only legitimate destination. We do NOT
/// allow the webview to override this per-request.
fn resolve_allowed_origin(state: &AppState) -> Result<String> {
    let provider = state.settings.get::<String>("ai.provider", "openai".into());
    let base_url = state.settings.get::<String>("ai.baseUrl", String::new());
    let source = if !base_url.trim().is_empty() {
        base_url
    } else {
        provider_default_base_url(&provider).to_string()
    };
    origin_of(&source)
}

/// Extract the origin (`scheme://host[:port]`) from an absolute URL. Returns
/// an error if the URL is not a valid absolute http(s) URL. Used for the
/// allowlist comparison so path/query differences don't matter.
fn origin_of(raw: &str) -> Result<String> {
    let parsed = url::Url::parse(raw)
        .map_err(|e| AppError::InvalidInput(format!("invalid URL '{}': {}", raw, e)))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(AppError::InvalidInput(format!(
            "AI proxy only allows http(s) URLs; got '{}'",
            raw
        )));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::InvalidInput(format!("URL '{}' has no host", raw)))?;
    // Include the port only when it's explicitly present.
    let origin = match parsed.port() {
        Some(port) => format!("{}://{}:{}", scheme, host, port),
        None => format!("{}://{}", scheme, host),
    };
    Ok(origin)
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
    // the boundary every other net/ entrypoint enforces (fetch.rs).
    crate::net::client::HttpClient::validate_scheme(&opts.url)
        .map_err(AppError::from)?;

    // SECURITY (host allowlist): the API key is injected into the request
    // below, so the destination host MUST be one the user actually configured.
    // Without this check, a compromised renderer could exfiltrate the key by
    // pointing this command at an attacker-controlled domain (the scheme check
    // above permits any https URL, which is not enough). We resolve the
    // expected host from `ai.baseUrl` (when set) or the provider default, then
    // reject any URL whose host:port does not match. Path/query are left to
    // the provider's API to validate.
    let allowed_origin = resolve_allowed_origin(&state)?;
    let requested_origin = origin_of(&opts.url)?;
    if requested_origin != allowed_origin {
        return Err(AppError::InvalidInput(format!(
            "AI proxy refuses to send the API key to '{}': the configured AI \
             provider is '{}'. Only the configured base URL (or the provider \
             default) is allowed as a request target.",
            requested_origin, allowed_origin,
        )));
    }

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
