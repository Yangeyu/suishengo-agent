import { useEffect, useRef, useState } from "react";
import type { ChatSnapshot, SessionSummary } from "@frontend/types/contracts";
import { loadConversation } from "@frontend/features/conversation/api";

function updateLocation(id?: string) {
  const url = new URL(location.href);
  if (id) url.searchParams.set("session", id);
  else url.searchParams.delete("session");
  if (url.href !== location.href) history.pushState(null, "", url);
}

export function useSessionNavigation(onOpen: (snapshot?: ChatSnapshot) => void) {
  const [session, setSession] = useState<SessionSummary>();
  const [opening, setOpening] = useState<string>();
  const [notice, setNotice] = useState("");
  const selection = useRef<AbortController | undefined>(undefined);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    const restore = () => {
      const id = new URLSearchParams(location.search).get("session");
      if (id) void select(id, false);
      else reset(false);
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      selection.current?.abort();
    };
  }, []);

  function begin() {
    selection.current?.abort();
    const controller = new AbortController();
    selection.current = controller;
    setOpening(undefined);
    setNotice("");
    return controller.signal;
  }

  async function select(id: string, navigate = true) {
    const signal = begin();
    setOpening(id);
    try {
      const snapshot = await loadConversation(id, signal);
      signal.throwIfAborted();
      setSession(snapshot.session);
      openRef.current(snapshot);
      if (navigate) updateLocation(id);
    } catch (error) {
      if (!signal.aborted) setNotice((error as Error).message);
    } finally {
      if (!signal.aborted) setOpening(undefined);
    }
  }

  function reset(navigate = true) {
    begin();
    setSession(undefined);
    openRef.current();
    if (navigate) updateLocation();
  }

  function created(value: SessionSummary) {
    setSession(value);
    updateLocation(value.id);
  }

  function renamed(value: SessionSummary) {
    setSession((current) => (current?.id === value.id ? value : current));
  }

  return { session, opening, notice, select, reset, begin, created, renamed };
}
