import { useEffect, useRef } from "react";
import { Sparkles } from "lucide-react";
import type { ChatMessage } from "@frontend/types/contracts";
import { Markdown } from "@frontend/components/markdown";
import { LoadingIndicator } from "@frontend/components/loading-indicator";
import styles from "@frontend/features/conversation/components/message-list/index.module.css";

export function MessageList({ messages, busy }: { messages: ChatMessage[]; busy: boolean }) {
  const empty = messages.length === 0;
  const scroll = useRef<HTMLElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages]);
  useEffect(() => {
    if (messages.at(-1)?.role === "user") {
      follow.current = true;
      if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    }
  }, [messages.at(-1)?.id]);
  return (
    <section
      className={[styles.conversation, empty && styles.empty].filter(Boolean).join(" ")}
      aria-label="对话消息"
      ref={scroll}
      onScroll={() => {
        const el = scroll.current!;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      }}
    >
      {empty ? (
        <div className={styles.welcome}>
          <span className={styles.welcomeSymbol}>
            <Sparkles aria-hidden="true" />
          </span>
          <div className={styles.eyebrow}>与申申一起，探索更多可能</div>
          <h2>今天，有什么想聊的？</h2>
          <p>从一个问题、一个想法，或一段计划开始。</p>
        </div>
      ) : (
        <div>
          {messages.map((message) => (
            <article key={message.id} className={[styles.message, styles[message.role]].join(" ")}>
              <div className={styles.speaker}>
                {message.role === "user" ? (
                  "你"
                ) : (
                  <>
                    <span className={styles.assistantMark}>
                      <Sparkles aria-hidden="true" />
                    </span>
                    申申
                  </>
                )}
              </div>
              <div className={styles.messageContent}>
                {message.parts.map((part, index) => (
                  <MessagePart key={index} part={part} />
                ))}
              </div>
            </article>
          ))}
          {busy && (
            <div className={styles.generating} role="status">
              <LoadingIndicator />
              正在思考与整理<span>…</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function MessagePart({ part }: { part: ChatMessage["parts"][number] }) {
  if (part.type === "text") return <Markdown>{part.text}</Markdown>;
  if (part.type === "reasoning")
    return (
      <details className={styles.reasoning}>
        <summary>思考过程</summary>
        <p>{part.text}</p>
      </details>
    );
  if (part.type !== "dynamic-tool") return null;
  const displayName = part.toolMetadata?.displayName;
  const title = typeof displayName === "string" && displayName.trim() ? displayName : part.toolName;
  const state =
    part.state === "output-available"
      ? "已完成"
      : part.state === "output-error"
        ? "执行失败"
        : "执行中";
  return (
    <details className={styles.toolCall} open={part.state === "output-error"}>
      <summary>
        {title}
        <span>{state}</span>
      </summary>
      <strong>工具标识</strong>
      <code>{part.toolName}</code>
      <strong>输入</strong>
      <pre>{JSON.stringify(part.input, null, 2)}</pre>
      {part.state === "output-available" && (
        <>
          <strong>结果</strong>
          <pre>{JSON.stringify(part.output, null, 2)}</pre>
        </>
      )}
      {part.state === "output-error" && <p role="status">{part.errorText}</p>}
    </details>
  );
}
