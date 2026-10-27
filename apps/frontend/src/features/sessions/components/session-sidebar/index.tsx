import { useState } from "react";
import { PanelLeft, Plus, Search, X, Pencil, Trash2, MessageCircle, RotateCcw } from "lucide-react";
import type { SessionSummary } from "@frontend/types/contracts";
import type { SessionAction } from "@frontend/features/sessions/types";
import { IconButton } from "@frontend/components/icon-button";
import { LoadingIndicator } from "@frontend/components/loading-indicator";
import styles from "@frontend/features/sessions/components/session-sidebar/index.module.css";

type SessionSidebarProps = {
  sessions: SessionSummary[];
  currentId?: string;
  opening?: string;
  open: boolean;
  loading: "loading" | "ready" | "failed";
  onClose(): void;
  onNew(): void;
  onSelect(id: string): void;
  onAction(action: SessionAction): void;
  onRefresh(): void;
};

export function SessionSidebar({
  sessions,
  currentId,
  opening,
  open,
  loading,
  onClose,
  onNew,
  onSelect,
  onAction,
  onRefresh,
}: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const ready = loading === "ready";
  const filtered = sessions.filter((session) =>
    session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const groups = new Map<string, SessionSummary[]>();
  for (const session of filtered) {
    const date = new Date(session.createdAt);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const week = new Date(today);
    week.setDate(week.getDate() - 7);
    const group = date >= today ? "今天" : date >= week ? "近 7 天" : "更早";
    groups.set(group, [...(groups.get(group) ?? []), session]);
  }

  return (
    <aside
      className={[styles.sidebar, open && styles.open].filter(Boolean).join(" ")}
      aria-label="会话管理"
      inert={!open}
    >
      <div className={styles.brand}>
        <strong>随申 GO</strong>
        <IconButton
          className={styles.collapseButton}
          aria-label="收起侧栏"
          title="收起侧栏"
          onClick={() => onClose()}
        >
          <PanelLeft aria-hidden="true" />
        </IconButton>
      </div>
      <button className={styles.newSession} disabled={!ready} onClick={() => onNew()}>
        <Plus aria-hidden="true" />
        新建对话
      </button>
      <label className={styles.sessionSearch}>
        <Search aria-hidden="true" />
        <input
          aria-label="搜索会话"
          placeholder="搜索会话"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <IconButton aria-label="清除搜索" onClick={() => setQuery("")}>
            <X aria-hidden="true" />
          </IconButton>
        )}
      </label>
      <nav aria-label="历史会话">
        {[...groups].map(([label, items]) => (
          <div key={label} className={styles.sessionGroup}>
            <h2>{label}</h2>
            {items.map((session) => (
              <div
                className={[styles.sessionRow, session.id === currentId && styles.selected]
                  .filter(Boolean)
                  .join(" ")}
                key={session.id}
              >
                <button
                  className={styles.sessionLink}
                  aria-current={session.id === currentId ? "page" : undefined}
                  title={session.title}
                  onClick={() => void onSelect(session.id)}
                >
                  <span>{session.title}</span>
                  {opening === session.id && <LoadingIndicator />}
                </button>
                <div className={styles.sessionActions}>
                  <IconButton
                    className={styles.actionButton}
                    title="重命名"
                    aria-label={"重命名：" + session.title}
                    onClick={() => onAction({ kind: "rename", session })}
                  >
                    <Pencil aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    className={styles.actionButton}
                    title="删除会话"
                    aria-label={"删除：" + session.title}
                    onClick={() => onAction({ kind: "delete", session })}
                  >
                    <Trash2 aria-hidden="true" />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        ))}
        {!filtered.length && (
          <div className={styles.emptyList}>
            {query ? <Search aria-hidden="true" /> : <MessageCircle aria-hidden="true" />}
            <p>
              {loading === "loading"
                ? "正在加载会话…"
                : query
                  ? "没有找到相关会话"
                  : ready
                    ? "从第一句问候开始"
                    : "暂时无法加载会话"}
            </p>
            <small>{query ? "试试其他标题关键词" : "你的对话会保存在这里"}</small>
          </div>
        )}
      </nav>
      <div className={styles.sidebarFooter}>
        <div className={styles.profileMark}>GO</div>
        <div>
          <strong>开发工作台</strong>
          <span>
            <i className={[styles.dot, ready && styles.online].filter(Boolean).join(" ")} />
            {ready ? "服务可用" : loading === "loading" ? "正在连接" : "服务不可用"}
          </span>
        </div>
        <IconButton
          disabled={loading === "loading"}
          className={styles.refreshButton}
          aria-label="刷新会话列表"
          title="刷新会话列表"
          onClick={() => void onRefresh()}
        >
          <RotateCcw aria-hidden="true" />
        </IconButton>
      </div>
    </aside>
  );
}
