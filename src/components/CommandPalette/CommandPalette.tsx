import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useCommands } from "../../extensions/hooks";
import { dispatch } from "../../hooks/useAppCommands";
import { useCommandPaletteStore } from "../../store/commandPaletteStore";
import { filterAndSort } from "./fuzzyMatch";
import type { CommandContribution } from "../../extensions/registry";

/**
 * A VS Code-style Command Palette: a top-center overlay that fuzzy-searches
 * every registered command and runs the selected one. Self-manages visibility
 * via `commandPaletteStore`; mounted once at the app root.
 *
 * Behavior:
 *   - Keyboard: ↑/↓ move the active row (clamped), Enter runs the active
 *     command then closes, Escape closes (and resets the query).
 *   - Mouse: hovering a row makes it active; clicking a row runs it.
 *   - Dismissal: clicking the backdrop scrim closes (clicking inside the panel
 *     does not). Mirrors the ContextMenu dismissal pattern.
 *
 * Commands come from `useCommands()` (subscribes to `commandRegistry`); the
 * filter is `filterAndSort(query, commands)`. Executing a command reuses the
 * central `dispatch(id)` so enablement/errors/cancellation are handled once.
 *
 * Rendered through a portal to `document.body` (like ContextMenu) so it sits
 * above all app chrome regardless of layout/stacking context.
 */
export function CommandPalette() {
  const { t } = useTranslation("commandPalette");
  const open = useCommandPaletteStore((s) => s.open);
  const query = useCommandPaletteStore((s) => s.query);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);
  const closePalette = useCommandPaletteStore((s) => s.closePalette);

  const commands = useCommands();
  const filtered = useMemo(
    () => filterAndSort(query, commands),
    [query, commands],
  );

  // The active (highlighted) row index. Reset to the first row whenever the
  // query or the filtered set changes so the keyboard cursor always tracks a
  // visible item.
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    setActiveIndex(0);
  }, [query, commands]);

  const inputRef = useRef<HTMLInputElement>(null);
  // Keep the active row scrolled into view as the user arrows through.
  const listRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = activeRowRef.current;
    if (row === null) return;
    row.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Autofocus the input on open. Done in an effect (not `autoFocus`, which is
  // unreliable across re-renders) so reopening after a close re-focuses.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /** Run a command then close the palette. */
  const runCommand = (cmd: CommandContribution) => {
    closePalette();
    void dispatch(cmd.id);
  };

  if (!open) return null;

  /** Keyboard handling local to the palette. Escape is also caught by the
   * document-level dismissal listener below; both close. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[activeIndex];
      if (cmd) runCommand(cmd);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  };

  /** Backdrop pointerdown: close only when the click is outside the panel. */
  const onOverlayPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) closePalette();
  };

  return createPortal(
    <div
      className="command-palette-overlay"
      role="presentation"
      onPointerDown={onOverlayPointerDown}
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("title")}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          value={query}
          placeholder={t("placeholder")}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t("placeholder")}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="command-palette-list" ref={listRef} role="listbox">
          {filtered.length === 0 ? (
            <div className="command-palette-empty">{t("emptyState")}</div>
          ) : (
            filtered.map((cmd, i) => (
              <div
                key={cmd.id}
                ref={i === activeIndex ? activeRowRef : undefined}
                className={
                  "command-palette-item" +
                  (i === activeIndex ? " active" : "")
                }
                role="option"
                aria-selected={i === activeIndex}
                onPointerEnter={() => setActiveIndex(i)}
                onClick={() => runCommand(cmd)}
              >
                <span className="command-palette-item-label">{cmd.title}</span>
                {cmd.category && (
                  <span className="command-palette-category">
                    {cmd.category}
                  </span>
                )}
                {cmd.keybinding && (
                  <span className="command-palette-kbd">{cmd.keybinding}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
