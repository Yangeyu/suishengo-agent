import { request } from "@frontend/lib/http";

export function loadCapabilities(signal: AbortSignal) {
  return request<{ modelConfigured: boolean }>("/capabilities", { signal });
}
