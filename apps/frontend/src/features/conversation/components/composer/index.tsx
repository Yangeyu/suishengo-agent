import { useEffect, useRef } from "react";
import { Sparkles, Square, ArrowUp, ChevronRight } from "lucide-react";
import styles from "@frontend/features/conversation/components/composer/index.module.css";

type ComposerProps = {
  draft: string;
  disabled: boolean;
  running: boolean;
  cancelDisabled: boolean;
  empty: boolean;
  onDraft(text: string): void;
  onSend(): void;
  onCancel(): void;
};

export function Composer({
  draft,
  disabled,
  running,
  cancelDisabled,
  empty,
  onDraft,
  onSend,
  onCancel,
}: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = Math.min(textarea.current.scrollHeight, 180) + "px";
  }, [draft]);
  return (
    <>
      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <textarea
          ref={textarea}
          aria-label="消息"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          placeholder="给申申发消息…"
          rows={2}
          maxLength={4000}
          disabled={disabled}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <div className={styles.composerBottom}>
          <span>
            <Sparkles aria-hidden="true" />
            申申 · 随申 GO
          </span>
          {running ? (
            <button
              className={styles.sendButton}
              type="button"
              aria-label="停止生成"
              title="停止生成"
              disabled={cancelDisabled}
              onClick={() => onCancel()}
            >
              <Square aria-hidden="true" />
            </button>
          ) : (
            <button
              className={styles.sendButton}
              type="submit"
              aria-label="发送消息"
              title="发送消息"
              disabled={disabled || !draft.trim()}
            >
              <ArrowUp aria-hidden="true" />
            </button>
          )}
        </div>
      </form>
      {empty && (
        <div className={styles.suggestions}>
          {["帮我规划上海周末行程", "介绍一下你能帮我做什么", "给我一些出行灵感"].map((text) => (
            <button
              key={text}
              disabled={disabled}
              onClick={() => {
                onDraft(text);
                textarea.current?.focus();
              }}
            >
              {text}
              <ChevronRight aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      <p className={styles.composerHint}>
        回答仅供参考<span>·</span>Enter 发送，Shift + Enter 换行
      </p>
    </>
  );
}
