import { request } from "@frontend/lib/http";
import type { SessionSummary } from "@frontend/types/contracts";

export function listSessions(signal?: AbortSignal) {
  return request<SessionSummary[]>("/sessions", { signal });
}

export function createSession(text: string, signal?: AbortSignal) {
  const title = Array.from(text.replace(/\s+/g, " ")).slice(0, 40).join("");
  return request<SessionSummary>("/sessions", {
    method: "POST",
    signal,
    body: JSON.stringify({ title }),
  });
}

export function renameSession(id: string, title: string) {
  return request<SessionSummary>("/sessions/" + id, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export function deleteSession(id: string) {
  return request<void>("/sessions/" + id, { method: "DELETE" });
}
