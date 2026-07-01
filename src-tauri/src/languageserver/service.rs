//! `LanguageService` trait + `NoopLs` MVP stub.
//!
//! Future: `TypstIdeLs` wrapping `typst_ide::Ide` for completion / hover /
//! goto-definition.

#![allow(dead_code)]

/// Source position in bytes from the start of the document.
pub struct Position {
    pub offset: usize,
}

/// A completion item returned by the language service.
pub struct Completion {
    pub label: String,
}

/// Range in source byte offsets `[start, end)`.
pub struct Range {
    pub start: usize,
    pub end: usize,
}

/// Abstract language service. MVP ships `NoopLs` returning empty results.
pub trait LanguageService: Send + Sync {
    fn completions(&self, pos: Position) -> Vec<Completion>;
    fn goto_definition(&self, pos: Position) -> Option<Range>;
}

/// No-op implementation used until `typst-ide` integration lands.
pub struct NoopLs;

impl LanguageService for NoopLs {
    fn completions(&self, _pos: Position) -> Vec<Completion> {
        Vec::new()
    }
    fn goto_definition(&self, _pos: Position) -> Option<Range> {
        None
    }
}
