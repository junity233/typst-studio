//! LSP message framing over stdio.
//!
//! The Language Server Protocol uses `Content-Length: N\r\n\r\n<body>` framing
//! for its base transport. This module provides async read/write helpers for
//! parsing and generating these framed messages over tokio's async I/O types.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Upper bound on a single message body. Guards against a buggy/malicious peer
/// requesting an arbitrarily large allocation via `Content-Length`.
const MAX_BODY: usize = 64 * 1024 * 1024;

/// Read a single LSP message from `reader`.
///
/// Parses the `Content-Length: N` header, skips any additional headers,
/// then reads exactly `N` bytes of the JSON-RPC body.
///
/// Returns `None` if the stream reaches EOF before a complete message. Per the
/// LSP base protocol (which inherits HTTP's CRLF framing), header lines are
/// terminated by `\r\n`; this is enforced rather than accepting a bare `\n`.
pub async fn read_message(reader: &mut (impl AsyncBufRead + Unpin)) -> io::Result<Option<String>> {
    // Read headers until the blank line (a bare `\r\n` after a header).
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Ok(None); // EOF before any header → no message
        }
        // LSP framing is CRLF. `read_line` keeps the terminator, so a header
        // line ends with `\r\n` and the terminating blank line is exactly
        // `\r\n`. Reject bare `\n` as malformed.
        let line_no_lf = match line.strip_suffix("\r\n") {
            Some(stripped) => stripped,
            None => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "header line is not CRLF-terminated (bare LF forbidden by LSP framing)",
                ));
            }
        };

        // Blank line (after stripping CRLF) marks end of headers.
        if line_no_lf.is_empty() {
            break;
        }

        if let Some(val) = line_no_lf.strip_prefix("Content-Length:") {
            let length: usize = val.trim().parse().map_err(|e| {
                io::Error::new(io::ErrorKind::InvalidData, format!("bad Content-Length: {e}"))
            })?;
            if length > MAX_BODY {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("Content-Length {length} exceeds limit {MAX_BODY}"),
                ));
            }
            content_length = Some(length);
        }
        // Other headers (e.g. Content-Type) are ignored per the LSP spec.
    }

    let length = content_length.ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "missing Content-Length header")
    })?;

    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await?;
    let text = String::from_utf8(body).map_err(|e| {
        io::Error::new(io::ErrorKind::InvalidData, format!("invalid UTF-8 body: {e}"))
    })?;
    Ok(Some(text))
}

/// Write a single LSP message to `writer` with Content-Length framing.
pub async fn write_message(
    writer: &mut (impl AsyncWrite + Unpin),
    body: &str,
) -> io::Result<()> {
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    writer.write_all(header.as_bytes()).await?;
    writer.write_all(body.as_bytes()).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    /// Read one message, asserting the body equals `expected`.
    async fn read_one(input: &[u8], expected: &str) {
        let mut reader = BufReader::new(input);
        let msg = read_message(&mut reader).await.unwrap();
        assert_eq!(msg.as_deref(), Some(expected));
    }

    /// Read one message, asserting an `InvalidData` error whose message
    /// contains `substr`.
    async fn expect_err(input: &[u8], substr: &str) {
        let mut reader = BufReader::new(input);
        let err = read_message(&mut reader).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData, "wrong kind: {err}");
        let msg = err.to_string();
        assert!(
            msg.contains(substr),
            "error {msg:?} does not mention {substr:?}"
        );
    }

    #[tokio::test]
    async fn reads_single_message() {
        let raw = b"Content-Length: 5\r\n\r\nhello";
        read_one(raw, "hello").await;
    }

    #[tokio::test]
    async fn reads_two_messages_in_one_buffer() {
        // Two complete frames in a single buffer — the second must survive
        // in the BufReader's internal buffer after the first read.
        let raw = b"Content-Length: 2\r\n\r\nhiContent-Length: 5\r\n\r\nworld";
        let mut reader = BufReader::new(&raw[..]);
        let m1 = read_message(&mut reader).await.unwrap();
        let m2 = read_message(&mut reader).await.unwrap();
        assert_eq!(m1.as_deref(), Some("hi"));
        assert_eq!(m2.as_deref(), Some("world"));
    }

    #[tokio::test]
    async fn ignores_extra_headers() {
        let raw = b"Content-Length: 3\r\nContent-Type: foo\r\n\r\nabc";
        read_one(raw, "abc").await;
    }

    #[tokio::test]
    async fn returns_none_on_eof_before_headers() {
        let mut reader = BufReader::new(&b""[..]);
        let msg = read_message(&mut reader).await.unwrap();
        assert_eq!(msg, None);
    }

    #[tokio::test]
    async fn missing_content_length_errors() {
        let raw = b"Content-Type: foo\r\n\r\nbody";
        expect_err(raw, "missing Content-Length").await;
    }

    #[tokio::test]
    async fn oversized_content_length_rejected() {
        let raw = format!("Content-Length: {}\r\n\r\nx", MAX_BODY + 1);
        expect_err(raw.as_bytes(), "exceeds limit").await;
    }

    #[tokio::test]
    async fn body_truncated_at_eof_errors() {
        // Declares 5 bytes but provides only 2 → read_exact hits EOF.
        let raw = b"Content-Length: 5\r\n\r\nhi";
        let mut reader = BufReader::new(&raw[..]);
        let err = read_message(&mut reader).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[tokio::test]
    async fn bare_lf_header_rejected() {
        // Bare \n instead of \r\n — malformed per LSP framing.
        let raw = b"Content-Length: 2\n\nhi";
        expect_err(raw, "not CRLF-terminated").await;
    }

    #[tokio::test]
    async fn write_then_read_roundtrip() {
        let mut out = Vec::<u8>::new();
        write_message(&mut out, "{\"json\":\"rpc\"}").await.unwrap();
        // The buffer is complete; read it back.
        let mut reader = BufReader::new(&out[..]);
        let msg = read_message(&mut reader).await.unwrap();
        assert_eq!(msg.as_deref(), Some("{\"json\":\"rpc\"}"));
    }
}
