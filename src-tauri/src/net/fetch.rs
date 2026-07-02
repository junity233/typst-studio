//! `fetch_to_file` / `fetch_bytes` for [`HttpClient`].
//!
//! Both methods enforce the http(s)-only scheme guard and the
//! [`FetchOptions`] size cap. `fetch_to_file` additionally creates the
//! destination's parent directory before writing, so callers can hand it a
//! freshly-invented nested path.

use crate::net::client::{FetchOptions, HttpClient};
use crate::net::error::NetError;

impl HttpClient {
    /// Reject anything that isn't an http(s) URL. Done before any network IO
    /// so `file://`, `data:`, etc. never reach reqwest.
    fn validate_scheme(url: &str) -> Result<(), NetError> {
        let lower = url.to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Err(NetError::BadScheme(url.to_string()));
        }
        Ok(())
    }

    /// Fetch `url` into memory, then write it to `dest`, creating any missing
    /// parent directories. Returns the number of bytes written.
    pub async fn fetch_to_file(
        &self,
        url: &str,
        dest: &std::path::Path,
        opts: &FetchOptions,
    ) -> Result<u64, NetError> {
        Self::validate_scheme(url)?;
        let bytes = self.fetch_bytes(url, opts).await?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(dest, &bytes)?;
        Ok(bytes.len() as u64)
    }

    /// Fetch `url` into a `Vec<u8>`. Enforces scheme, status, and size cap.
    pub async fn fetch_bytes(&self, url: &str, opts: &FetchOptions) -> Result<Vec<u8>, NetError> {
        Self::validate_scheme(url)?;
        // NOTE: reqwest 0.12 does not expose `reqwest::error::Timeout` for
        // public construction, so we surface timeouts via a dedicated
        // `NetError::Timeout` variant instead of the `Request(..)` path the
        // original sketch used.
        let resp = tokio::time::timeout(opts.timeout, self.client.get(url).send())
            .await
            .map_err(|_| NetError::Timeout(opts.timeout))??;
        if !resp.status().is_success() {
            return Err(NetError::Status(resp.status()));
        }
        if let Some(len) = resp.content_length() {
            if len > opts.max_bytes {
                return Err(NetError::TooLarge { size: len, cap: opts.max_bytes });
            }
        }
        let bytes = resp.bytes().await?;
        if (bytes.len() as u64) > opts.max_bytes {
            return Err(NetError::TooLarge { size: bytes.len() as u64, cap: opts.max_bytes });
        }
        Ok(bytes.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fetch_ok_writes_file() {
        let mut server = mockito::Server::new_async().await;
        let body = b"PNGDATA";
        let _m = server
            .mock("GET", "/img.png")
            .with_status(200)
            .with_body(body)
            .create_async()
            .await;
        let client = HttpClient::new();
        let tmp = std::env::temp_dir().join("ts_net_test_ok.png");
        let _ = std::fs::remove_file(&tmp);
        let n = client
            .fetch_to_file(&format!("{}/img.png", server.url()), &tmp, &FetchOptions::default())
            .await
            .unwrap();
        assert_eq!(n, body.len() as u64);
        assert_eq!(std::fs::read(&tmp).unwrap(), body);
        let _ = std::fs::remove_file(&tmp);
    }

    #[tokio::test]
    async fn rejects_non_http_scheme() {
        let client = HttpClient::new();
        let err = client
            .fetch_bytes("file:///etc/passwd", &FetchOptions::default())
            .await
            .unwrap_err();
        assert!(matches!(err, NetError::BadScheme(_)));
    }

    #[tokio::test]
    async fn non_2xx_errors() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/x").with_status(404).create_async().await;
        let client = HttpClient::new();
        let err = client
            .fetch_bytes(&format!("{}/x", server.url()), &FetchOptions::default())
            .await
            .unwrap_err();
        assert!(matches!(err, NetError::Status(_)));
    }
}
