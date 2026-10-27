import { useEffect, useRef, useState } from "react";
import { loadCapabilities } from "@frontend/pages/chat/api";

export function useWorkbench(loadSessions: (signal: AbortSignal) => Promise<void>) {
  const [loading, setLoading] = useState<"loading" | "ready" | "failed">("loading");
  const [modelReady, setModelReady] = useState(false);
  const [notice, setNotice] = useState("");
  const request = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, []);

  async function refresh() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading("loading");
    setNotice("");
    try {
      const [, capabilities] = await Promise.all([
        loadSessions(controller.signal),
        loadCapabilities(controller.signal),
      ]);
      controller.signal.throwIfAborted();
      setModelReady(capabilities.modelConfigured);
      setLoading("ready");
    } catch (error) {
      if (controller.signal.aborted) return;
      setLoading("failed");
      setNotice((error as Error).message);
    }
  }

  return { loading, modelReady, notice, refresh };
}
