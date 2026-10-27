import { useRef, useState } from "react";
import { PanelLeft } from "lucide-react";
import { useSessions } from "@frontend/features/sessions/hooks/use-sessions";
import { useConversation } from "@frontend/features/conversation/hooks/use-conversation";
import { useSessionNavigation } from "@frontend/pages/chat/hooks/use-session-navigation";
import { useWorkbench } from "@frontend/pages/chat/hooks/use-workbench";
import type { SessionAction } from "@frontend/features/sessions/types";
import { SessionSidebar } from "@frontend/features/sessions/components/session-sidebar";
import { SessionDialog } from "@frontend/features/sessions/components/session-dialog";
import { Conversation } from "@frontend/features/conversation/components/conversation";
import { IconButton } from "@frontend/components/icon-button";
import { Notice } from "@frontend/components/notice";
import styles from "@frontend/pages/chat/index.module.css";

export function ChatPage() {
  const sessions = useSessions();
  const conversation = useConversation();
  const navigation = useSessionNavigation(conversation.open);
  const workbench = useWorkbench(sessions.load);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const [action, setAction] = useState<SessionAction>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [sendNotice, setSendNotice] = useState("");
  const submitting = useRef(false);
  const currentId = navigation.session?.id;
  const draftKey = currentId ?? "new";
  const ready = workbench.loading === "ready" && !navigation.opening;
  const notice = workbench.notice || navigation.notice;

  function closeMobileSidebar() {
    if (window.innerWidth <= 760) setSidebarOpen(false);
  }

  function newConversation() {
    navigation.reset();
    setSendNotice("");
    closeMobileSidebar();
  }

  async function selectSession(id: string) {
    setSendNotice("");
    await navigation.select(id);
    closeMobileSidebar();
  }

  async function send() {
    const text = (drafts[draftKey] ?? "").trim();
    if (
      !text ||
      !ready ||
      !workbench.modelReady ||
      conversation.busy ||
      conversation.working ||
      conversation.runId ||
      submitting.current
    )
      return;
    submitting.current = true;
    setSendNotice("");
    try {
      let sending;
      if (currentId) {
        sending = conversation.send(text);
      } else {
        const signal = navigation.begin();
        setCreating(true);
        const session = await sessions.create(text, signal);
        signal.throwIfAborted();
        navigation.created(session);
        const target = conversation.open({ session, messages: [], activeRun: null });
        sending = conversation.send(text, target);
      }
      setDrafts((current) => ({ ...current, [draftKey]: "" }));
      setCreating(false);
      await sending;
    } catch (error) {
      if ((error as Error).name !== "AbortError") setSendNotice((error as Error).message);
    } finally {
      submitting.current = false;
      setCreating(false);
    }
  }

  async function manageSession(title: string) {
    if (!action) return;
    const { session, kind } = action;
    if (kind === "rename") {
      navigation.renamed(await sessions.rename(session.id, title));
    } else {
      await sessions.remove(session.id);
      setDrafts((current) => {
        const next = { ...current };
        delete next[session.id];
        return next;
      });
      if (currentId === session.id || navigation.opening === session.id) newConversation();
    }
    setAction(undefined);
  }

  return (
    <div className={styles.workspace}>
      {sidebarOpen && (
        <button
          className={styles.sidebarBackdrop}
          aria-label="关闭会话侧栏"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <SessionSidebar
        sessions={sessions.sessions}
        currentId={currentId}
        opening={navigation.opening}
        open={sidebarOpen}
        loading={workbench.loading}
        onClose={() => setSidebarOpen(false)}
        onNew={newConversation}
        onSelect={(id) => void selectSession(id)}
        onAction={setAction}
        onRefresh={() => void workbench.refresh()}
      />
      <main className={styles.main}>
        <header className={styles.mainHeader}>
          <div className={styles.headerTitle}>
            {!sidebarOpen && (
              <IconButton
                aria-label="展开侧栏"
                title="展开侧栏"
                onClick={() => setSidebarOpen(true)}
              >
                <PanelLeft aria-hidden="true" />
              </IconButton>
            )}
            <span className={styles.assistantName}>申申</span>
            <span className={styles.headerDivider}>/</span>
            <h1 className={styles.title}>{navigation.session?.title ?? "新对话"}</h1>
          </div>
          <span className={styles.workbenchLabel}>随申 GO · 开发预览</span>
        </header>
        {notice && (
          <Notice className={styles.pageNotice} role="alert">
            {notice}
            <button
              onClick={() => {
                void workbench.refresh();
                const id = new URLSearchParams(location.search).get("session");
                if (id) void selectSession(id);
              }}
            >
              重新加载
            </button>
          </Notice>
        )}
        <Conversation
          sessionId={currentId}
          messages={conversation.messages}
          busy={conversation.busy}
          pendingRun={!!conversation.runId && !conversation.busy}
          working={creating || conversation.working}
          submitted={conversation.status === "submitted"}
          ready={ready}
          modelReady={workbench.modelReady}
          notice={sendNotice || conversation.notice}
          error={conversation.error}
          draft={drafts[draftKey] ?? ""}
          onDraft={(text) => setDrafts((current) => ({ ...current, [draftKey]: text }))}
          onSend={() => void send()}
          onCancel={() => void conversation.cancel()}
          onSynchronize={() => void conversation.synchronize()}
          onRetry={() => void conversation.retry()}
        />
      </main>
      {action && (
        <SessionDialog
          key={action.kind + action.session.id}
          action={action}
          onClose={() => setAction(undefined)}
          onSave={manageSession}
        />
      )}
    </div>
  );
}
