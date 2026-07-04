import { StandaloneServices } from "@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices";
import { IMarkerService } from "@codingame/monaco-vscode-api/vscode/vs/platform/markers/common/markers.service";
import {
  MarkerSeverity,
  type IMarker,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/markers/common/markers";
import { Uri } from "vscode";
import type { Severity } from "../../lib/types";
import type { Diagnostic } from "../../lib/types";
import { useDiagnosticsStore } from "../../store/diagnosticsStore";
import { monacoModelRegistry } from "./monacoModelRegistry";
import { appLanguageClient } from "./appLanguageClient";
// Re-export the PURE helpers (Monaco-free) so consumers have one import path
// (`./lspDiagnosticsBridge`) and tests can target the pure seam via
// [`lspDiagnosticsBridgeHelpers`](./lspDiagnosticsBridgeHelpers.ts).
export {
  shouldDropDiagnosticsForGeneration,
  buildDiagnostic,
  selectDiagnosticsForDoc,
  getCombined,
} from "./lspDiagnosticsBridgeHelpers";
export type {
  DocDiagnostics,
  DiagnosticSource,
} from "./lspDiagnosticsBridgeHelpers";
import { buildDiagnostic } from "./lspDiagnosticsBridgeHelpers";

/**
 * The LSP → store diagnostics bridge (spec §13.2 / §17).
 *
 * Tinymist publishes diagnostics via the standard `publishDiagnostics` LSP
 * notification. The language client's built-in `DiagnosticsFeature` pushes those
 * into Monaco's `IMarkerService` — which is ALSO what renders the editor
 * squiggles. This bridge mirrors markers OUT of the marker service into the
 * per-document `diagnosticsStore[documentId].tinymist` slot so the Problems
 * panel / status bar can render them alongside the compiler source.
 *
 * We deliberately read the MARKER SERVICE rather than subscribing to
 * `publishDiagnostics` directly: subscribing directly would clobber the feature
 * handler and silence the squiggles (the marker service is the squiggle source
 * of truth).
 *
 * ## Generation-aware drop (§13.2 / §16)
 *
 * On an LSP restart / reconnect the `appLanguageClient` bumps its generation.
 * The marker service still holds diagnostics the OLD client pushed, and in the
 * gap before the new client re-publishes they would render as stale squiggles /
 * panel entries from the dead session. The bridge subscribes to
 * `appLanguageClient` and, on a generation change, CLEARs the tinymist slot for
 * EVERY known document (the new client republishes and the next marker read
 * repopulates). The bridge does NOT clear Monaco's own markers — the marker
 * service owns those and repopulates them as the new client publishes.
 *
 * ## Testability
 *
 * The marker-service / singleton glue can't run under jsdom (real Monaco
 * workers + services). The pure pieces are extracted into
 * [`lspDiagnosticsBridgeHelpers`](./lspDiagnosticsBridgeHelpers.ts) and
 * re-exported here so the spec-critical logic is unit-tested without Monaco:
 * the generation gate (`shouldDropDiagnosticsForGeneration`) and the pure
 * marker→Diagnostic builder (`buildDiagnostic`).
 */

/**
 * Map a Monaco `MarkerSeverity` bitmask (Error=8, Warning=4, Info=2, Hint=1)
 * → the app's Diagnostic severity union (spec §13.2). Unknown / Hint bits
 * fall back to `"Info"` (no `Hint` severity on the app union).
 */
function markerSeverity(s: MarkerSeverity): Severity {
  if ((s & MarkerSeverity.Error) === MarkerSeverity.Error) return "Error";
  if ((s & MarkerSeverity.Warning) === MarkerSeverity.Warning) return "Warning";
  if ((s & MarkerSeverity.Info) === MarkerSeverity.Info) return "Info";
  return "Info";
}

/** Monaco-typed glue: adapt an `IMarker` to a `Diagnostic`. */
function markerToDiagnostic(m: IMarker): Diagnostic {
  return buildDiagnostic({
    severity: markerSeverity(m.severity),
    message: m.message ?? "",
    startLine: m.startLineNumber,
    startColumn: m.startColumn,
    endLine: m.endLineNumber,
    endColumn: m.endColumn,
  });
}

/**
 * Resolve a marker URI to a document id via the model registry (§13.2). Real
 * `file:` URIs, untitled URIs, and migrated/stale URIs all go through the
 * registry's canonical uri→id map; returns null for unknown URIs (closed docs,
 * stale uris after a Save As migration) so the bridge drops them.
 */
function docIdFromUri(uriStr: string): string | null {
  return monacoModelRegistry.resolveDocumentId(uriStr);
}

// --- the bridge -------------------------------------------------------------

/** Module-level idempotency flag: the bridge installs at most once per process. */
let installed = false;

/**
 * The last generation the bridge observed from `appLanguageClient`. Kept here
 * (not in the store) because the bridge is the single consumer of the
 * generation-change → clear-tinymist reaction; the store only records the
 * number for other consumers. Module-level so re-installation after a hot
 * reload doesn't double-clear.
 */
let lastSeenGeneration = 0;

/**
 * Install the LSP → store diagnostics bridge (spec §13.2 / §17). Idempotent:
 * safe to call multiple times — only the first call wires anything. Called from
 * `MonacoEditor.handleLanguageClientsStartDone` (after Monaco services are up),
 * exactly where the old inline `ensureDiagBridge()` was.
 *
 * Wires two things:
 *  1. `IMarkerService.onMarkerChanged` → for each changed URI, resolve to a
 *     document id (drop if null), read the markers, map to `Diagnostic[]`, and
 *     write to `diagnosticsStore.set(id, "tinymist", diags)`.
 *  2. `appLanguageClient.subscribe` → on a generation change, clear the
 *     tinymist slot for every known document id (stale diagnostics from the
 *     dead client are dropped; the new client republishes).
 *
 * Does NOT subscribe to `publishDiagnostics` directly (would clobber the
 * feature handler and silence squiggles). Does NOT clear Monaco's own markers
 * (the marker service owns those and repopulates as the new client publishes).
 */
export function installLspDiagnosticsBridge(): void {
  if (installed) return;
  installed = true;

  // Seed the generation baseline so a bump that happened BEFORE the first
  // install is observed (the subscribe callback only fires on FUTURE changes).
  lastSeenGeneration = appLanguageClient.getGeneration();

  const markers = StandaloneServices.get(IMarkerService);

  const sync = (uris: readonly { toString(): string }[]): void => {
    for (const u of uris) {
      const uriStr = u.toString();
      const id = docIdFromUri(uriStr);
      // §13.2: unknown URI (closed doc / stale post-migration URI) → drop.
      if (id === null) continue;
      // `markers.read()` returns `IMarker[]` (a structural superset of
      // IMarkerData); `markerToDiagnostic` reads only fields present on both,
      // so no cast is needed.
      const data = markers.read({
        resource: Uri.parse(uriStr),
      });
      const diags = data.map(markerToDiagnostic);
      useDiagnosticsStore.getState().set(id, "tinymist", diags);
    }
  };

  markers.onMarkerChanged((uris) => sync(uris));

  // Generation-change: clear tinymist diagnostics for every known doc. The
  // marker service still holds the old client's markers; in the gap before the
  // new client re-publishes they would show as stale squiggles / panel entries.
  // Clearing the store's tinymist mirror hides them; the next marker read
  // repopulates as the new client publishes. We do NOT touch Monaco's markers.
  appLanguageClient.subscribe((snap) => {
    if (snap.generation === lastSeenGeneration) return;
    lastSeenGeneration = snap.generation;
    for (const entry of monacoModelRegistry.snapshot()) {
      useDiagnosticsStore.getState().clear(entry.documentId, "tinymist");
    }
  });
}
