//! LSP message framing over stdio.
//!
//! The Language Server Protocol uses `Content-Length: N\r\n\r\n<body>` framing
//! for its base transport. This module provides async read/write helpers for
//! parsing and generating these framed messages over tokio's async I/O types.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Read a single LSP message from `reader`.
///
/// Parses the `Content-Length: N` header, skips any additional headers,
/// then reads exactly `N` bytes of the JSON-RPC body.
///
/// Returns `None` if the stream reaches EOF before a complete message.
pub async fn read_message(reader: &mut (impl AsyncBufRead + Unpin)) -> io::Result<Option<String>> {
    // Read headers until we encounter the blank line (\r\n\r\n).
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Ok(None); // EOF
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break; // End of headers
        }
        if let Some(val) = trimmed.strip_prefix("Content-Length:") {
            content_length = Some(val.trim().parse().map_err(|e| {
                io::Error::new(io::ErrorKind::InvalidData, format!("bad Content-Length: {e}"))
            })?);
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
