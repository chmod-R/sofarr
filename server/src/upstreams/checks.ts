import type { Config } from "../config.js";
import { type FetchFn, requestJson, send, UpstreamError } from "./http.js";

export type UpstreamName = "plex" | "radarr" | "sonarr" | "qbittorrent" | "tmdb";

export type UpstreamStatus =
  | { status: "ok"; version?: string; latencyMs: number }
  | { status: "error"; error: string; latencyMs: number }
  | { status: "not_configured" };

interface Ctx {
  fetch: FetchFn;
  timeoutMs: number;
}

/** Each check returns the upstream's version string (if it reports one). */
type Check = (ctx: Ctx) => Promise<string | undefined>;

function plexCheck(url: string): Check {
  // /identity is unauthenticated and cheap.
  return async ({ fetch, timeoutMs }) => {
    const body = await requestJson<{ MediaContainer?: { version?: string } }>(
      fetch,
      `${url}/identity`,
      { timeoutMs },
    );
    return body.MediaContainer?.version;
  };
}

function arrCheck(url: string, apiKey: string): Check {
  return async ({ fetch, timeoutMs }) => {
    const body = await requestJson<{ version?: string }>(fetch, `${url}/api/v3/system/status`, {
      timeoutMs,
      headers: { "X-Api-Key": apiKey },
    });
    return body.version;
  };
}

function qbittorrentCheck(q: NonNullable<Config["qbittorrent"]>): Check {
  return async ({ fetch, timeoutMs }) => {
    const headers: Record<string, string> = { Referer: q.url };
    if (q.username !== undefined && q.password !== undefined) {
      const res = await send(fetch, `${q.url}/api/v2/auth/login`, {
        timeoutMs,
        method: "POST",
        headers: { Referer: q.url, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: q.username, password: q.password }).toString(),
      });
      // Older qBittorrent answers 200 "Ok." / "Fails." with cookie `SID`;
      // newer versions answer 204 (empty) on success with cookie `QBT_SID_<port>`.
      const text = (await res.text()).trim();
      const ok = res.status === 204 || text === "Ok.";
      if (!ok) throw new UpstreamError("login rejected (check credentials)");
      const session = res.headers
        .getSetCookie()
        .map((c) => c.split(";", 1)[0]?.trim() ?? "")
        .find((c) => /^(QBT_)?SID(_\d+)?=/i.test(c));
      if (!session) throw new UpstreamError("login succeeded but no session cookie was returned");
      headers.Cookie = session;
    }
    try {
      const res = await send(fetch, `${q.url}/api/v2/app/version`, { timeoutMs, headers });
      return (await res.text()).trim() || undefined;
    } finally {
      // Don't leave a session behind for every health check (best effort).
      if (headers.Cookie) {
        await send(fetch, `${q.url}/api/v2/auth/logout`, { timeoutMs, method: "POST", headers }).catch(
          () => undefined,
        );
      }
    }
  };
}

function tmdbCheck(apiKey: string): Check {
  // v4 read access tokens are JWTs; v3 keys are 32 hex chars.
  const isBearer = apiKey.startsWith("eyJ");
  return async ({ fetch, timeoutMs }) => {
    const u = new URL("https://api.themoviedb.org/3/configuration");
    if (!isBearer) u.searchParams.set("api_key", apiKey);
    await requestJson(fetch, u.toString(), {
      timeoutMs,
      headers: isBearer ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    return undefined;
  };
}

export function buildChecks(config: Config): Record<UpstreamName, Check | undefined> {
  return {
    plex: config.plex && plexCheck(config.plex.url),
    radarr: config.radarr && arrCheck(config.radarr.url, config.radarr.apiKey),
    sonarr: config.sonarr && arrCheck(config.sonarr.url, config.sonarr.apiKey),
    qbittorrent: config.qbittorrent && qbittorrentCheck(config.qbittorrent),
    tmdb: config.tmdb && tmdbCheck(config.tmdb.apiKey),
  };
}

export async function checkUpstreams(
  config: Config,
  fetchFn: FetchFn = fetch,
): Promise<Record<UpstreamName, UpstreamStatus>> {
  const ctx: Ctx = { fetch: fetchFn, timeoutMs: config.upstreamTimeoutMs };
  const entries = await Promise.all(
    Object.entries(buildChecks(config)).map(async ([name, check]) => {
      if (!check) return [name, { status: "not_configured" }] as const;
      const started = performance.now();
      const latencyMs = () => Math.round(performance.now() - started);
      try {
        const version = await check(ctx);
        const ok: UpstreamStatus = { status: "ok", latencyMs: latencyMs() };
        if (version) ok.version = version;
        return [name, ok] as const;
      } catch (err) {
        const error = err instanceof UpstreamError ? err.message : "unexpected error";
        return [name, { status: "error", error, latencyMs: latencyMs() }] as const;
      }
    }),
  );
  return Object.fromEntries(entries) as Record<UpstreamName, UpstreamStatus>;
}
