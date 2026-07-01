import { useEffect, useState } from "react";
import { useDiagnosticsStore } from "../../store/diagnosticsStore";
import { useTabsStore } from "../../store/tabsStore";
import type { CompileStatus } from "../../lib/ui-types";
import { invoke } from "@tauri-apps/api/core";

/** Stable empty array so the selector returns the same reference when unset. */
const EMPTY_DIAGNOSTICS: readonly never[] = Object.freeze([]) as never[];

interface LspStatus {
  running: boolean;
  wsUrl: string;
  available: boolean;
}

function statusLabel(
  status: CompileStatus,
  durationMs: number | null,
): string {
  switch (status) {
    case "compiling":
      return "Compiling…";
    case "success":
      return durationMs !== null ? `Compiled in ${durationMs}ms` : "Compiled";
    case "error":
      return "Compile failed";
    case "idle":
    default:
      return "Ready";
  }
}

function lspLabel(status: LspStatus): string {
  if (!status.available) return "LSP: not installed";
  if (!status.running) return "LSP: stopped";
  return "LSP: connected";
}

export function StatusBar() {
  const tab = useTabsStore(
    (s) => s.tabs.find((t) => t.id === s.activeId) ?? null,
  );
  const diagnostics = useDiagnosticsStore((s) =>
    tab !== null ? (s.byTab[tab.id] ?? EMPTY_DIAGNOSTICS) : EMPTY_DIAGNOSTICS,
  );
  const errorCount = diagnostics.filter((d) => d.severity === "Error").length;
  const status = tab?.status ?? "idle";
  const statusClass =
    status === "compiling"
      ? "statusbar-status--compiling"
      : status === "error"
        ? "statusbar-status--error"
        : "";

  const [lspStatus, setLspStatus] = useState<LspStatus>({
    running: false,
    wsUrl: "",
    available: false,
  });

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await invoke<LspStatus>("get_lsp_status");
        if (!cancelled) setLspStatus(s);
      } catch {
        // ignore
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <footer className="statusbar">
      <span className={"statusbar-section" + (statusClass ? " " + statusClass : "")}>
        {tab !== null ? statusLabel(tab.status, tab.durationMs) : "No document"}
      </span>
      <span className="statusbar-section">
        {errorCount > 0
          ? (
            <span className="statusbar-badge-error">
              {errorCount} {errorCount === 1 ? "error" : "errors"}
            </span>
          )
          : <span className="statusbar-badge">No errors</span>}
      </span>
      <span className="statusbar-section statusbar-lsp">
        {lspLabel(lspStatus)}
      </span>
    </footer>
  );
}
