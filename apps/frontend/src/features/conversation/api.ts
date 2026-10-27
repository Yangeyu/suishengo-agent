import { request } from "@frontend/lib/http";
import type { ChatSnapshot } from "@frontend/types/contracts";

export function loadConversation(id: string, signal: AbortSignal) {
  return request<ChatSnapshot>("/sessions/" + id, { signal });
}

export function cancelRun(id: string, signal: AbortSignal) {
  return request("/runs/" + id + "/cancel", { method: "POST", signal });
}
