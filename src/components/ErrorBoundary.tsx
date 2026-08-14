import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * A top-level React error boundary.
 *
 * Without it, ANY uncaught throw during render or in a committing effect tears
 * down the whole webview (a blank pane — indistinguishable from a hard crash to
 * the user). This boundary catches that, logs the error, and shows a recovery
 * screen with a Reload button instead of the white screen, so a single faulty
 * render never takes the whole editor down.
 *
 * Intentionally minimal: no dependency on the store/i18n layer (those may be
 * what threw), just inline styles and statically embedded strings. The strings
 * are duplicated per language and picked via `navigator.language` — they must
 * NOT go through i18next, which could itself be the crash source.
 */

/** Static, i18n-free fallback copy (en + zh). */
const FALLBACK_STRINGS = {
  en: {
    title: "Something went wrong",
    detail:
      "The interface hit an unexpected error. Your files are safe — reload to continue.",
    reload: "Reload",
    componentStackSummary: "Component stack (first lines, for a bug report)",
  },
  zh: {
    title: "出错了",
    detail: "界面遇到了意外错误。你的文件是安全的 —— 重新加载以继续。",
    reload: "重新加载",
    componentStackSummary: "组件堆栈（前几行，可用于问题反馈）",
  },
} as const;

/** Pick the fallback language once, without touching the i18n layer. */
const FALLBACK =
  navigator.language.toLowerCase().startsWith("zh")
    ? FALLBACK_STRINGS.zh
    : FALLBACK_STRINGS.en;

/** How many leading component-stack lines to surface in the <details> block. */
const MAX_STACK_LINES = 12;

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Mirror to the devtools console so the full stack is reachable for
    // debugging, and keep the component stack for the fallback screen.
    console.error("[ErrorBoundary] uncaught render error:", error, info);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  handleReload = (): void => {
    // A full reload is the reliable recovery: it tears down stale component
    // state that may have led to the throw and re-runs session restore. Do NOT
    // clear the error state first — that would re-render the crashing subtree
    // before the reload lands (a flash of the broken UI, or a second throw).
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    // Truncate the component stack so the fallback stays scannable; the full
    // stack remains in the devtools console via componentDidCatch.
    const stackLines = (this.state.componentStack ?? "").split("\n");
    const stackPreview =
      stackLines.slice(0, MAX_STACK_LINES).join("\n") +
      (stackLines.length > MAX_STACK_LINES ? "\n…" : "");
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 24,
          background: "var(--bg, #1e1e1e)",
          color: "var(--fg, #ddd)",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
          zIndex: 9999,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>{FALLBACK.title}</h2>
        <p style={{ margin: 0, maxWidth: 480, opacity: 0.8, fontSize: 14 }}>
          {FALLBACK.detail}
        </p>
        <pre
          style={{
            margin: 0,
            maxWidth: "80vw",
            maxHeight: "30vh",
            overflow: "auto",
            fontSize: 12,
            opacity: 0.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {this.state.error.message}
        </pre>
        {stackPreview.trim() !== "" && (
          // Collapsed by default: enough for a screenshot, without overwhelming.
          <details
            style={{ maxWidth: "80vw", fontSize: 12, opacity: 0.7, textAlign: "left" }}
          >
            <summary style={{ cursor: "pointer" }}>
              {FALLBACK.componentStackSummary}
            </summary>
            <pre
              style={{
                margin: "8px 0 0",
                maxHeight: "20vh",
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {stackPreview}
            </pre>
          </details>
        )}
        <button
          type="button"
          onClick={this.handleReload}
          style={{
            padding: "8px 16px",
            fontSize: 14,
            cursor: "pointer",
            background: "var(--accent, #0e639c)",
            color: "#fff",
            border: "none",
            borderRadius: 4,
          }}
        >
          {FALLBACK.reload}
        </button>
      </div>
    );
  }
}
