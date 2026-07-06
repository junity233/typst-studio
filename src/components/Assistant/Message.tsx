import { useTranslation } from "react-i18next";
import { Markdown } from "./Markdown";
import { DiffCard } from "./DiffCard";
import type { AssistantMessage } from "../../store/assistantStore";

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
            <Markdown>{message.thinking}</Markdown>
          </details>
        )}
        {message.text && <Markdown>{message.text}</Markdown>}
      </div>
    );
  }

  // tool message
  return (
    <div className="assistant-tool">
      <div className="assistant-tool__head">
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
            {message.toolStatus === "ok"
              ? "✓"
              : message.toolStatus === "error"
                ? "⊗"
                : "⏳"}
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
      {message.toolResult && !message.approval && (
        <pre className="assistant-tool__result">{message.toolResult}</pre>
      )}
    </div>
  );
}
