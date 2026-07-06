import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invoke } from "@tauri-apps/api/core";

import { useDocumentsStore } from "./documentsStore";
import { useTabsStore } from "./tabsStore";
import { useWorkspaceStore } from "./workspaceStore";
import {
  useDiagnosticsStore,
  selectDiagnosticsForDoc,
} from "./diagnosticsStore";
import { editorApiRef } from "../components/Editor/editorApiRef";
import { openFileByPath, searchWorkspace } from "../lib/tauri";
import type { DirEntry } from "../lib/types";
import {
  resolveWorkspacePath,
  countOccurrences,
  pathsEqual,
} from "../lib/assistantPath";

/** Thrown by tool handlers to surface a recoverable error to the agent. */
export class ToolError extends Error {}

/** What an edit/write tool sends to the UI for approval. */
export interface PendingApproval {
  kind: "edit" | "write_file";
  /** Absolute workspace-resolved path. */
  path: string;
  /** For edit: the unique snippet to replace. */
  old_string?: string;
  /** For edit: the replacement. */
  new_string?: string;
  /** For write_file: full new content. */
  after?: string;
  /** For edit: full current content, for diff rendering. */
  before?: string;
}

/**
 * Context shared by all tool handlers.
 *
 * - `requestApproval` blocks the tool handler until the user clicks Apply /
 *   Reject (Strategy A from the spec). Returns the tool-result string fed back
 *   to the LLM ("Edit applied." / "User rejected the edit.").
 *
 * The agent's per-run abort signal is NOT passed here — pi-agent-core forwards
 * it to each `execute(toolCallId, params, signal)` call, so tools that need to
 * observe `stop()` read it from that argument.
 */
export interface ToolContext {
  requestApproval: (p: PendingApproval) => Promise<string>;
}

/**
 * Narrow an `unknown` tool-params payload to a typed record. The agent's args
 * are validated against the TypeBox schema by pi-agent-core before `execute`
 * runs, so we treat the shape as authoritative here.
 */
function paramsAs<T extends Record<string, unknown>>(p: unknown): T {
  return (p ?? {}) as T;
}

/** Build the agent's tool set. Called once per agent run. */
export function buildTools(ctx: ToolContext): AgentTool[] {
  return [
    readFileTool(ctx),
    listDirTool(ctx),
    searchFilesTool(ctx),
    getActiveFileTool(ctx),
    getDiagnosticsTool(ctx),
    compilePreviewTool(ctx),
    editTool(ctx),
    writeFileTool(ctx),
  ];
}

// --- helpers --------------------------------------------------------------

function activeDocPath(): string | null {
  const { activeId } = useTabsStore.getState();
  if (!activeId) return null;
  return useDocumentsStore.getState().documents[activeId]?.path ?? null;
}

function activeDocContent(): string | null {
  const { activeId } = useTabsStore.getState();
  if (!activeId) return null;
  return useDocumentsStore.getState().documents[activeId]?.content ?? null;
}

/** Read a file's content; open-tab-first, IPC fallback for closed files. */
async function readForContent(absPath: string): Promise<string> {
  const { documents } = useDocumentsStore.getState();
  for (const d of Object.values(documents)) {
    if (d.path && pathsEqual(d.path, absPath)) return d.content;
  }
  const opened = await openFileByPath(absPath);
  return opened.content;
}

/** Does any open tab already live at this absolute path? */
function pathHasOpenTab(absPath: string): boolean {
  return Object.values(useDocumentsStore.getState().documents).some(
    (d) => d.path && pathsEqual(d.path, absPath),
  );
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined,
  };
}

// --- read-only tools ------------------------------------------------------

function readFileTool(_ctx: ToolContext): AgentTool {
  return {
    name: "read_file",
    label: "Read file",
    description:
      "Read a file's content. `path` is relative to the workspace root (or absolute within it).",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, rawParams) {
      const { path } = paramsAs<{ path: string }>(rawParams);
      const abs = resolveWorkspacePath(
        useWorkspaceStore.getState().rootPath,
        path,
        activeDocPath(),
      );
      const content = await readForContent(abs);
      return textResult(content);
    },
  };
}

function listDirTool(_ctx: ToolContext): AgentTool {
  return {
    name: "list_dir",
    label: "List directory",
    description:
      "List entries in a directory. Defaults to the workspace root. Returns one path per line; directories end with `/`.",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    async execute(_id, rawParams) {
      const { path } = paramsAs<{ path?: string }>(rawParams);
      const root = useWorkspaceStore.getState().rootPath;
      const target = path
        ? resolveWorkspacePath(root, path, activeDocPath())
        : (root ?? activeDocPath() ?? "");
      if (!target) return textResult("No workspace and no active file.");
      const entries = await invoke<DirEntry[]>("read_dir", { rel: target });
      const lines = entries.map((e) =>
        e.kind === "dir" ? `${e.name}/` : e.name,
      );
      return textResult(lines.join("\n"));
    },
  };
}

function searchFilesTool(_ctx: ToolContext): AgentTool {
  return {
    name: "search_files",
    label: "Search files",
    description:
      "Cross-file full-text search across the workspace. Returns matching file:line: text entries.",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, rawParams) {
      const { query } = paramsAs<{ query: string }>(rawParams);
      const hits = await searchWorkspace({
        pattern: query,
        isRegex: false,
        caseSensitive: false,
        wholeWord: false,
        includeGlob: null,
        maxPerFile: 50,
        maxTotal: 200,
      });
      if (hits.length === 0) return textResult("No matches.");
      const lines = hits.map(
        (h) => `${h.relative}:${h.line}: ${h.lineText.trim()}`,
      );
      return textResult(lines.join("\n"));
    },
  };
}

function getActiveFileTool(_ctx: ToolContext): AgentTool {
  return {
    name: "get_active_file",
    label: "Get active file",
    description:
      "Return the path, content, current cursor line, and current selection of the active editor tab.",
    parameters: Type.Object({}),
    async execute() {
      const path = activeDocPath();
      const content = activeDocContent();
      if (!path || content === null) return textResult("No active file.");
      const api = editorApiRef.current;
      return textResult(
        JSON.stringify({
          path,
          content,
          cursorLine: api?.getCurrentLine() ?? null,
          selection: api?.getSelectionText() ?? "",
        }),
      );
    },
  };
}

function getDiagnosticsTool(_ctx: ToolContext): AgentTool {
  return {
    name: "get_diagnostics",
    label: "Get diagnostics",
    description:
      "Return current Typst compile diagnostics (errors and warnings) for the active document.",
    parameters: Type.Object({}),
    async execute() {
      const { activeId } = useTabsStore.getState();
      if (!activeId) return textResult("No active file.");
      const doc = useDiagnosticsStore.getState().byDoc[activeId];
      const diags = selectDiagnosticsForDoc(doc);
      if (diags.length === 0) {
        return textResult("No diagnostics. Document compiles cleanly.");
      }
      return textResult(JSON.stringify(diags));
    },
  };
}

function compilePreviewTool(_ctx: ToolContext): AgentTool {
  return {
    name: "compile_preview",
    label: "Compile preview",
    description:
      "Wait briefly for the editor's debounced compile to settle, then return the current diagnostics for the active document. Use after edits to check for new errors. NOTE: this reads diagnostics after a short delay; if you edited very recently, the compile may not have finished.",
    parameters: Type.Object({}),
    async execute() {
      // The compile pipeline is debounced on content change; settle briefly so
      // diagnostics reflect the latest buffer.
      await new Promise((r) => setTimeout(r, 500));
      const { activeId } = useTabsStore.getState();
      if (!activeId) return textResult('{"ok":false,"errors":["No active file."]}');
      const doc = useDiagnosticsStore.getState().byDoc[activeId];
      const diags = selectDiagnosticsForDoc(doc);
      const errors = diags.filter((d) => d.severity === "Error");
      if (errors.length === 0) return textResult('{"ok":true}');
      return textResult(JSON.stringify({ ok: false, errors }));
    },
  };
}

// --- edit tools (require approval) ---------------------------------------

function editTool(ctx: ToolContext): AgentTool {
  return {
    name: "edit",
    label: "Edit file",
    description:
      "Replace the unique first occurrence of `old_string` with `new_string` in a file. " +
      "`old_string` must match the file byte-for-byte (indentation, blank lines). Must be unique in " +
      "the file; if multiple matches, expand `old_string` with surrounding context and retry. " +
      "Whitespace-sensitive: copy from the source, never retype from memory. " +
      "`path` defaults to the active file. Requires user approval.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      old_string: Type.String(),
      new_string: Type.String(),
    }),
    async execute(_id, rawParams) {
      const { path, old_string, new_string } = paramsAs<{
        path?: string;
        old_string: string;
        new_string: string;
      }>(rawParams);
      const root = useWorkspaceStore.getState().rootPath;
      const absPath = path
        ? resolveWorkspacePath(root, path, activeDocPath())
        : (activeDocPath() ??
          (() => {
            throw new ToolError("No active file; pass an explicit `path`.");
          })());
      const before = await readForContent(absPath);
      const occurrences = countOccurrences(before, old_string);
      if (occurrences === 0) {
        throw new ToolError(
          "old_string not found — copy it verbatim from read_file output.",
        );
      }
      if (occurrences > 1) {
        throw new ToolError(
          `old_string matches ${occurrences} places; include more surrounding context.`,
        );
      }
      const result = await ctx.requestApproval({
        kind: "edit",
        path: absPath,
        old_string,
        new_string,
        before,
      });
      return textResult(result);
    },
  };
}

function writeFileTool(ctx: ToolContext): AgentTool {
  return {
    name: "write_file",
    label: "Write new file",
    description:
      "Create a new file with the given content. To modify an existing file, use `edit`. Requires user approval.",
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
    }),
    async execute(_id, rawParams) {
      const { path, content } = paramsAs<{ path: string; content: string }>(rawParams);
      const root = useWorkspaceStore.getState().rootPath;
      const absPath = resolveWorkspacePath(root, path, activeDocPath());
      if (pathHasOpenTab(absPath)) {
        throw new ToolError("File exists — use `edit` to modify it.");
      }
      // NOTE: a file may exist on disk without an open tab. We can't cheaply
      // probe disk from here; the create_entry backend call (wired in
      // applyApproval, Task 8) surfaces a "file exists" error if so, and the
      // agent retries with `edit`.
      const result = await ctx.requestApproval({
        kind: "write_file",
        path: absPath,
        after: content,
      });
      return textResult(result);
    },
  };
}
