import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsApp } from "./components/Settings/SettingsApp";
import { useSettingsStore } from "./store/settingsStore";
import { useThemeStore } from "./store/themeStore";
import { useTheme } from "./hooks/useTheme";
import { useLanguage } from "./hooks/useLanguage";
// Side-effect import: initializes i18next + registers React bindings. Must run
// before any component that calls `useTranslation` renders.
import "./i18n";
import "./styles/global.css";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <pre
          style={{
            margin: 0,
            padding: 16,
            color: "#ff3b30",
            background: "#f5f5f7",
            fontFamily: "SF Mono, Menlo, monospace",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            height: "100vh",
            overflow: "auto",
          }}
        >
          {this.state.error.name}: {this.state.error.message}
          {"\n\n"}
          {this.state.error.stack}
        </pre>
      );
    }
    return this.props.children;
  }
}

/**
 * Detect whether this bundle loaded as the dedicated settings window
 * (`index.html?window=settings`). A single Vite bundle serves both; the query
 * param selects which root component renders.
 */
const isSettingsWindow =
  new URLSearchParams(window.location.search).get("window") === "settings";

/**
 * Root: hydrates the settings + theme stores once (both windows need them —
 * the settings window renders the manifest/theme picker, the main window feeds
 * future consumers), applies the current theme to this window's document, then
 * branches to the settings UI or the app shell.
 */
function Root() {
  useEffect(() => {
    void useSettingsStore.getState().hydrate();
    void useThemeStore.getState().hydrate();
  }, []);
  // Apply the current theme in BOTH windows so the settings window matches.
  useTheme();
  // Apply the current UI language in BOTH windows. Reads `appearance.language`
  // and re-runs `i18n.changeLanguage` whenever the persisted setting changes
  // (including cross-window, via the `settings_changed` broadcast).
  useLanguage();
  return isSettingsWindow ? <SettingsApp /> : <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <Root />
  </ErrorBoundary>,
);
