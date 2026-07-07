import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, Square, Trash2 } from "lucide-react";
import { useAssistantStore } from "../../store/assistantStore";
import { useSetting } from "../../hooks/useSetting";
import { openSettings } from "../../lib/tauri";
import { MessageView } from "./Message";
import "./AssistantPanel.css";

export function AssistantPanel(_: { viewId: string }) {
  const { t } = useTranslation("assistant");
  const messages = useAssistantStore((s) => s.messages);
  const status = useAssistantStore((s) => s.status);
  const streamingText = useAssistantStore((s) => s.streamingText);
  const errorMessage = useAssistantStore((s) => s.errorMessage);
  const sendMessage = useAssistantStore((s) => s.sendMessage);
  const stop = useAssistantStore((s) => s.stop);
  const clear = useAssistantStore((s) => s.clearConversation);
  const approve = useAssistantStore((s) => s.approve);
  const reject = useAssistantStore((s) => s.reject);

  const [apiKey] = useSetting<string>("ai.apiKey");
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Auto-scroll to bottom when new content arrives, unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, errorMessage]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const onSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    void sendMessage(text);
  };

  const busy = status === "streaming" || status === "awaiting-approval";
  const unconfigured = !apiKey;

  return (
    <div className="assistant-panel">
      <div className="assistant-panel__header">
        <span className="assistant-panel__title">{t("title")}</span>
        <button
          className="assistant-icon-btn"
          onClick={clear}
          title={t("clear")}
          aria-label={t("clear")}
        >
          <Trash2 size={15} />
        </button>
      </div>

      <div
        className="assistant-panel__scroll"
        ref={scrollRef}
        onScroll={onScroll}
      >
        {messages.length === 0 && !streamingText && (
          <div className="assistant-empty">{t("emptyState")}</div>
        )}
        {messages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            onApply={approve}
            onReject={reject}
          />
        ))}
        {streamingText && (
          <div className="assistant-msg assistant-msg--assistant">
            <div className="assistant-streaming">{streamingText}</div>
          </div>
        )}
        {errorMessage && (
          <div className="assistant-error">{errorMessage}</div>
        )}
      </div>

      {unconfigured ? (
        <div className="assistant-unconfigured">
          <p>{t("configRequired")}</p>
          <button
            className="assistant-btn assistant-btn--primary"
            onClick={() => void openSettings()}
          >
            {t("openSettings")}
          </button>
        </div>
      ) : (
        <div className="assistant-panel__input">
          <div className="assistant-input-wrap">
            <textarea
              className="assistant-input"
              placeholder={t("placeholder")}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
              rows={2}
              disabled={busy}
            />
            {busy ? (
              <button
                className="assistant-send-btn assistant-send-btn--stop"
                onClick={stop}
                title={t("stop")}
                aria-label={t("stop")}
              >
                <Square size={15} fill="currentColor" />
              </button>
            ) : (
              <button
                className="assistant-send-btn"
                onClick={onSend}
                disabled={!input.trim()}
                title={t("send")}
                aria-label={t("send")}
              >
                <ArrowUp size={17} />
              </button>
            )}
          </div>
          {!busy && (
            <div className="assistant-panel__hint-row">
              <span className="assistant-hint">{t("enterToSend")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
