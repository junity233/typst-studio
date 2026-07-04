import { describe, it, expect } from "vitest";
import {
  FORMAT_BUTTON_GROUPS,
  type FormatAction,
  type FormatButton,
  type FormatButtonGroup,
  type FormatApi,
  type ActionContext,
} from "../formatActions";

/**
 * Format Toolbar Task 2 — pure-data tests for the button table.
 *
 * `formatActions.ts` holds NO React / Monaco logic: it is a typed description
 * of every toolbar button (id, icon, label, action) that the toolbar component
 * (a later task) will read to render. These tests assert the *shape* of the
 * table and the *exact* Typst strings each button emits, so a typo in a wrap
 * prefix or the code-block fence can't silently ship.
 *
 * The Typst strings pinned here are cross-checked against the
 * `src/lib/htmlToTypst/` source (the canonical HTML→Typst converter):
 *  - headings  → `=`.repeat(level) + " "   (blocks.ts)
 *  - bold      → `*…*`                     (inline.ts)
 *  - italic    → `_…_`                     (inline.ts)
 *  - strike    → `#strike[…]`              (inline.ts)
 *  - code      → `` `…` ``                 (inline.ts)
 *  - quote     → `#quote[…]`               (blocks.ts)
 *  - bullet    → `- `                      (blocks.ts)
 *  - numbered  → `+ `                      (blocks.ts)
 *  - hr        → `#line(length: 100%)`     (blocks.ts)
 *  - codeblock → fenced raw block          (blocks.ts convertPre)
 */

// Flatten the groups into a single button list for the table-driven checks.
const ALL_BUTTONS: FormatButton[] = FORMAT_BUTTON_GROUPS.flatMap(
  (g) => g.buttons,
);

describe("FORMAT_BUTTON_GROUPS — structure", () => {
  it("has exactly 4 groups with the expected ids, in order", () => {
    expect(FORMAT_BUTTON_GROUPS.map((g) => g.id)).toEqual([
      "structure",
      "inline",
      "blocks",
      "insert",
    ]);
  });

  it("each group has a non-empty id", () => {
    for (const g of FORMAT_BUTTON_GROUPS) {
      expect(typeof g.id).toBe("string");
      expect(g.id.length).toBeGreaterThan(0);
    }
  });

  it("each group's buttons array is non-empty", () => {
    for (const g of FORMAT_BUTTON_GROUPS) {
      expect(g.buttons.length).toBeGreaterThan(0);
    }
  });

  it("has exactly 15 buttons total", () => {
    expect(ALL_BUTTONS.length).toBe(15);
  });

  it.each([
    ["structure", 3],
    ["inline", 5],
    ["blocks", 5],
    ["insert", 2],
  ] as const)("group %s has %i buttons", (groupId, count) => {
    const group = FORMAT_BUTTON_GROUPS.find((g) => g.id === groupId);
    expect(group).toBeDefined();
    expect(group!.buttons.length).toBe(count);
  });
});

describe("FORMAT_BUTTON_GROUPS — button ids", () => {
  it("every button id is unique across the whole table", () => {
    const ids = ALL_BUTTONS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(ALL_BUTTONS.map((b) => [b.id, b] as const))(
    "button %s has a non-empty string id",
    (id) => {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    },
  );
});

describe("FORMAT_BUTTON_GROUPS — labels & icons", () => {
  it.each(ALL_BUTTONS.map((b) => [b.id, b] as const))(
    "button %s has a non-empty string label",
    (_id, button) => {
      expect(typeof button.label).toBe("string");
      expect(button.label.length).toBeGreaterThan(0);
    },
  );

  it.each(ALL_BUTTONS.map((b) => [b.id, b] as const))(
    "button %s icon is a valid lucide component (non-null object)",
    (_id, button) => {
      // lucide icons are produced by React.forwardRef, which returns an OBJECT
      // ({$$typeof: REACT_FORWARD_REF_TYPE, render}), so `typeof` is "object",
      // not "function". Guard against the real failure modes (icon missing,
      // mis-typed as a string/undefined, or a plain non-component) by asserting
      // it's a non-null object — i.e. a real component reference was wired in.
      // The compile-time `LucideIcon` typing on FormatButton.icon already
      // guarantees the shape; this runtime check just catches a null/undefined
      // icon that slipped through.
      expect(button.icon).not.toBeNull();
      expect(button.icon).not.toBeUndefined();
      expect(typeof button.icon).toBe("object");
    },
  );
});

describe("FORMAT_BUTTON_GROUPS — actions", () => {
  // Table-driven per-button action-kind sanity: every button must have an
  // action of one of the four supported kinds, with the kind-specific required
  // fields present and correctly typed.
  it.each(ALL_BUTTONS.map((b) => [b.id, b] as const))(
    "button %s has a well-formed action",
    (_id, button) => {
      const a = button.action as FormatAction & { kind: string };
      expect(typeof a.kind).toBe("string");
      switch (a.kind) {
        case "wrap": {
          expect(typeof a.prefix).toBe("string");
          expect(typeof a.suffix).toBe("string");
          if (a.placeholder !== undefined) {
            expect(typeof a.placeholder).toBe("string");
          }
          break;
        }
        case "replace": {
          expect(typeof (a as { text: string }).text).toBe("string");
          break;
        }
        case "linePrefix": {
          expect(typeof (a as { prefix: string }).prefix).toBe("string");
          break;
        }
        case "custom": {
          expect(typeof (a as { run: unknown }).run).toBe("function");
          break;
        }
        default:
          throw new Error(`unknown action kind: ${(a as { kind: string }).kind}`);
      }
    },
  );

  // Helper: find a button by id (existence already guaranteed by the
  // structure tests; this just narrows the type for the exact-string asserts).
  const buttonById = (id: string): FormatButton => {
    const b = ALL_BUTTONS.find((x) => x.id === id);
    if (!b) throw new Error(`missing button: ${id}`);
    return b;
  };

  describe("structure group — headings (linePrefix)", () => {
    it("heading1 → linePrefix '= ' (h1 = single '=' per blocks.ts)", () => {
      const a = buttonById("heading1").action;
      expect(a).toEqual({ kind: "linePrefix", prefix: "= " });
    });

    it("heading2 → linePrefix '== '", () => {
      const a = buttonById("heading2").action;
      expect(a).toEqual({ kind: "linePrefix", prefix: "== " });
    });

    it("heading3 → linePrefix '=== '", () => {
      const a = buttonById("heading3").action;
      expect(a).toEqual({ kind: "linePrefix", prefix: "=== " });
    });
  });

  describe("inline group — wraps", () => {
    it("bold → wrap '*' … '*' placeholder 'bold'", () => {
      const a = buttonById("bold").action;
      expect(a).toEqual({
        kind: "wrap",
        prefix: "*",
        suffix: "*",
        placeholder: "bold",
      });
    });

    it("italic → wrap '_' … '_' placeholder 'italic'", () => {
      const a = buttonById("italic").action;
      expect(a).toEqual({
        kind: "wrap",
        prefix: "_",
        suffix: "_",
        placeholder: "italic",
      });
    });

    it("strikethrough → wrap '#strike[' … ']' placeholder 'text'", () => {
      const a = buttonById("strikethrough").action;
      expect(a).toEqual({
        kind: "wrap",
        prefix: "#strike[",
        suffix: "]",
        placeholder: "text",
      });
    });

    it("code → wrap '`' … '`' placeholder 'code'", () => {
      const a = buttonById("code").action;
      expect(a).toEqual({
        kind: "wrap",
        prefix: "`",
        suffix: "`",
        placeholder: "code",
      });
    });
  });

  describe("blocks group", () => {
    it("codeBlock → replace exact fenced-raw-block string", () => {
      // The Typst raw block (blocks.ts convertPre) is ```lang\n…\n```. The
      // toolbar drops an empty one for the user to fill in: open fence with
      // the literal "lang" placeholder, a blank body line, then the close
      // fence, each newline-terminated. Pinned exactly so a stray space or
      // wrong fence count can't slip in.
      const a = buttonById("codeBlock").action as Extract<
        FormatAction,
        { kind: "replace" }
      >;
      expect(a.kind).toBe("replace");
      expect(a.text).toBe("```lang\n\n```\n");
    });

    it("quote → wrap '#quote[' … ']' placeholder 'text'", () => {
      const a = buttonById("quote").action;
      expect(a).toEqual({
        kind: "wrap",
        prefix: "#quote[",
        suffix: "]",
        placeholder: "text",
      });
    });

    it("bulletList → linePrefix '- '", () => {
      const a = buttonById("bulletList").action;
      expect(a).toEqual({ kind: "linePrefix", prefix: "- " });
    });

    it("numberedList → linePrefix '+ '", () => {
      const a = buttonById("numberedList").action;
      expect(a).toEqual({ kind: "linePrefix", prefix: "+ " });
    });

    it("horizontalRule → replace '#line(length: 100%)\\n'", () => {
      const a = buttonById("horizontalRule").action as Extract<
        FormatAction,
        { kind: "replace" }
      >;
      expect(a.kind).toBe("replace");
      expect(a.text).toBe("#line(length: 100%)\n");
    });
  });

  describe("custom actions (placeholders for later tasks)", () => {
    it.each(["link", "image", "table"] as const)(
      "%s action is custom with a callable run (impl deferred)",
      (id) => {
        const a = buttonById(id).action as Extract<
          FormatAction,
          { kind: "custom" }
        >;
        expect(a.kind).toBe("custom");
        expect(typeof a.run).toBe("function");
      },
    );
  });
});

// Compile-time type usage checks: these only need to *type-check*; the runtime
// assertions are trivial. They guard against accidental narrowing of the
// exported types (e.g. dropping `placeholder` or `ActionContext`).
describe("exported types are usable", () => {
  it("FormatApi is a subset of MonacoEditorApi edit methods", () => {
    const api: FormatApi = {
      wrapSelection: () => {},
      replaceSelection: () => {},
      toggleLinePrefix: () => {},
    };
    expect(typeof api.wrapSelection).toBe("function");
  });

  it("ActionContext carries tab + workspace + image template", () => {
    const ctx: ActionContext = {
      tab: { id: "t1", path: null } as ActionContext["tab"],
      workspace: null,
      insertImagePathTemplate: undefined,
    };
    expect(ctx.tab.id).toBe("t1");
  });

  it("FormatButtonGroup type is satisfied by the table", () => {
    const g: FormatButtonGroup = FORMAT_BUTTON_GROUPS[0];
    expect(typeof g.id).toBe("string");
  });
});
