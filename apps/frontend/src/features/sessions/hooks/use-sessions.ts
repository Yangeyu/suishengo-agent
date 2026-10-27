import { useState } from "react";
import type { SessionSummary } from "@frontend/types/contracts";
import {
  listSessions,
  createSession,
  renameSession,
  deleteSession,
} from "@frontend/features/sessions/api";

export function useSessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  async function load(signal: AbortSignal) {
    const list = await listSessions(signal);
    signal.throwIfAborted();
    setSessions(list);
  }

  async function create(text: string, signal: AbortSignal) {
    const session = await createSession(text, signal);
    signal.throwIfAborted();
    setSessions((current) => [session, ...current].slice(0, 100));
    return session;
  }

  async function rename(id: string, title: string) {
    const session = await renameSession(id, title);
    setSessions((current) => current.map((item) => (item.id === id ? session : item)));
    return session;
  }

  async function remove(id: string) {
    await deleteSession(id);
    setSessions((current) => current.filter((item) => item.id !== id));
  }

  return { sessions, load, create, rename, remove };
}
