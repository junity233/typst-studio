//! LSP integration — spawns tinymist as a child process and bridges it
//! to the frontend via a WebSocket server.

pub mod framing;
pub mod manager;
pub mod relay;
