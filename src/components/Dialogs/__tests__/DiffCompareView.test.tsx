import { describe, it, expect, afterEach } from "vitest";
// Initialize i18next so `useTranslation("dialog")` resolves real labels — the
// no-differences note and the unchanged-lines plural come from the "dialog"
// namespace, and the assertions pin their English text (jsdom's
// navigator.language is en-US, so `resolveLanguage` picks "en").
import "../../../i18n";
// Shared createRoot + act harness (also sets IS_REACT_ACT_ENVIRONMENT).
import { reactHarness } from "../../../test/react";
import { DiffCompareView } from "../DiffCompareView";

/**
 * Render-level tests for `DiffCompareView` — the side-by-side compare shared
 * by the conflict-resolution (§5.4) and crash-recovery (§5.1.3) dialogs, i.e.
 * the last thing the user sees before deciding which version of their work to
 * keep. The underlying row model (`lib/diff.ts`) has its own tests; these pin
 * the RENDERING layer on top of it:
 *
 *  - column headers + the body region's aria-label.
 *  - the "No differences" note (and the absence of del/add cells).
 *  - pure add / pure del rows land on the right / left column.
 *  - paired changed lines emphasize the differing WORDS (del left, add right)
 *    while common words stay unemphasized.
 *  - CRLF and lone-CR line endings are normalized before diffing (Windows
 *    saves must not show as a screenful of fake changes).
 *  - long unchanged runs collapse to a gap row with the hidden-line count.
 *  - `rightText === null` (recovery: snapshot's file is gone) degrades the
 *    left pane to plain context + the rightMissingLabel note.
 *  - empty left text with a null right side renders zero rows (git's
 *    empty-string-as-zero-lines semantics).
 */

const PROPS = {
  ariaLabel: "Compare versions",
  leftLabel: "Editor buffer",
  rightLabel: "Disk",
} as const;

const h = reactHarness();

const renderDiff = (props: {
  leftText: string;
  rightText: string | null;
  rightMissingLabel?: string;
}): HTMLDivElement => h.render(<DiffCompareView {...PROPS} {...props} />);

/** The row that has BOTH a del cell and an add cell — i.e. a paired change. */
const pairRow = (c: HTMLElement): HTMLElement => {
  const row = [...c.querySelectorAll<HTMLElement>(".diffcmp-row")].find(
    (r) =>
      r.querySelector(".diffcmp-cell--del") !== null &&
      r.querySelector(".diffcmp-cell--add") !== null,
  );
  if (!row) throw new Error("no pair row found");
  return row;
};

describe("DiffCompareView", () => {
  afterEach(() => h.cleanup());

  it("renders both column headers and the aria-labelled body region", () => {
    const c = renderDiff({ leftText: "a", rightText: "b" });
    const labels = [...c.querySelectorAll(".diffcmp-label")].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Editor buffer", "Disk"]);
    const body = c.querySelector('[role="region"]');
    expect(body).not.toBeNull();
    expect(body!.getAttribute("aria-label")).toBe("Compare versions");
  });

  it("shows the no-differences note and no del/add cells for equal texts", () => {
    const c = renderDiff({ leftText: "a\nb", rightText: "a\nb" });
    expect(c.querySelector(".diffcmp-note")?.textContent).toMatch(
      /no differences/i,
    );
    expect(c.querySelector(".diffcmp-cell--del")).toBeNull();
    expect(c.querySelector(".diffcmp-cell--add")).toBeNull();
  });

  it("renders a purely added line in the right column with an empty left cell", () => {
    const c = renderDiff({ leftText: "a\nb", rightText: "a\nb\nc" });
    const addCell = c.querySelector(".diffcmp-cell--add");
    expect(addCell?.textContent).toBe("c");
    const row = addCell!.closest(".diffcmp-row")!;
    // The paired left cell exists but carries no del marker and no text.
    const leftCell = row.querySelector(".diffcmp-cell--left")!;
    expect(leftCell.textContent).toBe("");
    expect(leftCell.classList.contains("diffcmp-cell--del")).toBe(false);
  });

  it("renders a purely deleted line in the left column with an empty right cell", () => {
    const c = renderDiff({ leftText: "a\nb\nc", rightText: "a\nb" });
    const delCell = c.querySelector(".diffcmp-cell--del");
    expect(delCell?.textContent).toBe("c");
    const row = delCell!.closest(".diffcmp-row")!;
    // The right cell of the row is a plain (unmarked, empty) cell.
    const rightCell = row.children[1] as HTMLElement;
    expect(rightCell.classList.contains("diffcmp-cell--add")).toBe(false);
    expect(rightCell.textContent).toBe("");
  });

  it("emphasizes the differing words of a paired changed line on the correct sides", () => {
    const c = renderDiff({
      leftText: "the quick brown fox",
      rightText: "the quick red fox",
    });
    const row = pairRow(c);
    const leftCell = row.querySelector(".diffcmp-cell--del")!;
    const rightCell = row.querySelector(".diffcmp-cell--add")!;
    // Exactly one emphasized word per side, pointing at the actual change.
    const delEm = leftCell.querySelector(".diffcmp-em--del");
    const addEm = rightCell.querySelector(".diffcmp-em--add");
    expect(delEm?.textContent).toBe("brown");
    expect(addEm?.textContent).toBe("red");
    expect(leftCell.querySelectorAll(".diffcmp-em").length).toBe(1);
    expect(rightCell.querySelectorAll(".diffcmp-em").length).toBe(1);
    // Common words stay unemphasized: the plain (non-em) spans still carry
    // the shared text on both sides.
    const plainLeft = [...leftCell.querySelectorAll("span:not(.diffcmp-em)")]
      .map((s) => s.textContent)
      .join("");
    const plainRight = [...rightCell.querySelectorAll("span:not(.diffcmp-em)")]
      .map((s) => s.textContent)
      .join("");
    expect(plainLeft).toContain("the quick");
    expect(plainLeft).toContain("fox");
    expect(plainRight).toContain("the quick");
    expect(plainRight).toContain("fox");
  });

  it("normalizes CRLF and lone-CR line endings before diffing (no fake changes)", () => {
    // CRLF (Windows disk save) vs the LF-normalized buffer.
    const crlf = renderDiff({ leftText: "a\r\nb\r\n", rightText: "a\nb\n" });
    expect(crlf.querySelector(".diffcmp-note")?.textContent).toMatch(
      /no differences/i,
    );
    expect(crlf.querySelector(".diffcmp-cell--del")).toBeNull();
    expect(crlf.querySelector(".diffcmp-cell--add")).toBeNull();
    // Lone CR (old-Mac style) exercises the `\r` (not `\r\n`) branch of the
    // `/\r\n?/g` replacement.
    const cr = renderDiff({ leftText: "x\ry\rz", rightText: "x\ny\nz" });
    expect(cr.querySelector(".diffcmp-note")?.textContent).toMatch(
      /no differences/i,
    );
    expect(cr.querySelector(".diffcmp-cell--del")).toBeNull();
    expect(cr.querySelector(".diffcmp-cell--add")).toBeNull();
  });

  it("collapses long unchanged runs into a gap row with the hidden-line count", () => {
    const mid = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const left = ["first", ...mid, "last"].join("\n");
    const right = ["FIRST", ...mid, "LAST"].join("\n");
    const c = renderDiff({ leftText: left, rightText: right });
    const gap = c.querySelector(".diffcmp-gap");
    expect(gap).not.toBeNull();
    // 20 equal lines between two changes keep 3 context lines per side →
    // 20 - 6 = 14 hidden. English plural form ("unchanged lines").
    expect(gap!.textContent).toMatch(/unchanged lines/);
    expect(gap!.textContent).toContain("14");
    // The changes themselves are still visible as paired rows.
    expect(pairRow(c)).toBeTruthy();
  });

  it("degrades to plain left-pane context + rightMissingLabel when rightText is null", () => {
    const c = renderDiff({
      leftText: "alpha\nbeta",
      rightText: null,
      rightMissingLabel: "File no longer exists",
    });
    expect(c.querySelector(".diffcmp-note")?.textContent).toBe(
      "File no longer exists",
    );
    // Every left line renders as a plain context row — no del/add markers.
    expect(c.querySelector(".diffcmp-cell--del")).toBeNull();
    expect(c.querySelector(".diffcmp-cell--add")).toBeNull();
    const leftTexts = [
      ...c.querySelectorAll(".diffcmp-cell--left"),
    ].map((el) => el.textContent);
    expect(leftTexts).toEqual(["alpha", "beta"]);
  });

  it("renders zero rows for an empty left text with a null right side", () => {
    const c = renderDiff({
      leftText: "",
      rightText: null,
      rightMissingLabel: "File no longer exists",
    });
    expect(c.querySelectorAll(".diffcmp-row").length).toBe(0);
    expect(c.querySelector(".diffcmp-note")?.textContent).toBe(
      "File no longer exists",
    );
  });
});
