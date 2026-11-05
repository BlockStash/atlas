export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "include",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(body === undefined ? 20000 : 60000),
  });
  const data = await response.json().catch(() => null);
  if (
    response.status === 401 &&
    path !== "/auth/session" &&
    typeof window !== "undefined"
  )
    window.dispatchEvent(new Event("atlas-session-expired"));
  if (!response.ok)
    throw new Error(
      data?.error?.message ||
        "Atlas is temporarily unavailable. Please try again.",
    );
  return data as T;
}
