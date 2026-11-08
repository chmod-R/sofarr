import { type FetchFn, requestJson, send, UpstreamError } from "../upstreams/http.js";
import type { TtlCache } from "./cache.js";

export interface Torrent {
  hash: string; // lowercase
  state: string;
  progress: number; // 0..1
  size: number;
  amount_left: number;
  dlspeed: number; // bytes/s
  eta: number; // seconds; 8640000 = unknown
}

const ETA_UNKNOWN = 8_640_000;
const LIVE_TTL_MS = 5_000;

/**
 * qBittorrent Web API client for live download progress. Keeps one session
 * (re-logging in when it expires) instead of logging in per request.
 */
export class QBittorrent {
  private cookie: string | undefined;
  private loggingIn: Promise<void> | undefined;

  constructor(
    private readonly fetch: FetchFn,
    private readonly cfg: { url: string; username?: string; password?: string },
    private readonly cache: TtlCache,
    private readonly timeoutMs: number,
  ) {}

  private async login(): Promise<void> {
    if (this.cfg.username === undefined || this.cfg.password === undefined) return; // auth bypass
    this.loggingIn ??= (async () => {
      try {
        const res = await send(this.fetch, `${this.cfg.url}/api/v2/auth/login`, {
          timeoutMs: this.timeoutMs,
          method: "POST",
          headers: { Referer: this.cfg.url, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ username: this.cfg.username!, password: this.cfg.password! }).toString(),
        });
        const text = (await res.text()).trim();
        if (res.status !== 204 && text !== "Ok.") throw new UpstreamError("qBittorrent login rejected");
        this.cookie = res.headers
          .getSetCookie()
          .map((c) => c.split(";", 1)[0]?.trim() ?? "")
          .find((c) => /^(QBT_)?SID(_\d+)?=/i.test(c));
      } finally {
        this.loggingIn = undefined;
      }
    })();
    return this.loggingIn;
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.cookie) await this.login();
    const attempt = () =>
      requestJson<T>(this.fetch, `${this.cfg.url}${path}`, {
        timeoutMs: this.timeoutMs,
        headers: { Referer: this.cfg.url, ...(this.cookie && { Cookie: this.cookie }) },
      });
    try {
      return await attempt();
    } catch (err) {
      // Session expired (qBittorrent answers 403): log in again once.
      if (err instanceof UpstreamError && err.status === 403) {
        this.cookie = undefined;
        await this.login();
        return attempt();
      }
      throw err;
    }
  }

  /** All torrents, keyed by lowercase hash. Cached for a few seconds. */
  torrents(): Promise<Map<string, Torrent>> {
    return this.cache.get(`qbit:${this.cfg.url}:torrents`, LIVE_TTL_MS, async () => {
      const list = await this.get<Torrent[]>("/api/v2/torrents/info");
      return new Map(list.map((t) => [t.hash.toLowerCase(), { ...t, hash: t.hash.toLowerCase() }]));
    });
  }
}

/** Seconds → *arr-style "[d.]hh:mm:ss", so the UI has one format to read. */
export function toTimeLeft(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const hms = [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
  return d ? `${d}.${hms}` : hms;
}

const STATE: Record<string, string> = {
  downloading: "downloading",
  forcedDL: "downloading",
  metaDL: "downloading",
  forcedMetaDL: "downloading",
  allocating: "downloading",
  checkingDL: "downloading",
  stalledDL: "stalled",
  queuedDL: "queued",
  pausedDL: "paused",
  stoppedDL: "paused",
  error: "error",
  missingFiles: "error",
};

/**
 * Live progress for one title's torrents. Returns null when none are still
 * downloading (finished torrents: keep the *arr state, e.g. importing).
 */
export function liveProgress(
  torrents: Torrent[],
): { percent: number; timeLeft: string | null; state: string; speedBps: number } | null {
  if (torrents.length === 0 || torrents.every((t) => t.progress >= 1)) return null;
  const size = torrents.reduce((n, t) => n + t.size, 0);
  const left = torrents.reduce((n, t) => n + t.amount_left, 0);
  const etas = torrents.filter((t) => t.progress < 1 && t.eta < ETA_UNKNOWN).map((t) => t.eta);
  const states = torrents.filter((t) => t.progress < 1).map((t) => STATE[t.state] ?? "downloading");
  const state = states.includes("downloading") ? "downloading" : (states[0] ?? "downloading");
  return {
    percent: size > 0 ? Math.round(((size - left) / size) * 1000) / 10 : 0,
    timeLeft: etas.length && state === "downloading" ? toTimeLeft(Math.max(...etas)) : null,
    state,
    speedBps: torrents.reduce((n, t) => n + t.dlspeed, 0),
  };
}
