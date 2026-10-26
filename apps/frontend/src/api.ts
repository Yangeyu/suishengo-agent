export async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch("/api" + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: "Bearer " + token, ...init.headers },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? "请求失败");
  return value as T;
}
