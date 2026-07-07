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

use std::collections::{HashMap, HashSet};

use typst::layout::{Abs, Frame, FrameItem, Point, Transform};
use typst::syntax::Span;
use typst::text::TextItem;
use typst_layout::PagedDocument;

use crate::domain::source_map::LineRect;
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
///
/// ## Performance: batch span→line resolution
///
/// The naive approach (calling `span_to_line` per glyph) is O(glyph_count ×
/// tree_height): each call does `LinkedNode::find_number`, which descends from
/// the syntax-tree root on every lookup. On a dense 3-page document this ran
/// ~9.4s because tens of thousands of glyphs each re-walked the tree.
///
/// Instead we resolve every distinct `Span` in **two passes**:
///   1. Walk all frames once collecting the set of spans (deduplicated).
///   2. For each `FileId` referenced, do a single DFS over its syntax tree,
///      recording byte ranges for exactly the `SpanNumber`s we need. Span
///      numbers are monotonic (parent < children, siblings increase), so one
///      DFS resolves all spans of a source in O(node_count).
/// Then the geometry pass looks each span up in the precomputed map — O(1).
pub fn build_source_map(doc: &PagedDocument, world: &EditorWorld) -> Vec<LineRect> {
    // --- Pass 1: collect the set of distinct spans we need to resolve. -------
    let mut needed_spans: HashSet<Span> = HashSet::new();
    {
        let mut collect_ctx = CollectCtx { needed: &mut needed_spans };
        for page in doc.pages().iter() {
            collect_frame(&mut collect_ctx, &page.frame);
        }
    }

    // --- Pass 2: resolve each distinct span → source line, once. -------------
    // The resolver memoizes per-span; the first lookup for each (FileId, span)
    // pays for a single source-wide DFS, all subsequent lookups are O(1). The
    // DFS itself is driven lazily on the first request for a given FileId and
    // then reused, so the total work across all spans of one source is O(nodes).
    let resolver = SpanLineResolver::new(world, &needed_spans);

    // --- Geometry pass: walk frames again, looking up precomputed lines. -----
    // Key: (page_idx, source_line) → accumulator. A line may appear on multiple
    // pages (e.g. page-spanning paragraphs); we keep one accumulator per page.
    let mut by_line: HashMap<(u16, u32), LineAccum> = HashMap::new();

    for (page_idx, page) in doc.pages().iter().enumerate() {
        let page_idx = u16::try_from(page_idx).unwrap_or(u16::MAX);
        let mut ctx = WalkCtx {
            resolver: &resolver,
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

/// Deduplicated, single-DFS span→line resolver.
///
/// Two earlier inefficiencies, both now fixed:
/// 1. Originally `span_to_line` ran **per glyph** (O(glyphs × tree-height)).
/// 2. After dedup it ran per distinct span, but each call still did an
///    independent `LinkedNode::find_number` descent from the root
///    (O(distinct × tree-height)) — profiling showed `world.range` alone was
///    82% of the remaining cost.
///
/// This version walks each referenced source's syntax tree **once**, recording
/// the byte offset of every node whose span number is among the ones we need.
/// That single pass resolves all spans of a source in O(node_count), replacing
/// N independent root-descents. The number→line conversion then uses the
/// source's prebuilt `Lines` table (O(log lines) each).
struct SpanLineResolver<'a> {
    world: &'a EditorWorld,
    /// `Span → 1-indexed line` for every distinct span seen in the document.
    /// `None` means the span was resolved but points nowhere (detached /
    /// synthesized); cached so we don't re-attempt it.
    map: HashMap<Span, Option<u32>>,
}

/// The low 48 bits of a `Span`'s raw encoding hold its number within a source.
/// `SpanNumber` is `pub(crate)`, so we extract the bits ourselves via the
/// public `into_raw()`. Two spans with the same extracted number AND the same
/// `FileId` are the same source location.
const SPAN_NUMBER_MASK: u64 = (1 << 48) - 1;

impl<'a> SpanLineResolver<'a> {
    fn new(world: &'a EditorWorld, needed: &HashSet<Span>) -> Self {
        // Group needed spans by FileId so each source's tree is walked once.
        // Range-variant spans (external files) carry their bytes directly and
        // never enter the tree walk; collect their byte→line separately.
        let mut by_id: HashMap<typst::syntax::FileId, HashSet<u64>> = HashMap::new();
        let mut range_spans: Vec<(Span, usize)> = Vec::new(); // (span, byte_start)
        let mut detached: Vec<Span> = Vec::new();

        for &span in needed {
            use typst::syntax::SpanKind;
            match span.get() {
                SpanKind::Number { id, num, .. } => {
                    // SpanNumber is pub(crate); extract the bits via into_raw.
                    // `num` was derived from `span.number()` (source.rs:179),
                    // which IS `into_raw().get() & SPAN_NUMBER_MASK`, so reading
                    // the same bits off the span itself yields the identical key.
                    let num_bits = span.into_raw().get() & SPAN_NUMBER_MASK;
                    let _ = num; // (opaque; we use num_bits instead)
                    by_id.entry(id).or_default().insert(num_bits);
                }
                SpanKind::Range { id: _, range } => {
                    range_spans.push((span, range.start));
                }
                SpanKind::Detached => {
                    detached.push(span);
                }
            }
        }

        let mut map: HashMap<Span, Option<u32>> = HashMap::with_capacity(needed.len());
        // Detached spans never resolve.
        for span in detached {
            map.insert(span, None);
        }

        // Range spans: resolve their byte offset to a line via the source's
        // Lines table. Grouped with the Number spans of the same source so we
        // fetch each source only once.
        for (span, byte_start) in &range_spans {
            let line = line_at_byte(world, span.id(), *byte_start);
            map.insert(*span, line);
        }

        // Number spans: one DFS per source resolves all its needed numbers.
        for (id, needed_nums) in by_id {
            let Some(source) = world.source_for_id(id) else {
                // Source unreadable — leave these spans absent from the map; the
                // `resolve()` fallback handles any stragglers (returning None).
                continue;
            };
            let number_to_line = resolve_numbers_via_dfs(&source, &needed_nums);
            // Fill the map: for each needed span of this source, look up its
            // number's line. We iterate `needed` (not `needed_nums`) because we
            // need the full Span as the map key.
            for &span in needed {
                use typst::syntax::SpanKind;
                if matches!(span.get(), SpanKind::Number { id: sid, .. } if sid == id) {
                    let num_bits = span.into_raw().get() & SPAN_NUMBER_MASK;
                    let line = number_to_line.get(&num_bits).copied();
                    map.insert(span, line);
                }
            }
        }

        Self { world, map }
    }

    /// Resolve a span to a 1-indexed line, or `None` if detached / unresolvable.
    /// O(1) — the work was done up front in [`Self::new`]. A span not seen by
    /// the collector falls back to a one-off resolution.
    #[inline]
    fn resolve(&self, span: Span) -> Option<u32> {
        if let Some(line) = self.map.get(&span) {
            return *line;
        }
        // Fallback for spans the collector missed (shouldn't happen in practice
        // since collect_frame walks the same items as walk_frame).
        resolve_one(span, self.world)
    }
}

/// Resolve a batch of span numbers to 1-indexed lines via a SINGLE depth-first
/// traversal of the source's syntax tree.
///
/// Each `SyntaxNode` carries a span; its number (low 48 bits) is monotonic in
/// the tree but we don't rely on that — we just visit every node once and record
/// those whose number is in `needed`. Total work is O(node_count), independent
/// of how many distinct spans we need.
fn resolve_numbers_via_dfs(
    source: &typst::syntax::Source,
    needed: &HashSet<u64>,
) -> HashMap<u64, u32> {
    use typst::syntax::SyntaxNode;
    let mut out: HashMap<u64, u32> = HashMap::with_capacity(needed.len());
    // Early exit if nothing is needed from this source.
    if needed.is_empty() {
        return out;
    }
    let lines = source.lines();
    // Iterative DFS to avoid recursion overhead / stack growth on deep trees.
    // We track byte offset manually (SyntaxNode doesn't carry its absolute
    // offset; LinkedNode does, but it allocates an Rc per node — heavier than
    // this explicit stack).
    let root = source.root();
    let mut stack: Vec<(&SyntaxNode, usize)> = vec![(root, 0)];
    while let Some((node, offset)) = stack.pop() {
        // Does this node's span number match one we need?
        let num_bits = node.span().into_raw().get() & SPAN_NUMBER_MASK;
        if needed.contains(&num_bits) {
            if let Some((line, _)) = lines.byte_to_line_column(offset) {
                if let Ok(l) = u32::try_from(line + 1) {
                    out.insert(num_bits, l);
                }
            }
        }
        // Stop early once we've resolved everything (rare hit, but cheap to check).
        if out.len() == needed.len() {
            break;
        }
        // Push children with their correct absolute byte offsets. We iterate
        // children LEFT-TO-RIGHT accumulating offsets, then push in reverse so
        // the stack (LIFO) visits them in source order. Reversing BEFORE
        // accumulating would scramble the offsets — a bug that previously made
        // every lookup return line 1.
        let mut child_offset = offset;
        let mut children: Vec<(&SyntaxNode, usize)> = Vec::new();
        for child in node.children() {
            children.push((child, child_offset));
            child_offset += child.len();
        }
        // Push in reverse so the first child is popped first.
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }
    out
}

/// Convert a byte offset in a source to a 1-indexed line.
fn line_at_byte(
    world: &EditorWorld,
    id: Option<typst::syntax::FileId>,
    byte_start: usize,
) -> Option<u32> {
    let source = id
        .and_then(|id| world.source_for_id(id))
        .unwrap_or_else(|| world.main_source());
    let (line, _) = source.lines().byte_to_line_column(byte_start)?;
    u32::try_from(line + 1).ok()
}

/// Resolve a single span to a 1-indexed line — the one-off fallback path.
/// Kept for `resolve()`'s defensive fallback; the hot path goes through the
/// precomputed map.
fn resolve_one(span: Span, world: &EditorWorld) -> Option<u32> {
    use typst::WorldExt;
    let bytes = world.range(span)?;
    line_at_byte(world, span.id(), bytes.start)
}

/// Pass-1 collector: gathers every distinct span the geometry pass will need,
/// so the resolver can pre-compute their lines in one shot (deduplicated) rather
/// than per-glyph.
struct CollectCtx<'a> {
    needed: &'a mut HashSet<Span>,
}

fn collect_frame(ctx: &mut CollectCtx, frame: &Frame) {
    for (_pos, item) in frame.items() {
        match item {
            FrameItem::Text(text) => {
                for glyph in &text.glyphs {
                    ctx.needed.insert(glyph.span.0);
                }
            }
            FrameItem::Group(group) => collect_frame(ctx, &group.frame),
            FrameItem::Shape(_, span) | FrameItem::Image(_, _, span) => {
                ctx.needed.insert(*span);
            }
            FrameItem::Link(_, _) | FrameItem::Tag(_) => {}
        }
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

struct WalkCtx<'a> {
    resolver: &'a SpanLineResolver<'a>,
    page_idx: u16,
    by_line: &'a mut HashMap<(u16, u32), LineAccum>,
    transform: Transform,
}

impl<'a> WalkCtx<'a> {
    /// Record a shape/image anchor (no advance geometry — a single point).
    fn record_anchor(&mut self, span: Span) {
        let Some(line) = self.resolver.resolve(span) else {
            return;
        };
        let (px, py) = apply_transform(&self.transform, Point::zero());
        self.by_line
            .entry((self.page_idx, line))
            .or_default()
            .add_point(px, py);
    }
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
            resolver: ctx.resolver,
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
    // O(1) memoized lookup — the per-distinct-span tree descent happened once in
    // SpanLineResolver::new. This is the fix for the old O(glyphs × tree_height)
    // behavior where every glyph re-descended from the syntax-tree root.
    let Some(line) = ctx.resolver.resolve(span) else {
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

    /// PERFORMANCE benchmark for `build_source_map` — the fix target.
    ///
    /// Builds a document dense in glyphs (many short lines of CJK text, which
    /// each render as a distinct glyph) and times `build_source_map` over a few
    /// iterations. Before the fix (per-glyph `find_number` from the tree root),
    /// this scaled as O(glyphs × tree-height); after the single-DFS resolver it
    /// is roughly linear in syntax-node count.
    ///
    /// Run with:
    ///   cargo test --lib build_source_map_perf -- --nocapture --ignored
    #[test]
    #[ignore]
    fn build_source_map_perf() {
        // Helper: count total glyphs and collect distinct spans in a frame tree.
        fn count_glyphs(frame: &Frame, glyphs: &mut usize, distinct: &mut HashSet<Span>) {
            use typst::layout::{FrameItem};
            for (_pos, item) in frame.items() {
                match item {
                    FrameItem::Text(text) => {
                        for g in &text.glyphs {
                            *glyphs += 1;
                            distinct.insert(g.span.0);
                        }
                    }
                    FrameItem::Group(group) => count_glyphs(&group.frame, glyphs, distinct),
                    FrameItem::Shape(_, span) | FrameItem::Image(_, _, span) => {
                        distinct.insert(*span);
                    }
                    FrameItem::Link(_, _) | FrameItem::Tag(_) => {}
                }
            }
        }
        // ~1200 lines of CJK-ish text → each line ~12 glyphs → tens of
        // thousands of glyphs across a few pages, mirroring the user's
        // reported "dense single/multi-page" scenario.
        let mut src = String::from("#set page(width: 21cm, height: 29.7cm)\n\n");
        for i in 0..1200 {
            // Mix of CJK and latin; each char is a glyph. Repeat to grow glyph count.
            src.push_str(&format!("第{i}行 测试文本编译性能 abcdefghijklmnop 汉字字形映射检验\n"));
        }

        let w = world(&src);
        let (outcome, doc) = crate::typst_engine::compiler::compile(&w);
        assert!(outcome.success, "errors: {:?}", outcome.errors);
        let doc = doc.expect("doc on success");

        let n_pages = doc.pages().len();
        println!("\n=== build_source_map perf ===");
        println!("compile_ms={}, pages={n_pages}", outcome.duration_ms);

        // Count total glyphs vs distinct spans — the dedup ratio is the win.
        let mut total_glyphs: usize = 0;
        let mut distinct: HashSet<Span> = HashSet::new();
        for page in doc.pages().iter() {
            count_glyphs(&page.frame, &mut total_glyphs, &mut distinct);
        }
        println!(
            "glyphs={total_glyphs}, distinct_spans={} (dedup ratio {:.1}×)",
            distinct.len(),
            total_glyphs as f64 / distinct.len().max(1) as f64,
        );

        // Warm up (first run primes any caches).
        let _ = build_source_map(&doc, &w);

        // Measure 5 iterations, report min (least noise) and mean.
        const ITER: usize = 5;
        let mut samples: Vec<u128> = Vec::with_capacity(ITER);
        for _ in 0..ITER {
            let t = std::time::Instant::now();
            let map = build_source_map(&doc, &w);
            let elapsed = t.elapsed().as_micros();
            samples.push(elapsed);
            // Keep `map` alive so we don't measure with the optimizer eliding it.
            std::hint::black_box(&map);
        }
        let min_us = *samples.iter().min().unwrap();
        let mean_us = samples.iter().sum::<u128>() as f64 / ITER as f64;
        println!(
            "build_source_map: min={min_us} µs ({:.1} ms), mean={mean_us:.0} µs ({:.1} ms) over {ITER} iters",
            min_us as f64 / 1000.0,
            mean_us / 1000.0,
        );
        println!("samples (µs): {samples:?}");

        // --- CONTROL: the OLD per-glyph path (resolve every glyph's span
        // independently via find_number) — to measure the actual speedup.
        // This mirrors the pre-fix `span_to_line` call per glyph.
        let t_old = std::time::Instant::now();
        let mut old_lines: HashSet<u32> = HashSet::new();
        for page in doc.pages().iter() {
            collect_old_lines(&page.frame, &w, &mut old_lines);
        }
        let old_us = t_old.elapsed().as_micros();
        println!(
            "OLD per-glyph resolve: {} µs ({:.1} ms) — speedup {:.1}×",
            old_us,
            old_us as f64 / 1000.0,
            old_us as f64 / min_us as f64,
        );
    }

    /// Control helper: resolve every glyph's span the OLD way (one
    /// `span_to_line` / find_number per glyph), to measure the speedup.
    fn collect_old_lines(frame: &Frame, w: &EditorWorld, out: &mut HashSet<u32>) {
        use typst::layout::FrameItem;
        for (_pos, item) in frame.items() {
            match item {
                FrameItem::Text(text) => {
                    for g in &text.glyphs {
                        if let Some(line) = crate::typst_engine::compiler::span_to_line(g.span.0, w) {
                            out.insert(line);
                        }
                    }
                }
                FrameItem::Group(group) => collect_old_lines(&group.frame, w, out),
                FrameItem::Shape(_, span) | FrameItem::Image(_, _, span) => {
                    if let Some(line) = crate::typst_engine::compiler::span_to_line(*span, w) {
                        out.insert(line);
                    }
                }
                FrameItem::Link(_, _) | FrameItem::Tag(_) => {}
            }
        }
    }
}
