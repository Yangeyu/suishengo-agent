import { useMemo, useRef, useState, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { ChatMessage, SessionSnapshot, SessionSummary } from "@protocol";
import { request } from "@frontend/api";

export function App() {
  const [token, setToken] = useState("");
  const [credential, setCredential] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [initialMessages, setInitialMessages] = useState<ChatMessage[]>([]);
  const [modelReady, setModelReady] = useState(false);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");
  const activeRun = useRef<string | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);
  const transport = useMemo(() => new DefaultChatTransport<ChatMessage>({
    api: "/api/chat",
    headers: () => ({ authorization: "Bearer " + token }),
    prepareSendMessagesRequest: ({ messages }) => {
      const message = messages.at(-1)!;
      return { body: { sessionId, requestId: message.id, message: {
        id: message.id, role: message.role, parts: message.parts,
      } } };
    },
    prepareReconnectToStreamRequest: () => ({ api: "/api/runs/" + activeRun.current + "/stream" }),
  }), [token, sessionId]);
  const { messages, setMessages, sendMessage, status, error, stop, resumeStream, clearError } = useChat<ChatMessage>({
    id: sessionId ?? "unselected", messages: initialMessages, transport, generateId: () => crypto.randomUUID(),
  });
  const busy = status === "submitted" || status === "streaming";
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

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
    } catch (error) { setNotice((error as Error).message); }
  }
  async function selectSession(id: string) {
    try {
      await stop();
      clearError();
      const snapshot = await request<SessionSnapshot>("/sessions/" + id, token);
      if (id === sessionId) setMessages(snapshot.messages);
      else {
        setInitialMessages(snapshot.messages);
        setSessionId(id);
      }
      activeRun.current = snapshot.activeRun?.id;
      setNotice(snapshot.activeRun ? "这个会话仍在生成，可恢复输出。" : modelReady ? "" : "后端已连接。配置模型后可开始对话。");
    } catch (error) { setNotice((error as Error).message); }
  }
  async function createSession() {
    try {
      const session = await request<SessionSummary>("/sessions", token, { method: "POST", body: JSON.stringify({ title: "新对话" }) });
      setSessions(current => [session, ...current]);
      await selectSession(session.id);
    } catch (error) { setNotice((error as Error).message); }
  }
  async function send() {
    const text = input.trim();
    if (!text || !sessionId) return;
    setNotice("");
    setInput("");
    try { await sendMessage({ text }); }
    catch (error) { setNotice((error as Error).message); }
  }
  async function cancel() {
    try {
      const snapshot = await request<SessionSnapshot>("/sessions/" + sessionId, token);
      if (snapshot.activeRun) await request("/runs/" + snapshot.activeRun.id + "/cancel", token, { method: "POST" });
      await stop();
      activeRun.current = undefined;
      setNotice("运行已停止");
    } catch (error) { setNotice((error as Error).message); }
  }
  async function resume() {
    if (!sessionId) return;
    const snapshot = await request<SessionSnapshot>("/sessions/" + sessionId, token);
    const runId = snapshot.activeRun?.id ?? activeRun.current;
    if (!runId) { setMessages(snapshot.messages); return; }
    activeRun.current = runId;
    // Replay this run from the beginning, replacing its prior partial assistant message.
    setMessages(snapshot.messages.filter(message => !(message.role === "assistant" && message.metadata?.runId === runId)));
    setNotice("");
    await resumeStream();
  }

  return <div className="workspace">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">申</span><div><strong>随申 GO</strong><small>Agent 开发工作台</small></div></div>
      <button className="new-session" disabled={!token} onClick={() => void createSession()}>＋ 新建对话</button>
      <div className="section-label">会话记录</div>
      <nav aria-label="会话">
        {sessions.map(session => <button key={session.id} className={session.id === sessionId ? "session selected" : "session"}
          onClick={() => void selectSession(session.id)}>
          <span>{session.title}</span><small>{new Date(session.createdAt).toLocaleString("zh-CN")}</small>
        </button>)}
        {!sessions.length && <p className="empty-list">连接后创建第一个会话</p>}
      </nav>
      <div className="sidebar-footer"><span className={token ? "dot online" : "dot"} />{token ? "已认证" : "未连接"}<span>仅开发测试</span>
        {token && <button onClick={() => { void stop(); setToken(""); setSessions([]); setSessionId(undefined); setInitialMessages([]); setMessages([]); activeRun.current = undefined; setNotice(""); setInput(""); }}>断开</button>}
      </div>
    </aside>
    <main>
      <header><div><h1>申申</h1><p>对话、接口与流式输出验证</p></div>
        {token && sessionId && !busy && <button onClick={() => void resume().catch(error => setNotice(error.message))}>同步 / 恢复输出</button>}
        <span className="badge">{busy ? "生成中" : token ? "已连接" : "等待连接"}</span></header>
      {!token ? <section className="connect-panel">
        <span className="eyebrow">开始开发</span><h2>连接你的 Agent 服务</h2>
        <p>使用本地开发令牌进入工作台。不同用户的会话分别保存。</p>
        <form onSubmit={event => { event.preventDefault(); void connect(); }}>
          <label htmlFor="token">访问令牌</label>
          <input id="token" type="password" autoComplete="off" value={credential} onChange={event => setCredential(event.target.value)} placeholder="Bearer token" required />
          <button className="primary" type="submit">连接服务</button>
        </form>
        <small>本地令牌：<code>pnpm dev:token developer-a</code></small>
      </section> : <section className="conversation" aria-live="polite">
        {!messages.length && <div className="welcome"><span className="welcome-icon">申</span><h2>{sessionId ? "开始一次对话" : "创建或选择一个会话"}</h2><p>文本对话已接入统一消息协议。票根和权益工具将在业务接口接入后开放。</p></div>}
        {messages.map(message => <article key={message.id} className={"message " + message.role}>
          <div className="speaker">{message.role === "user" ? "你" : "申申"}</div>
          {message.parts.map((part, index) => part.type === "text" ? <p key={index}>{part.text}</p>
            : part.type === "data-perks" ? <div className="business-card" key={index}>{part.data.items.map(item => <p key={item.perkId}>{item.perkId}：{item.reason}</p>)}</div>
            : part.type === "data-ticket" ? <div className="business-card" key={index}>票根 {part.data.ticketId} · {part.data.status}</div> : null)}
        </article>)}
        <div ref={end} />
      </section>}
      {(notice || error) && <div className="notice" role="status">{notice || error?.message}
        {activeRun.current && !busy && <button onClick={() => void resume().catch(error => setNotice(error.message))}>恢复输出</button>}
      </div>}
      {token && <footer>
        <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}>
          <textarea aria-label="消息" value={input} onChange={event => setInput(event.target.value)} placeholder="输入消息…" maxLength={4000}
            disabled={!sessionId || !modelReady || busy} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          {busy ? <button type="button" onClick={() => void cancel()}>停止</button>
            : <button className="primary" disabled={!sessionId || !modelReady || !input.trim()} type="submit">发送</button>}
        </form>
        <small>Enter 发送，Shift + Enter 换行</small>
      </footer>}
    </main>
  </div>;
}
