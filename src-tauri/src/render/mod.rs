//! Render layer — pluggable pipelines turning a `typst::Document` into output.
//!
//! Filled in by Phase 3.

pub mod pdf;
pub mod pipeline;
pub mod png;
pub mod svg;
