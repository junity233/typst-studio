import type { Document } from "../../store/documentsStore";
import type { DocumentOrigin } from "../../lib/types";
import { languageIdForDocument } from "./languageId";

/**
 * Pure planning seam for `MonacoEditor.tsx`'s model lifecycle (spec §8.3 /
 * §10.1 / §10.4 / §10.5).
 *
 * `MonacoEditor` reacts to two streams of change — the full `documents` map
 * (opens/closes) and the active `tab.id` (tab switches) — and must turn them
 * into registry calls ([`openModel`](./monacoModelRegistry.ts),
 * [`closeModel`](./monacoModelRegistry.ts),
 * [`activate`](./monacoModelRegistry.ts)). The component itself is hard to test
 * under vitest+jsdom (Monaco workers + widget CSS), so the decision logic lives
 * here as a pure function and the component stays a thin dispatcher.
 *
 * The function is total and side-effect free: given the set of ids the editor
 * has already opened and the live documents map, it computes what to OPEN
 * (newly-appeared docs), what to CLOSE (gone docs), and what to ACTIVATE (an
 * active-id change pointing at a currently-open doc). The component dispatches
 * the plan against `monacoModelRegistry`.
 *
 * ## Semantics
 *
 * - `toOpen`: docs in `currentDocs` but NOT in `prevSeenIds`. Each entry
 *   carries the fields `openModel` needs (`content`, `origin`, `revision`).
 *   The component opens each id exactly once across its open lifetime.
 * - `toClose`: ids in `prevSeenIds` but NOT in `currentDocs`.
 * - `toActivate`: `activeId` iff it differs from `prevActiveId` AND is present
 *   in `currentDocs`; otherwise `null`. The "present in currentDocs" guard is
 *   defensive: a brand-new active id is opened FIRST (it lands in `toOpen`)
 *   and activated on a subsequent render, so `activate` is never called on an
 *   unknown id (which the registry would throw on).
 */

/** One entry in the open plan. Mirrors `openModel`'s options minus `documentId`. */
export interface ModelSyncOpenEntry {
  id: string;
  content: string;
  origin: DocumentOrigin;
  revision: number;
  /** Monaco language id (from `languageIdFor`); defaults to "typst". */
  languageId: string;
}

/** The plan the component dispatches against `monacoModelRegistry`. */
export interface ModelSyncPlan {
  toOpen: ModelSyncOpenEntry[];
  toClose: string[];
  toActivate: string | null;
}

/**
 * Compute the model-sync plan from the previous-seen id set, the live documents
 * map, and the active-id transition.
 *
 * @param prevSeenIds    Document ids the editor has already opened (a ref-set
 *   the component maintains across renders). NOT mutated.
 * @param currentDocs    The live `documentsStore.documents` map.
 * @param activeId       The currently-active document id (from the active tab).
 * @param prevActiveId   The previously-active document id (the prior tab.id).
 */
export function computeModelSyncPlan(
  prevSeenIds: ReadonlySet<string>,
  currentDocs: Record<string, Document>,
  activeId: string | null,
  prevActiveId: string | null,
): ModelSyncPlan {
  const toOpen: ModelSyncOpenEntry[] = [];
  for (const [id, doc] of Object.entries(currentDocs)) {
    if (prevSeenIds.has(id)) continue;
    // Binary kinds (image/pdf) never get a Monaco model — they render in a
    // dedicated viewer and are skipped by the editor entirely. Filtering them
    // here keeps the model registry free of empty throwaway models.
    const kind = doc.kind ?? "typst";
    if (kind === "image" || kind === "pdf") continue;
    toOpen.push({
      id,
      content: doc.content,
      origin: doc.origin,
      revision: doc.revision,
      languageId: languageIdForDocument(doc),
    });
  }

  const toClose: string[] = [];
  for (const id of prevSeenIds) {
    if (!(id in currentDocs)) toClose.push(id);
  }

  const toActivate =
    activeId !== null &&
    activeId !== prevActiveId &&
    activeId in currentDocs
      ? activeId
      : null;

  return { toOpen, toClose, toActivate };
}
