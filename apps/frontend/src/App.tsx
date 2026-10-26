import type { SessionSummary } from "@harness/sessions";
import type { ChatSnapshot, MessageMetadata } from "@frontend/api";
import { useMemo, useRef, useState, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { request } from "@frontend/api";

export function App() {
  const [token, setToken] = useState("");
  const [credential, setCredential] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [initialMessages, setInitialMessages] = useState<UIMessage<MessageMetadata>[]>([]);
  const [modelReady, setModelReady] = useState(false);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");

  const activeRun = useRef<string | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage<MessageMetadata>>({
        api: "/api/chat",
        headers: () => ({ authorization: "Bearer " + token }),
        prepareSendMessagesRequest: ({ messages }) => {
          const message = messages.at(-1)!;

          return {
            body: {
              sessionId,
              requestId: message.id,
              message: {
                id: message.id,
                role: message.role,
                parts: message.parts,
              },
            },
          };
        },
        prepareReconnectToStreamRequest: () => ({
          api: "/api/runs/" + activeRun.current + "/stream",
        }),
      }),
    [token, sessionId],
  );

  const { messages, setMessages, sendMessage, status, error, stop, resumeStream, clearError } =
    useChat<UIMessage<MessageMetadata>>({
      id: sessionId ?? "unselected",
      messages: initialMessages,
      transport,
      generateId: () => crypto.randomUUID(),
    });
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function connect() {
    try {
      await stop();
      setToken("");
      setSessions([]);
      setSessionId(undefined);
      setInitialMessages([]);
      setMessages([]);

      const [list, capabilities] = await Promise.all([
        request<SessionSummary[]>("/sessions", credential),
        request<{ modelConfigured: boolean }>("/capabilities", credential),
      ]);

      setToken(credential);
      setCredential("");
      setSessions(list);
      setModelReady(capabilities.modelConfigured);
      setNotice(capabilities.modelConfigured ? "" : "后端已连接。配置模型后可开始对话。");
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function selectSession(id: string) {
    try {
      await stop();
      clearError();

      const snapshot = await request<ChatSnapshot>("/sessions/" + id, token);
      if (id === sessionId) setMessages(snapshot.messages);
      else {
        setInitialMessages(snapshot.messages);
        setSessionId(id);
      }

      activeRun.current = snapshot.activeRun?.id;
      setNotice(
        snapshot.activeRun
          ? "这个会话仍在生成，可恢复输出。"
          : modelReady
            ? ""
            : "后端已连接。配置模型后可开始对话。",
      );
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function createSession() {
    try {
      const session = await request<SessionSummary>("/sessions", token, {
        method: "POST",
        body: JSON.stringify({ title: "新对话" }),
      });

      setSessions((current) => [session, ...current]);
      await selectSession(session.id);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || !sessionId) return;

    setNotice("");
    setInput("");

    try {
      await sendMessage({ text });
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function cancel() {
    try {
      const snapshot = await request<ChatSnapshot>("/sessions/" + sessionId, token);
      if (snapshot.activeRun)
        await request("/runs/" + snapshot.activeRun.id + "/cancel", token, { method: "POST" });

      await stop();
      activeRun.current = undefined;
      setNotice("运行已停止");
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function resume() {
    if (!sessionId) return;

    const snapshot = await request<ChatSnapshot>("/sessions/" + sessionId, token);
    const runId = snapshot.activeRun?.id ?? activeRun.current;
    if (!runId) {
      setMessages(snapshot.messages);
      return;
    }

    // 整轮重放前移除旧的部分回答，保留用户输入及其他历史消息。
    activeRun.current = runId;
    setMessages(
      snapshot.messages.filter(
        (message) => !(message.role === "assistant" && message.metadata?.runId === runId),
      ),
    );
    setNotice("");
    await resumeStream();
  }

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">申</span>
          <div>
            <strong>随申 GO</strong>
            <small>Agent 开发工作台</small>
          </div>
        </div>
        <button className="new-session" disabled={!token} onClick={() => void createSession()}>
          ＋ 新建对话
        </button>
        <div className="section-label">会话记录</div>
        <nav aria-label="会话">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={session.id === sessionId ? "session selected" : "session"}
              onClick={() => void selectSession(session.id)}
            >
              <span>{session.title}</span>
              <small>{new Date(session.createdAt).toLocaleString("zh-CN")}</small>
            </button>
          ))}
          {!sessions.length && <p className="empty-list">连接后创建第一个会话</p>}
        </nav>
        <div className="sidebar-footer">
          <span className={token ? "dot online" : "dot"} />
          {token ? "已认证" : "未连接"}
          <span>仅开发测试</span>
          {token && (
            <button
              onClick={() => {
                void stop();
                setToken("");
                setSessions([]);
                setSessionId(undefined);
                setInitialMessages([]);
                setMessages([]);
                activeRun.current = undefined;
                setNotice("");
                setInput("");
              }}
            >
              断开
            </button>
          )}
        </div>
      </aside>
      <main>
        <header>
          <div>
            <h1>申申</h1>
            <p>对话、接口与流式输出验证</p>
          </div>
          {token && sessionId && !busy && (
            <button onClick={() => void resume().catch((error) => setNotice(error.message))}>
              同步 / 恢复输出
            </button>
          )}
          <span className="badge">{busy ? "生成中" : token ? "已连接" : "等待连接"}</span>
        </header>
        {!token ? (
          <section className="connect-panel">
            <span className="eyebrow">开始开发</span>
            <h2>连接你的 Agent 服务</h2>
            <p>使用本地开发令牌进入工作台。不同用户的会话分别保存。</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void connect();
              }}
            >
              <label htmlFor="token">访问令牌</label>
              <input
                id="token"
                type="password"
                autoComplete="off"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                placeholder="Bearer token"
                required
              />
              <button className="primary" type="submit">
                连接服务
              </button>
            </form>
            <small>
              本地令牌：<code>pnpm dev:token developer-a</code>
            </small>
          </section>
        ) : (
          <section className="conversation" aria-live="polite">
            {!messages.length && (
              <div className="welcome">
                <span className="welcome-icon">申</span>
                <h2>{sessionId ? "开始一次对话" : "创建或选择一个会话"}</h2>
                <p>可查看回答与工具调用过程。可用业务能力由服务端配置决定。</p>
              </div>
            )}
            {messages.map((message) => (
              <article key={message.id} className={"message " + message.role}>
                <div className="speaker">{message.role === "user" ? "你" : "申申"}</div>
                {message.parts.map((part, index) => (
                  <MessagePart key={index} part={part} />
                ))}
              </article>
            ))}
            <div ref={end} />
          </section>
        )}
        {(notice || error) && (
          <div className="notice" role="status">
            {notice || error?.message}
            {activeRun.current && !busy && (
              <button onClick={() => void resume().catch((error) => setNotice(error.message))}>
                恢复输出
              </button>
            )}
          </div>
        )}
        {token && (
          <footer>
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <textarea
                aria-label="消息"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="输入消息…"
                maxLength={4000}
                disabled={!sessionId || !modelReady || busy}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              {busy ? (
                <button type="button" onClick={() => void cancel()}>
                  停止
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={!sessionId || !modelReady || !input.trim()}
                  type="submit"
                >
                  发送
                </button>
              )}
            </form>
            <small>Enter 发送，Shift + Enter 换行</small>
          </footer>
        )}
      </main>
    </div>
  );
}

function MessagePart({ part }: { part: UIMessage<MessageMetadata>["parts"][number] }) {
  if (part.type === "text") return <p>{part.text}</p>;
  if (part.type !== "dynamic-tool") return null;

  const status =
    part.state === "output-available"
      ? "已完成"
      : part.state === "output-error"
        ? "执行失败"
        : "执行中";

  return (
    <details className="tool-call" open={part.state === "output-error"}>
      <summary>
        {part.toolName} · {status}
      </summary>
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
