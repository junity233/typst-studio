//! Source-map builder — walks a compiled [`PagedDocument`] once to map each
//! source line to its bounding rectangle on a preview page.
//!
//! ## Why this exists
//!
//! The live preview is a rasterized blob-URL `<img>` (`SvgPage.tsx`); the SVG
//! emitted by `typst-svg` carries no source-location metadata (its
//! `SvgOptions` only has `render_bleed` / `pretty`). But the compiled
//! [`PagedDocument`] — retained per tab in `TabState::last_doc` — annotates
//! every glyph with its source [`Span`]. [`build_source_map`] walks that frame
//! tree and produces one [`LineRect`] per source line, which the frontend uses
//! for scroll-sync and click-to-source.
//!
//! ## Geometry
//!
//! Output coordinates are in Typst's page space (points, y-down, origin at the
//! page top-left). This mirrors exactly what `typst-svg` renders into the
//! `<svg viewBox>`, so the frontend can rescale clicks by the `<img>`'s
//! `naturalWidth / getBoundingClientRect().width` ratio (which already absorbs
//! the CSS `zoom` setting) and hit-test directly against these rects.
//!
//! The transform accumulation mirrors `typst_svg::SVGRenderer::render_frame`
//! (`state.pre_translate(pos)` per item; `pre_concat(group.transform)` for
//! soft groups; transform reset for hard groups). Text uses a y-up glyph
//! space flipped by `Transform::scale(1, -1)`, exactly as `typst_svg::text`
//! does.

use std::collections::HashMap;

use typst::layout::{Abs, Frame, FrameItem, Point, Transform};
use typst::syntax::Span;
use typst::text::TextItem;
use typst_layout::PagedDocument;

use crate::domain::source_map::LineRect;
use crate::typst_engine::compiler::span_to_line;
use crate::typst_engine::world::EditorWorld;

/// A line's accumulated geometry while walking the frame tree.
#[derive(Clone, Copy, Default)]
struct LineAccum {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
    seen: bool,
}

impl LineAccum {
    fn add_point(&mut self, x: f64, y: f64) {
        if !self.seen {
            self.min_x = x;
            self.max_x = x;
            self.min_y = y;
            self.max_y = y;
            self.seen = true;
        } else {
            self.min_x = self.min_x.min(x);
            self.max_x = self.max_x.max(x);
            self.min_y = self.min_y.min(y);
            self.max_y = self.max_y.max(y);
        }
    }
}

/// Build a `Vec<LineRect>` mapping each source line to its page-space bbox.
///
/// One rect per source line, across all pages it touches (a line that wraps or
/// reflows onto multiple pages yields multiple rects). Output is sorted by
/// `(page, y)` so the frontend can binary-search for the rect nearest a scroll
/// position or click.
pub fn build_source_map(doc: &PagedDocument, world: &EditorWorld) -> Vec<LineRect> {
    // Key: (page_idx, source_line) → accumulator. A line may appear on multiple
    // pages (e.g. page-spanning paragraphs); we keep one accumulator per page.
    let mut by_line: HashMap<(u16, u32), LineAccum> = HashMap::new();

    for (page_idx, page) in doc.pages().iter().enumerate() {
        let page_idx = u16::try_from(page_idx).unwrap_or(u16::MAX);
        let mut ctx = WalkCtx {
            world,
            page_idx,
            by_line: &mut by_line,
            transform: Transform::identity(),
        };
        walk_frame(&mut ctx, &page.frame);
    }

    let mut rects: Vec<LineRect> = by_line
        .into_iter()
        .filter_map(|((page, line), a)| {
            if !a.seen {
                return None;
            }
            Some(LineRect {
                line,
                page,
                x: a.min_x as f32,
                y: a.min_y as f32,
                w: (a.max_x - a.min_x) as f32,
                h: (a.max_y - a.min_y) as f32,
            })
        })
        .collect();

    // Sort by (page, y, line) for deterministic output and frontend lookup.
    rects.sort_by(|a, b| {
        a.page
            .cmp(&b.page)
            .then(a.y.total_cmp(&b.y))
            .then(a.line.cmp(&b.line))
    });
    rects
}

struct WalkCtx<'a> {
    world: &'a EditorWorld,
    page_idx: u16,
    by_line: &'a mut HashMap<(u16, u32), LineAccum>,
    transform: Transform,
}

impl<'a> WalkCtx<'a> {
    /// Record a shape/image anchor (no advance geometry — a single point).
    fn record_anchor(&mut self, span: Span) {
        let Some(line) = span_to_line(span, self.world) else {
            return;
        };
        let (px, py) = apply_transform(&self.transform, Point::zero());
        self.by_line
            .entry((self.page_idx, line))
            .or_default()
            .add_point(px, py);
    }
}

/// Apply a transform to a point, returning page-space (x, y) in pt.
#[inline]
fn apply_transform(t: &Transform, p: Point) -> (f64, f64) {
    let x = p.x.to_pt();
    let y = p.y.to_pt();
    let nx = t.sx.get() * x + t.kx.get() * y + t.tx.to_pt();
    let ny = t.ky.get() * x + t.sy.get() * y + t.ty.to_pt();
    (nx, ny)
}

/// Recursively walk a frame, mirroring `typst_svg::render_frame`.
fn walk_frame(ctx: &mut WalkCtx, frame: &Frame) {
    // Record a vertical extent per text line so wrapped lines keep height even
    // before we see multiple glyphs. We expand each glyph's recorded point by
    // half the font size above/below the baseline to form a usable bbox.
    for (pos, item) in frame.items() {
        // Each item is positioned at `pos` relative to the current frame's
        // origin — pre-translate, exactly like `typst_svg::State::pre_translate`.
        let mut child = WalkCtx {
            world: ctx.world,
            page_idx: ctx.page_idx,
            by_line: ctx.by_line,
            transform: ctx.transform.pre_concat(Transform::translate(pos.x, pos.y)),
        };
        match item {
            FrameItem::Text(text) => walk_text(&mut child, text),
            FrameItem::Group(group) => {
                // typst-svg distinguishes Soft vs Hard frames, but only to
                // decide whether to emit a transform on the outer <g> (Hard)
                // vs fold it into the running state (Soft), and to reset
                // `state.size` for gradient coordinate reference frames. We
                // have no nested <g> and ignore paint transforms, so for our
                // purposes child geometry lands in page space identically in
                // both cases: the cumulative transform keeps composing the
                // group's transform onto the running one. (Collapsing Hard
                // into the Soft path is correct *because* we flatten to page
                // space; typst-svg's child-transform reset only works under
                // SVG group composition, which we don't model.)
                let _ = group.frame.kind();
                child.transform = child.transform.pre_concat(group.transform);
                walk_frame(&mut child, &group.frame);
            }
            FrameItem::Shape(_, span) | FrameItem::Image(_, _, span) => {
                child.record_anchor(*span);
            }
            FrameItem::Link(_, _) | FrameItem::Tag(_) => {}
        }
    }
}

/// Walk a text run, recording each glyph's baseline position in page space.
///
/// Glyphs live in a y-up space relative to the text run's origin (the
/// baseline); `typst_svg::render_text` flips it with `Transform::scale(1, -1)`
/// before placing glyphs. We mirror that flip inline (negate y) and accumulate
/// glyph advances into a local cursor, exactly as `render_text` does.
fn walk_text(ctx: &mut WalkCtx, text: &TextItem) {
    let size = text.size;
    let mut x = Abs::pt(0.0);
    let mut y = Abs::pt(0.0);
    for glyph in &text.glyphs {
        // typst-svg places the glyph at (cursor + x_offset), then advances the
        // cursor by x_advance (offset does not consume advance). Pass both the
        // cursor and the anchor so the box can span [anchor, cursor+advance]
        // without double-counting the offset.
        let anchor_x = x + glyph.x_offset.at(size);
        let anchor_y = y + glyph.y_offset.at(size);
        let advance = glyph.x_advance.at(size);
        record_glyph(ctx, glyph.span.0, x, anchor_x, anchor_y, advance, size.to_pt());
        x += glyph.x_advance.at(size);
        y += glyph.y_advance.at(size);
    }
}

/// Record a glyph's contribution to its source line's bbox.
///
/// `cursor_x` is the run cursor (advances by `x_advance`); `anchor_x`/`anchor_y`
/// are where the glyph is actually drawn (`cursor + offset`). `advance` is the
/// horizontal advance; `size` gives the box vertical extent around the baseline.
fn record_glyph(
    ctx: &mut WalkCtx,
    span: Span,
    cursor_x: Abs,
    anchor_x: Abs,
    anchor_y: Abs,
    advance: Abs,
    size: f64,
) {
    let Some(line) = span_to_line(span, ctx.world) else {
        return;
    };
    // Span the box from the glyph's draw position to (cursor + advance), so an
    // x_offset extends the left edge but never double-counts into the right.
    let left = anchor_x.to_pt().min(cursor_x.to_pt());
    let right = (cursor_x.to_pt() + advance.to_pt()).max(anchor_x.to_pt());
    let baseline = -anchor_y.to_pt(); // flip y-up → page y-down
    let top = baseline - size * 0.8; // ascender
    let bottom = baseline + size * 0.2; // small descender

    let corners = [
        Point::new(Abs::pt(left), Abs::pt(top)),
        Point::new(Abs::pt(right), Abs::pt(bottom)),
    ];
    let acc = ctx.by_line.entry((ctx.page_idx, line)).or_default();
    for c in corners {
        let (px, py) = apply_transform(&ctx.transform, c);
        acc.add_point(px, py);
    }
}

#[cfg(test)]
mod tests {
    //! Reuses the `MiniWorld` pattern from `svg.rs` tests — a tiny in-memory
    //! world with embedded fonts — to exercise `build_source_map` end-to-end
    //! against a real compiled `PagedDocument`.

    use super::*;
    use crate::typst_engine::world::EditorWorld;
    use crate::typst_engine::font_loader::SystemFontLoader;

    fn world(text: &str) -> EditorWorld {
        // Embedded-only: deterministic, no system font scan.
        EditorWorld::with_font_loader(text, SystemFontLoader::embedded_only())
    }

    #[test]
    fn returns_one_rect_per_body_line() {
        // Note: a single `\n` is a *space* in Typst, not a paragraph break.
        // Two body paragraphs need a blank line between them so they render on
        // distinct visual lines.
        let src = "#set page(width: 10cm)\n\nLine one\n\nLine two";
        let w = world(src);
        let (outcome, doc) = crate::typst_engine::compiler::compile(&w);
        assert!(outcome.success, "errors: {:?}", outcome.errors);
        let doc = doc.expect("doc on success");
        let map = build_source_map(&doc, &w);

        // "Line one" is line 3, "Line two" is line 5 (blank line 4).
        let lines: Vec<u32> = map.iter().map(|r| r.line).collect();
        assert!(lines.contains(&3), "expected line 3, got {lines:?}");
        assert!(lines.contains(&5), "expected line 5, got {lines:?}");

        // All rects are on page 0.
        assert!(map.iter().all(|r| r.page == 0));

        // Two paragraphs on distinct visual lines → line 3 sits above line 5.
        let r3 = map.iter().find(|r| r.line == 3).unwrap();
        let r5 = map.iter().find(|r| r.line == 5).unwrap();
        assert!(r3.y < r5.y, "line 3 should be above line 5: {r3:?} vs {r5:?}");
        assert!(r3.h > 0.0, "line 3 rect should have positive height");
        assert!(r3.w > 0.0, "line 3 rect should have positive width");
    }

    #[test]
    fn empty_document_still_compiles_and_yields_no_body_lines() {
        let w = world("#set page(width: 10cm)");
        let (outcome, doc) = crate::typst_engine::compiler::compile(&w);
        assert!(outcome.success, "errors: {:?}", outcome.errors);
        let doc = doc.expect("doc on success");
        let map = build_source_map(&doc, &w);
        // No body text → no source-mapped lines.
        assert!(
            map.is_empty() || map.iter().all(|r| r.line <= 1),
            "expected no body lines, got {map:?}"
        );
    }

    #[test]
    fn rects_are_sorted_by_page_then_y() {
        let w = world("#set page(width: 10cm)\n\nAlpha\nBeta\nGamma");
        let (outcome, doc) = crate::typst_engine::compiler::compile(&w);
        assert!(outcome.success);
        let doc = doc.unwrap();
        let map = build_source_map(&doc, &w);
        for w in map.windows(2) {
            assert!(
                (w[0].page, w[0].y) <= (w[1].page, w[1].y),
                "rects must be sorted by (page, y): {:?} before {:?}",
                w[0],
                w[1]
            );
        }
    }

    /// Regression guard for the Hard-frame transform bug: body text renders
    /// inside a Hard `block` frame whose origin is offset from the page origin
    /// by the page margins. If `walk_frame` reset the transform to identity for
    /// Hard frames, the recorded y would be near 0 (the block's local origin)
    /// instead of the real ~margin offset. A 10cm page with default margins
    /// places the first body line well below 20pt and within the page height.
    #[test]
    fn absolute_coords_reflect_page_margins_not_local_origin() {
        // 10cm wide × ~auto height; default margins are 2.5cm top/left.
        let w = world("#set page(width: 10cm)\n\nHello");
        let (outcome, doc) = crate::typst_engine::compiler::compile(&w);
        assert!(outcome.success);
        let doc = doc.expect("doc");
        let map = build_source_map(&doc, &w);
        let r = map
            .iter()
            .find(|r| r.line == 3)
            .expect("body line 3 should be mapped");
        // 2.5cm top margin ≈ 70.87pt. The "Hello" baseline sits a bit below
        // that. If the Hard-frame reset bug were present, r.y would be near 0
        // (local block origin) or even negative. Require a sensible margin.
        assert!(
            r.y > 20.0,
            "line 3 y should reflect the page's top margin (~70pt), got {r:?} \
             — a near-zero value indicates the Hard-frame transform was reset"
        );
        // Sanity: x should be past the left margin, not at the page edge.
        assert!(
            r.x > 20.0,
            "line 3 x should be past the left margin, got {r:?}"
        );
    }

    /// VERIFICATION harness (run manually): compiles the long demo document,
    /// builds the source map, overlays each `LineRect` as a red `<rect>` on the
    /// rendered page SVG, writes the overlays to `/tmp/demo-overlay-N.svg`, and
    /// prints a table mapping source line → its rect + source-text snippet.
    ///
    /// Run with:
    ///   cargo test --lib verify_demo_overlay -- --nocapture --ignored
    ///
    /// Then open the `/tmp/demo-overlay-*.svg` files in a browser to visually
    /// confirm the red boxes sit on top of the rendered text they came from.
    #[test]
    #[ignore]
    fn verify_demo_overlay() {
        use std::fs;
        // Resolve relative to the crate (CARGO_MANIFEST_DIR = .../src-tauri).
        let manifest = env!("CARGO_MANIFEST_DIR");
        let src_path = format!("{manifest}/../scroll-sync-demo.typ");
        let src = fs::read_to_string(&src_path)
            .unwrap_or_else(|e| panic!("read {src_path}: {e}"));
        let lines: Vec<&str> = src.lines().collect();

        let w = world(&src);
        let (outcome, doc) = crate::typst_engine::compiler::compile(&w);
        assert!(outcome.success, "demo should compile: {:?}", outcome.errors);
        let doc = doc.expect("doc");
        let map = build_source_map(&doc, &w);
        let pages = crate::render::svg::SvgRenderer
            .render(&doc)
            .expect("svg render is infallible");
        // Need the trait in scope for `.render`.
        use crate::render::pipeline::RenderPipeline;

        println!("\n=== {} pages, {} line-rects ===\n", pages.len(), map.len());
        println!(
            "{:>5}  {:>5}  {:>8}  {:>8}  {:>7}  {:>5}  source",
            "line", "page", "x(pt)", "y(pt)", "w", "h"
        );
        for r in &map {
            let idx = (r.line as usize).saturating_sub(1);
            let snippet = lines
                .get(idx)
                .map(|s| s.trim())
                .unwrap_or("<beyond EOF>")
                .chars()
                .take(60)
                .collect::<String>();
            println!(
                "{:>5}  {:>5}  {:>8.2}  {:>8.2}  {:>7.2}  {:>5.2}  {}",
                r.line, r.page, r.x, r.y, r.w, r.h, snippet
            );
        }

        // Overlay: inject a red stroke <rect> per LineRect right before </svg>.
        for (page_idx, svg) in pages.iter().enumerate() {
            let page_rects: Vec<&LineRect> =
                map.iter().filter(|r| r.page as usize == page_idx).collect();
            let mut overlay = String::new();
            for r in &page_rects {
                overlay.push_str(&format!(
                    "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" \
                     fill=\"none\" stroke=\"red\" stroke-width=\"0.8\"/>\n",
                    r.x, r.y, r.w, r.h
                ));
            }
            // Also drop a small line-number label at each rect's left edge.
            for r in &page_rects {
                overlay.push_str(&format!(
                    "<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"7\" fill=\"red\">L{}</text>\n",
                    r.x.max(2.0),
                    r.y + r.h * 0.7,
                    r.line
                ));
            }
            let annotated = svg.replace("</svg>", &format!("{overlay}</svg>"));
            let out = format!("/tmp/demo-overlay-{}.svg", page_idx + 1);
            fs::write(&out, &annotated).unwrap();
            println!("wrote {} ({} rects)", out, page_rects.len());
        }
        println!("\nOpen /tmp/demo-overlay-*.svg in a browser to inspect alignment.");
    }
}
