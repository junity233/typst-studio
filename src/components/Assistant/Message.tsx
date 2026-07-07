import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FileText, Search, FolderOpen, Stethoscope, Play, Pencil, FilePlus } from "lucide-react";
import { Markdown } from "./Markdown";
import { DiffCard } from "./DiffCard";
import type { AssistantMessage } from "../../store/assistantStore";
import type { LucideIcon } from "lucide-react";

/** Map tool name → icon for the tool card header. */
const TOOL_ICONS: Record<string, LucideIcon> = {
  read_file: FileText,
  get_active_file: FileText,
  list_dir: FolderOpen,
  search_files: Search,
  get_diagnostics: Stethoscope,
  compile_preview: Play,
  edit: Pencil,
  write_file: FilePlus,
};

export function MessageView({
  message,
  onApply,
  onReject,
}: {
  message: AssistantMessage;
  onApply: () => void;
  onReject: () => void;
}) {
  const { t } = useTranslation("assistant");

  if (message.role === "user") {
    return <div className="assistant-msg assistant-msg--user">{message.text}</div>;
  }

  if (message.role === "assistant") {
    if (message.toolStatus === "error" && message.toolResult && !message.text) {
      return <div className="assistant-error">{message.toolResult}</div>;
    }
    return (
      <div className="assistant-msg assistant-msg--assistant">
        {message.thinking && (
          <details className="assistant-thinking">
            <summary>{t("thinking")}</summary>
            <div className="assistant-thinking__body">{message.thinking}</div>
          </details>
        )}
        {message.text && <Markdown>{message.text}</Markdown>}
      </div>
    );
  }

  // tool message
  const Icon = TOOL_ICONS[message.toolName ?? ""] ?? FileText;
  const hasResult = !!message.toolResult && !message.approval;
  return (
    <div className="assistant-tool">
      <div className="assistant-tool__head">
        <Icon size={13} className="assistant-tool__icon" />
        <span className="assistant-tool__name">{message.toolName}</span>
        {message.toolStatus && (
          <span
            className={`assistant-tool__status assistant-tool__status--${message.toolStatus}`}
            aria-label={
              message.toolStatus === "ok"
                ? t("toolDone")
                : message.toolStatus === "error"
                  ? t("toolError")
                  : t("toolRunning")
            }
          >
            {message.toolStatus === "ok" ? "✓" : message.toolStatus === "error" ? "✕" : "⏳"}
          </span>
        )}
      </div>
      {message.approval && (
        <DiffCard
          approval={message.approval}
          onApply={onApply}
          onReject={onReject}
        />
      )}
      {hasResult && <ToolResult text={message.toolResult!} />}
    </div>
  );
}

/** Collapsible tool result. Collapsed shows a one-line summary; expanded shows the full text. */
function ToolResult({ text }: { text: string }) {
  const { t } = useTranslation("assistant");
  const [expanded, setExpanded] = useState(false);
  const summary = text.split("\n")[0].slice(0, 80);
  const isMulti = text.length > 80 || text.includes("\n");

  return (
    <div className="assistant-tool__result-wrap">
      {isMulti ? (
        <button
          className="assistant-tool__result-toggle"
          title={expanded ? t("collapseResult") : t("expandResult")}
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronRight
            size={12}
            style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
          />
          <span className="assistant-tool__result-summary">{summary}{summary.length < text.length ? "…" : ""}</span>
        </button>
      ) : (
        <span className="assistant-tool__result-summary">{summary}</span>
      )}
      {expanded && isMulti && (
        <pre className="assistant-tool__result">{text}</pre>
      )}
    </div>
  );
}

