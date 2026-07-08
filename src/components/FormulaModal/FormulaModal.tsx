// KaTeX's stylesheet is imported for its side effect (it registers the CSS
// classes the rendered HTML references). Bundled by Vite like any other CSS
// import. Deliberately at the top so the preview's classes resolve on first
// render.
import "katex/dist/katex.min.css";
import katex from "katex";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { convertLatexToTypst } from "../../lib/tauri";
import { useFormulaModalStore } from "../../store/formulaModalStore";
import { editorApiRef } from "../Editor/editorApiRef";
import { detectMathContext } from "../Sidebar/Symbols/detectMathContext";
import { buildTypstMathInsert, type FormulaMode } from "./insertTypstMath";

/**
 * Insert Formula modal — a controlled-by-store dialog that lets the user type
 * (or paste) LaTeX math, see a live KaTeX preview, choose inline vs. display,
 * and insert the converted Typst math at the cursor.
 *
 * Open/close is driven by {@link useFormulaModalStore} so two entry points (the
 * format-toolbar button + the `Ctrl+Alt+M` command) can open the same modal.
 * Rendered once at the app root; when `open` is false it renders nothing.
 *
 * Conversion: the user's LaTeX is sent to the Rust backend (`convert_latex_to_typst`,
 * backed by `tylax`) on confirm. We do NOT convert on every keystroke — KaTeX
 * already gives instant LaTeX feedback in the preview, and the tylax round-trip
 * is only needed at insert time to produce Typst source. This keeps the preview
 * fast (pure JS) and the backend quiet.
 *
 * Insert: on confirm, we read the cursor's math context (reusing the Symbols
 * panel's `detectMathContext`). If the cursor is already inside `$…$`, the
 * converted body is inserted bare (no double-wrapping); otherwise it's wrapped
 * `$…$` (inline) or `$ … $` (display). The wrapping rule lives in the pure
 * `buildTypstMathInsert` helper so it's unit-tested independently.
 *
 * UI mirrors `LinkModal`: portal to `document.body`, reuses `.dialog-overlay` /
 * `.dialog` chrome, Esc / overlay-click / Cancel all close, the LaTeX field is
 * autofocused on mount, and Enter (in the textarea, without Shift) submits.
 */
export function FormulaModal() {
  const { t } = useTranslation("formula");
  const open = useFormulaModalStore((s) => s.isOpen);
  const storeInitialLatex = useFormulaModalStore((s) => s.initialLatex);
  const close = useFormulaModalStore((s) => s.close);

  // Local input state. Seeded from the store's initialLatex once per open.
  // Using a key-on-open trick (useState initializer reads a ref captured at
  // open time) would be cleaner, but re-mounting the whole modal on each open
  // is simplest and matches LinkModal (which mounts fresh each time via a
  // parent ternary). Here the component is always mounted, so we re-seed via
  // an effect keyed on `open`.
  const [latex, setLatex] = useState("");
  const [mode, setMode] = useState<FormulaMode>("inline");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [inserting, setInserting] = useState(false);
  const [insertError, setInsertError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // (Re)seed local state each time the modal opens. Clears stale content/error
  // from a previous session and focuses the textarea.
  useEffect(() => {
    if (!open) return;
    setLatex(storeInitialLatex);
    setMode("inline");
    setPreviewError(null);
    setInsertError(null);
    setInserting(false);
    // Focus on the next tick so the input is mounted (the portal below renders
    // only when open; this effect runs after that paint).
    const id = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open, storeInitialLatex]);

  // Render the KaTeX preview whenever the LaTeX input or mode changes. KaTeX
  // throws on a parse error with the default options; throwOnError:false turns
  // that into a rendered error marker instead, but we also catch to surface a
  // friendly message (and leave the previous good render intact via the DOM).
  useEffect(() => {
    if (!open) return;
    const el = previewRef.current;
    if (el === null) return;
    const src = latex.trim();
    if (src === "") {
      el.innerHTML = "";
      setPreviewError(null);
      return;
    }
    try {
      katex.render(src, el, {
        displayMode: mode === "display",
        throwOnError: false,
        output: "html",
      });
      setPreviewError(null);
    } catch (err) {
      // Defensive: throwOnError:false should make this unreachable, but KaTeX
      // can still throw on non-string input or a fatal internal error.
      setPreviewError(err instanceof Error ? err.message : String(err));
    }
  }, [latex, mode, open]);

  const canInsert = useMemo(
    () => latex.trim() !== "" && !inserting,
    [latex, inserting],
  );

  const handleConfirm = async () => {
    const src = latex.trim();
    if (src === "" || inserting) return;
    const api = editorApiRef.current;
    if (api === null) {
      setInsertError(t("noEditor", { defaultValue: "No active editor." }));
      return;
    }
    setInserting(true);
    setInsertError(null);
    try {
      const { output, warnings } = await convertLatexToTypst(src);
      // Decide wrapping from the live cursor context. If the position can't be
      // read (no model yet), assume markup — wrapping is the safe default.
      const pos = api.getCursorPosition();
      const lines = api.getModelLines();
      const context =
        pos !== null && lines !== null
          ? detectMathContext(lines, pos.lineNumber, pos.column)
          : "markup";
      const text = buildTypstMathInsert(context, mode, output);
      api.replaceSelection(text);
      // Warnings are non-fatal (conversion still produced output); surface them
      // once as an alert so the user can review the inserted math. We do not
      // block the close — the insert already happened.
      if (warnings.length > 0) {
        window.alert(
          t("convertedWithWarnings", {
            defaultValue:
              "Converted with {{count}} warning(s). Please review the inserted math.",
            count: warnings.length,
          }) +
            "\n\n" +
            warnings.map((w) => `• ${w.message}`).join("\n"),
        );
      }
      close();
    } catch (err) {
      setInsertError(err instanceof Error ? err.message : String(err));
    } finally {
      setInserting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    // Enter (without Shift) submits, like LinkModal. Shift+Enter inserts a
    // newline so multi-line LaTeX (align blocks) is still editable.
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      void handleConfirm();
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="dialog formula-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("title", { defaultValue: "Insert formula" })}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="dialog-title">
          {t("title", { defaultValue: "Insert formula" })}
        </h2>

        <div className="formula-mode-toggle" role="group" aria-label={t("mode", { defaultValue: "Mode" })}>
          {(["inline", "display"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={"formula-mode-btn" + (mode === m ? " active" : "")}
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {t(m, { defaultValue: m === "inline" ? "Inline" : "Display" })}
            </button>
          ))}
        </div>

        <label className="formula-field">
          <span className="formula-label">
            {t("latex", { defaultValue: "LaTeX" })}
          </span>
          <textarea
            ref={textareaRef}
            className="formula-textarea"
            rows={3}
            spellCheck={false}
            placeholder={t("latexPlaceholder", { defaultValue: "\\frac{a}{b} + \\sum_{i=1}^n x_i" })}
            value={latex}
            onChange={(e) => setLatex(e.target.value)}
          />
        </label>

        <div className="formula-field">
          <span className="formula-label">
            {t("preview", { defaultValue: "Preview" })}
          </span>
          <div
            ref={previewRef}
            className={"formula-preview" + (mode === "display" ? " display" : "")}
            aria-live="polite"
          />
          {previewError !== null && (
            <p className="formula-error" role="alert">
              {previewError}
            </p>
          )}
        </div>

        {insertError !== null && (
          <p className="formula-error" role="alert">
            {insertError}
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn-utility" onClick={close}>
            {t("cancel", { defaultValue: "Cancel" })}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handleConfirm()}
            disabled={!canInsert}
          >
            {inserting
              ? t("inserting", { defaultValue: "Inserting…" })
              : t("insert", { defaultValue: "Insert" })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
