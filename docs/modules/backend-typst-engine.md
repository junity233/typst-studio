# Backend — Typst engine and render pipelines

> Scope: `src-tauri/src/typst_engine/**`, `src-tauri/src/render/**`, and
> how `export_service` consumes them.

The Rust side embeds the official typst 0.15 compiler behind a long-lived
`EditorWorld`, and renders `PagedDocument`s to SVG (preview), PDF, and PNG
without recompiling.

## typst_engine

- `world.rs` — `EditorWorld` implements typst's `World`. The main source is
  edited in place via `Source::replace`, which preserves syntax-node
  identity so comemo's cross-compile accelerator fast-paths unchanged
  subtrees; `typst::compile` calls `world.track()` per invocation so edits
  are picked up without cache eviction. Non-main file reads resolve VFS
  overlay first (live buffer of any open doc, keyed by canonical path),
  then the `FileResolver` disk read. `take_dependency_paths()` drains the
  compiler-requested FileIds that feed the reverse dependency graph.
- `vfs.rs` — `MemoryVfs`: canonical-path → live open-document buffers,
  owned by `EditorService` and kept in sync with open buffers.
- `compiler.rs` — runs `typst::compile::<PagedDocument>` and converts
  `SourceDiagnostic` → IPC `Diagnostic` (1-indexed lines/cols, per-file
  span resolution). Returns `(CompileOutcome, Option<PagedDocument>)` so
  renderers reuse the document instead of recompiling.
- `font_loader.rs` — process-wide `OnceLock<Arc<FontStore>>` (embedded +
  system scan + `compiler.extraFontDirs`), warmed once at startup. Only the
  FIRST `warm()` call's dirs take effect — changing `extraFontDirs`
  requires an app restart.

Two deliberate quirks: an untitled tab's `EditorWorld` still attaches a
package-only resolver rooted at a throwaway temp dir, so `@preview` imports
resolve but project-rooted includes cannot; package-rooted FileIds are
short-circuited out of the VFS overlay and dependency tracking (probing
them could trigger a network download).

## render

- `pipeline.rs` — the `RenderPipeline` trait (`render(&PagedDocument)`) and
  `RenderError` mapping.
- `svg.rs` — `SvgRenderer`: one SVG string per page (`typst_svg::svg`);
  infallible. This is the live-preview format.
- `pdf.rs` — `PdfRenderer` → a single PDF `Vec<u8>`, with options from
  `pdf_options.rs` (`export.pdfPageRanges/pdfStandard/pdfTagged`, parsed
  strictly — a bare `-` is rejected so a typo can't silently mean "all
  pages").
- `png.rs` — `PngRenderer` → PNG per page at `pixel_per_pt` (default 2.0).
- `source_map.rs` — `build_source_map(doc, world)` → `Vec<LineRect>`
  (source line → page-space bbox) for scroll-sync and click-to-source;
  mirrors `typst_svg`'s transform accumulation, single-DFS span resolution,
  sorted by (page, y).
- `outline.rs` — `build_outline`: heading tree from the introspector via
  `HeadingElem::ELEM.select()`; parents filled by a level stack.
- `test_world.rs` (`#[cfg(test)]`) — the shared `MiniWorld` in-memory
  `typst::World` (embedded fonts, one source) the svg/png/pdf renderer tests
  compile against.

## Export contract (`service/export_service.rs`)

Export renders the tab's **cached** document — it never triggers a
recompile, and it is pinned to the revision the user is looking at, so a
stale compile can never be silently exported. PDF options are applied from
settings via `pdf_options_from_settings`.

## Invariants

- Compile and render share one `PagedDocument` per revision; nothing
  re-runs `typst::compile` for export.
- comemo caching is used across `compile_service`, `tab_state`,
  `document_service`, and `world.rs` — never call `comemo::evict` for
  routine edits; `world.track()` is the supported invalidation.
