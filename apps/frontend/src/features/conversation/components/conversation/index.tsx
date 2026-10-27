import { RotateCcw } from "lucide-react";
import type { ChatMessage } from "@frontend/types/contracts";
import { MessageList } from "@frontend/features/conversation/components/message-list";
import { Composer } from "@frontend/features/conversation/components/composer";
import { Notice } from "@frontend/components/notice";
import styles from "@frontend/features/conversation/components/conversation/index.module.css";

type ConversationProps = {
  sessionId?: string;
  messages: ChatMessage[];
  busy: boolean;
  pendingRun: boolean;
  working: boolean;
  submitted: boolean;
  ready: boolean;
  modelReady: boolean;
  notice: string;
  error?: Error;
  draft: string;
  onDraft(text: string): void;
  onSend(): void;
  onCancel(): void;
  onSynchronize(): void;
  onRetry(): void;
};

export function Conversation({
  sessionId,
  messages,
  busy,
  pendingRun,
  working,
  submitted,
  ready,
  modelReady,
  notice,
  error,
  draft,
  onDraft,
  onSend,
  onCancel,
  onSynchronize,
  onRetry,
}: ConversationProps) {
  const empty = messages.length === 0;
  return (
    <div className={[styles.chatArea, empty && styles.isEmpty].filter(Boolean).join(" ")}>
      {sessionId && (
        <div className={styles.conversationToolbar}>
          <span>{busy ? "申申正在回复…" : pendingRun ? "这个会话仍在生成" : "对话记录已保存"}</span>
          <button
            className={styles.textButton}
            disabled={!ready || busy || working}
            onClick={onSynchronize}
          >
            <RotateCcw aria-hidden="true" />
            {pendingRun ? "恢复输出" : "同步记录"}
          </button>
        </div>
      )}
      <MessageList key={sessionId ?? "new"} messages={messages} busy={busy} />
      <div className={styles.composerArea}>
        {(notice || error || (ready && !modelReady) || pendingRun) && (
          <Notice>
            {notice ||
              error?.message ||
              (pendingRun
                ? "回复仍在后台生成，可恢复输出或停止。"
                : "模型暂未配置，仍可查看和管理历史对话。")}
            {error && !pendingRun && !busy && (
              <button disabled={working} onClick={onRetry}>
                重试发送
              </button>
            )}
          </Notice>
        )}
        <Composer
          draft={draft}
          onDraft={onDraft}
          onSend={onSend}
          onCancel={onCancel}
          disabled={!ready || !modelReady || working}
          running={busy || pendingRun}
          cancelDisabled={!ready || working || submitted}
          empty={empty}
        />
      </div>
    </div>
  );
}
