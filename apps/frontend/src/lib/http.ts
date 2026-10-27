export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api" + path, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new Error("无法访问工作台服务，请确认前后端已启动后重试。");
  }

  if (!response.ok) {
    const value = await response.json().catch(() => undefined);
    throw new Error(
      value?.error?.message ??
        (response.status >= 500
          ? "服务暂不可用，请检查后端运行状态后重试。"
          : `请求失败（HTTP ${response.status}）`),
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
