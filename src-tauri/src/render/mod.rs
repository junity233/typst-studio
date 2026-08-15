//! Render layer — pluggable pipelines turning a `typst::Document` into output.
//!
//! Filled in by Phase 3.

pub mod pdf;
pub mod pdf_options;
pub mod outline;
pub mod pipeline;
pub mod png;
pub mod source_map;
pub mod svg;

#[cfg(test)]
pub(crate) mod test_world;
