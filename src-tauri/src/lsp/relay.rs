//! Bidirectional relay between a WebSocket connection and a child process's
//! stdio streams, translating between WebSocket text frames and LSP
//! Content-Length–framed messages.
//!
//! Two concurrent tasks run:
//! - **ws→stdin**: read WebSocket text frames, frame them with `Content-Length`,
//!   write to the child's stdin.
//! - **stdout→ws**: read LSP messages from the child's stdout (parsing
//!   `Content-Length` headers), send them as WebSocket text frames.

use futures_util::{SinkExt, StreamExt};
use tokio::io::{BufReader, BufWriter};
use tokio::process::{ChildStdin, ChildStdout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use super::framing;

/// Run the bidirectional relay. Returns when either side closes or on error.
pub async fn relay(
    ws_stream: WebSocketStream<tokio::net::TcpStream>,
    stdin: ChildStdin,
    stdout: ChildStdout,
) -> anyhow::Result<()> {
    let (mut ws_sink, mut ws_source) = ws_stream.split();
    let mut stdin_writer = BufWriter::new(stdin);
    let mut stdout_reader = BufReader::new(stdout);

    // ws → stdin
    let ws_to_stdin = async {
        while let Some(msg) = ws_source.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if let Err(e) = framing::write_message(&mut stdin_writer, &text).await {
                        tracing::error!("failed to write to tinymist stdin: {e}");
                        break;
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {} // ignore non-text frames
                Err(e) => {
                    tracing::error!("websocket read error: {e}");
                    break;
                }
            }
        }
    };

    // stdout → ws
    let stdout_to_ws = async {
        loop {
            match framing::read_message(&mut stdout_reader).await {
                Ok(Some(body)) => {
                    if let Err(e) = ws_sink.send(Message::Text(body.into())).await {
                        tracing::error!("failed to send to websocket: {e}");
                        break;
                    }
                }
                Ok(None) => {
                    tracing::info!("tinymist stdout closed (EOF)");
                    break;
                }
                Err(e) => {
                    tracing::error!("failed to read from tinymist stdout: {e}");
                    break;
                }
            }
        }
    };

    // Run both directions concurrently; the first to finish terminates both.
    tokio::select! {
        _ = ws_to_stdin => {},
        _ = stdout_to_ws => {},
    }

    Ok(())
}
