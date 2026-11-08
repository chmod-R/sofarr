import type { ArrConfig } from "../config.js";
import { type FetchFn, requestJson } from "../upstreams/http.js";
import type { TtlCache } from "./cache.js";
import { liveProgress, type QBittorrent, type Torrent } from "./qbit.js";
import type { MediaType } from "./tmdb.js";

/** What Radarr/Sonarr know about a title, keyed by `${mediaType}:${tmdbId}`. */
export interface ArrEntry {
  mediaType: MediaType;
  tmdbId: number;
  arrId: number;
  monitored: boolean;
  /** Movie: file on disk. Series: at least one episode file. */
  hasFiles: boolean;
  /** Torrent hashes (lowercase) of this title's queue items. */
  downloadIds?: string[];
  /** Series only. */
  tvdbId?: number;
  /** Series only: seasons Sonarr is monitoring. */
  monitoredSeasons?: number[];
  download?: DownloadInfo;
}

export interface DownloadInfo {
  /** 0–100 across all queue items for the title. */
  percent: number;
  /** Sonarr/Radarr "hh:mm:ss" (or "d.hh:mm:ss") for the slowest item, if known. */
  timeLeft: string | null;
  /** downloading | importPending | importing | failedPending | ... (from *arr). */
  state: string;
  items: number;
  /** Seasons with queue items (series only). */
  seasons?: number[];
  /** Live download speed in bytes/s (from qBittorrent, when available). */
  speedBps?: number;
}

interface QueueRecord {
  movieId?: number;
  seriesId?: number;
  seasonNumber?: number;
  /** Download client id; for qBittorrent, the torrent hash. */
  downloadId?: string;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  status?: string;
  trackedDownloadState?: string;
}

interface Paged<T> {
  totalRecords: number;
  records: T[];
}

const SHORT = 30_000;

export class Arr {
  constructor(
    private readonly fetch: FetchFn,
    private readonly cache: TtlCache,
    private readonly timeoutMs: number,
    private readonly radarr?: ArrConfig,
    private readonly sonarr?: ArrConfig,
    private readonly qbit?: QBittorrent,
  ) {}

  private get<T>(cfg: ArrConfig, path: string): Promise<T> {
    return this.cache.get(`arr:${cfg.url}${path}`, SHORT, () =>
      requestJson<T>(this.fetch, `${cfg.url}${path}`, {
        timeoutMs: this.timeoutMs,
        headers: { "X-Api-Key": cfg.apiKey },
      }),
    );
  }

  /** Forget cached lists so a request shows up immediately. */
  invalidate(): void {
    this.cache.invalidate("arr:");
  }

  /**
   * *arr entries with live progress from qBittorrent overlaid. *arr refreshes
   * its queue about once a minute; qBittorrent is read every few seconds.
   */
  async entries(): Promise<Map<string, ArrEntry>> {
    const base = await this.arrEntries();
    if (!this.qbit) return base;
    let torrents: Map<string, Torrent>;
    try {
      torrents = await this.qbit.torrents();
    } catch {
      return base; // fall back to *arr's own numbers
    }
    const out = new Map<string, ArrEntry>();
    for (const [k, e] of base) {
      const ts = (e.downloadIds ?? []).flatMap((h) => torrents.get(h) ?? []);
      const live = e.download && liveProgress(ts);
      out.set(k, live ? { ...e, download: { ...e.download!, ...live } } : e);
    }
    return out;
  }

  private async arrEntries(): Promise<Map<string, ArrEntry>> {
    const out = new Map<string, ArrEntry>();
    const tasks: Promise<void>[] = [];

    if (this.radarr) {
      const cfg = this.radarr;
      tasks.push(
        (async () => {
          const [movies, queue] = await Promise.all([
            this.get<Array<{ id: number; tmdbId: number; monitored: boolean; hasFile: boolean }>>(
              cfg,
              "/api/v3/movie",
            ),
            this.get<Paged<QueueRecord>>(cfg, "/api/v3/queue?pageSize=500&includeUnknownMovieItems=false"),
          ]);
          const dl = groupQueue(queue.records, (r) => r.movieId);
          const ids = queueIds(queue.records, (r) => r.movieId);
          for (const m of movies) {
            if (!m.tmdbId) continue;
            const e: ArrEntry = {
              mediaType: "movie",
              tmdbId: m.tmdbId,
              arrId: m.id,
              monitored: m.monitored,
              hasFiles: m.hasFile,
            };
            const d = dl.get(m.id);
            if (d) e.download = d;
            const h = ids.get(m.id);
            if (h) e.downloadIds = h;
            out.set(`movie:${m.tmdbId}`, e);
          }
        })(),
      );
    }

    if (this.sonarr) {
      const cfg = this.sonarr;
      tasks.push(
        (async () => {
          const [series, queue] = await Promise.all([
            this.get<
              Array<{
                id: number;
                tmdbId?: number;
                tvdbId?: number;
                monitored: boolean;
                seasons?: Array<{ seasonNumber: number; monitored: boolean }>;
                statistics?: { episodeFileCount?: number };
              }>
            >(cfg, "/api/v3/series"),
            this.get<Paged<QueueRecord>>(cfg, "/api/v3/queue?pageSize=500&includeUnknownSeriesItems=false"),
          ]);
          const dl = groupQueue(queue.records, (r) => r.seriesId);
          const ids = queueIds(queue.records, (r) => r.seriesId);
          for (const s of series) {
            if (!s.tmdbId) continue;
            const e: ArrEntry = {
              mediaType: "tv",
              tmdbId: s.tmdbId,
              arrId: s.id,
              monitored: s.monitored,
              hasFiles: (s.statistics?.episodeFileCount ?? 0) > 0,
              monitoredSeasons: (s.seasons ?? []).filter((x) => x.monitored).map((x) => x.seasonNumber),
            };
            if (s.tvdbId) e.tvdbId = s.tvdbId;
            const d = dl.get(s.id);
            if (d) e.download = d;
            const h = ids.get(s.id);
            if (h) e.downloadIds = h;
            out.set(`tv:${s.tmdbId}`, e);
          }
        })(),
      );
    }

    await Promise.all(tasks);
    return out;
  }
}

/** Distinct download ids (lowercased) per title. A season pack appears once per episode. */
export function queueIds(
  records: QueueRecord[],
  idOf: (r: QueueRecord) => number | undefined,
): Map<number, string[]> {
  const out = new Map<number, Set<string>>();
  for (const r of records) {
    const id = idOf(r);
    if (id === undefined || !r.downloadId) continue;
    out.set(id, (out.get(id) ?? new Set()).add(r.downloadId.toLowerCase()));
  }
  return new Map([...out].map(([k, v]) => [k, [...v]]));
}

/** Sum queue items per title into one progress figure. */
export function groupQueue(
  records: QueueRecord[],
  idOf: (r: QueueRecord) => number | undefined,
): Map<number, DownloadInfo> {
  const groups = new Map<number, QueueRecord[]>();
  for (const r of records) {
    const id = idOf(r);
    if (id === undefined) continue;
    groups.set(id, [...(groups.get(id) ?? []), r]);
  }
  const out = new Map<number, DownloadInfo>();
  for (const [id, rs] of groups) {
    const size = rs.reduce((n, r) => n + (r.size ?? 0), 0);
    const left = rs.reduce((n, r) => n + (r.sizeleft ?? 0), 0);
    const percent = size > 0 ? Math.round(((size - left) / size) * 1000) / 10 : 0;
    const timeLefts = rs.map((r) => r.timeleft).filter((t): t is string => Boolean(t));
    // "Downloading" wins over post-download states so the row reflects active work.
    const states = rs.map((r) => r.trackedDownloadState ?? r.status ?? "unknown");
    const state = states.includes("downloading") ? "downloading" : (states[0] ?? "unknown");
    const info: DownloadInfo = {
      percent,
      timeLeft: timeLefts.sort(compareTimeLeft).at(-1) ?? null,
      state,
      items: rs.length,
    };
    const seasons = [...new Set(rs.flatMap((r) => (r.seasonNumber !== undefined ? [r.seasonNumber] : [])))];
    if (seasons.length) info.seasons = seasons.sort((a, b) => a - b);
    out.set(id, info);
  }
  return out;
}

/** Compare *arr "[d.]hh:mm:ss" strings by duration. */
function compareTimeLeft(a: string, b: string): number {
  const secs = (t: string) => {
    const [days, rest] = t.includes(".") ? t.split(".", 2) : ["0", t];
    const [h = 0, m = 0, s = 0] = (rest ?? "").split(":").map(Number);
    return Number(days) * 86400 + h * 3600 + m * 60 + s;
  };
  return secs(a) - secs(b);
}
