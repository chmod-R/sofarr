export type FetchFn = typeof fetch;

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** GET/POST JSON with a timeout; throws UpstreamError on network failure or non-2xx. */
export async function requestJson<T>(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<T> {
  const res = await send(fetchFn, url, init);
  try {
    return (await res.json()) as T;
  } catch {
    throw new UpstreamError("response was not valid JSON", res.status);
  }
}

export async function send(
  fetchFn: FetchFn,
  url: string,
  { timeoutMs, ...init }: RequestInit & { timeoutMs: number },
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      ...init,
      headers: { Accept: "application/json", ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new UpstreamError(`timed out after ${timeoutMs} ms`);
    }
    const cause = (err as { cause?: { code?: string } })?.cause?.code;
    throw new UpstreamError(cause ? `unreachable (${cause})` : "unreachable");
  }
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? " (check credentials)" : "";
    throw new UpstreamError(`HTTP ${res.status}${hint}`, res.status);
  }
  return res;
}
