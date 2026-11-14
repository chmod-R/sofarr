import type { ArrConfig } from "../config.js";
import { type FetchFn, requestJson, UpstreamError } from "../upstreams/http.js";
import type { TtlCache } from "./cache.js";

/**
 * Writes to Radarr/Sonarr ("Get it"). Add-series follows the approach used by
 * Overseerr/Jellyseerr: send per-season `monitored` flags with no `monitor`
 * type, so Sonarr monitors exactly the chosen seasons.
 */

interface Profile {
  id: number;
  name: string;
}
interface RootFolder {
  id: number;
  path: string;
}

export interface ArrDefaults {
  qualityProfileId: number;
  rootFolderPath: string;
}

export interface MovieDefaults extends ArrDefaults {
  minimumAvailability: string;
}

export interface SeriesDefaults extends ArrDefaults {
  seasonFolder: boolean;
  seriesType: string;
}

/** Explicit overrides from config (name or numeric id for profiles). */
export interface ArrOverrides {
  qualityProfile?: string;
  rootFolder?: string;
}

export interface Season {
  seasonNumber: number;
  monitored: boolean;
  statistics?: {
    episodeFileCount?: number;
    episodeCount?: number;
    totalEpisodeCount?: number;
    previousAiring?: string;
    nextAiring?: string;
  };
}

export interface RadarrMovie {
  id?: number;
  title: string;
  tmdbId: number;
  year: number;
  titleSlug: string;
  images: unknown[];
  monitored: boolean;
  hasFile?: boolean;
  qualityProfileId?: number;
  rootFolderPath?: string;
  minimumAvailability?: string;
  [k: string]: unknown;
}

export interface SonarrSeries {
  id?: number;
  title: string;
  tvdbId: number;
  tmdbId?: number;
  year: number;
  titleSlug: string;
  images: unknown[];
  seasons: Season[];
  monitored: boolean;
  firstAired?: string;
  lastAired?: string;
  monitorNewItems?: string;
  qualityProfileId?: number;
  rootFolderPath?: string;
  seasonFolder?: boolean;
  seriesType?: string;
  [k: string]: unknown;
}

export const LOOKUP_TIMEOUT_MS = 30_000;
/** After an add times out: how long to keep checking whether *arr added it anyway. */
export const ADD_SETTLE_MS = 30_000;
const ADD_POLL_MS = 2_000;

const mostCommon = <T>(xs: T[]): T | undefined => {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

export class ArrClient {
  constructor(
    private readonly fetch: FetchFn,
    private readonly cfg: ArrConfig,
    private readonly cache: TtlCache,
    private readonly timeoutMs: number,
  ) {}

  call<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    return requestJson<T>(this.fetch, `${this.cfg.url}${path}`, {
      timeoutMs,
      method,
      headers: {
        "X-Api-Key": this.cfg.apiKey,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  /**
   * Metadata lookups go through *arr to its online metadata service (often via
   * a VPN): 10+ s is not unusual. Long timeout, cached for a day.
   */
  lookup<T>(path: string): Promise<T> {
    return this.cache.get(`arrlookup:${this.cfg.url}${path}`, 24 * 60 * 60_000, () =>
      this.call<T>("GET", path, undefined, LOOKUP_TIMEOUT_MS),
    );
  }

  /**
   * Add a movie or series. *arr fetches its metadata online (often via a VPN) before
   * answering, so this gets the lookup timeout. If even that runs out, *arr usually
   * still finishes the add: look for the new item a little longer before giving up,
   * rather than report a failure for something that worked.
   */
  async add<T>(path: string, body: unknown, find: () => Promise<T | undefined>): Promise<T> {
    try {
      return await this.call<T>("POST", path, body, LOOKUP_TIMEOUT_MS);
    } catch (err) {
      if (!(err instanceof UpstreamError) || err.status !== undefined || !err.message.startsWith("timed out")) throw err;
      for (let waited = 0; waited < ADD_SETTLE_MS; waited += ADD_POLL_MS) {
        await new Promise((r) => setTimeout(r, ADD_POLL_MS));
        const found = await find().catch(() => undefined);
        if (found) return found;
      }
      throw err;
    }
  }

  /** Cached 10 min: profile list, root folders, and existing items to learn defaults from. */
  private meta<T>(path: string): Promise<T> {
    return this.cache.get(`arrmeta:${this.cfg.url}${path}`, 10 * 60_000, () => this.call<T>("GET", path));
  }

  /**
   * Resolve quality profile + root folder: explicit override, else what most of
   * the existing library uses, else the first available.
   */
  async baseDefaults(
    existing: Array<{ qualityProfileId?: number; rootFolderPath?: string }>,
    o: ArrOverrides,
  ): Promise<ArrDefaults> {
    const [profiles, roots] = await Promise.all([
      this.meta<Profile[]>("/api/v3/qualityprofile"),
      this.meta<RootFolder[]>("/api/v3/rootfolder"),
    ]);

    let profile: Profile | undefined;
    if (o.qualityProfile) {
      profile = profiles.find(
        (p) => String(p.id) === o.qualityProfile || p.name.toLowerCase() === o.qualityProfile!.toLowerCase(),
      );
      if (!profile) throw new UpstreamError(`quality profile "${o.qualityProfile}" not found`);
    } else {
      const used = mostCommon(existing.map((e) => e.qualityProfileId).filter((x) => x !== undefined));
      profile = profiles.find((p) => p.id === used) ?? profiles[0];
    }
    if (!profile) throw new UpstreamError("no quality profiles configured");

    let root: string | undefined;
    if (o.rootFolder) {
      root = roots.find((r) => r.path.replace(/\/+$/, "") === o.rootFolder!.replace(/\/+$/, ""))?.path;
      if (!root) throw new UpstreamError(`root folder "${o.rootFolder}" not found`);
    } else {
      const used = mostCommon(existing.map((e) => e.rootFolderPath).filter((x) => x !== undefined));
      root = roots.find((r) => r.path === used)?.path ?? roots[0]?.path;
    }
    if (!root) throw new UpstreamError("no root folders configured");

    return { qualityProfileId: profile.id, rootFolderPath: root };
  }
}

export class RadarrWriter {
  constructor(
    private readonly client: ArrClient,
    private readonly overrides: ArrOverrides,
  ) {}

  async defaults(): Promise<MovieDefaults> {
    const existing = await this.client.call<RadarrMovie[]>("GET", "/api/v3/movie");
    const base = await this.client.baseDefaults(existing, this.overrides);
    return {
      ...base,
      minimumAvailability:
        mostCommon(existing.flatMap((m) => (m.minimumAvailability ? [m.minimumAvailability] : []))) ??
        "released",
    };
  }

  /**
   * Add (or re-enable) a movie and search for it.
   * Returns "added" | "searching" | "already_have".
   */
  async request(tmdbId: number): Promise<{ result: "added" | "searching" | "already_have"; arrId: number }> {
    const existing = (await this.client.call<RadarrMovie[]>("GET", `/api/v3/movie?tmdbId=${tmdbId}`))[0];
    if (existing?.id !== undefined) {
      if (existing.hasFile) return { result: "already_have", arrId: existing.id };
      if (!existing.monitored) {
        await this.client.call("PUT", `/api/v3/movie/${existing.id}`, { ...existing, monitored: true });
      }
      await this.client.call("POST", "/api/v3/command", { name: "MoviesSearch", movieIds: [existing.id] });
      return { result: "searching", arrId: existing.id };
    }

    const found = await this.client.lookup<RadarrMovie>(`/api/v3/movie/lookup/tmdb?tmdbId=${tmdbId}`);
    if (!found?.tmdbId) throw new UpstreamError("Radarr couldn't find that movie");
    const d = await this.defaults();
    const added = await this.client.add<RadarrMovie>("/api/v3/movie", {
      title: found.title,
      tmdbId: found.tmdbId,
      year: found.year,
      titleSlug: found.titleSlug,
      images: found.images,
      qualityProfileId: d.qualityProfileId,
      rootFolderPath: d.rootFolderPath,
      minimumAvailability: d.minimumAvailability,
      monitored: true,
      addOptions: { monitor: "movieOnly", searchForMovie: true },
    }, async () => (await this.client.call<RadarrMovie[]>("GET", `/api/v3/movie?tmdbId=${tmdbId}`))[0]);
    return { result: "added", arrId: added.id! };
  }
}

export interface SonarrEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  airDate?: string;
  overview?: string;
  /** Minutes; 0 when Sonarr doesn't know. */
  runtime?: number;
  monitored: boolean;
  hasFile: boolean;
}

/** How long to wait for Sonarr to load a newly added show's episodes. */
export const EPISODES_READY_TIMEOUT_MS = 90_000;

export class SonarrWriter {
  constructor(
    private readonly client: ArrClient,
    private readonly overrides: ArrOverrides,
  ) {}

  async defaults(): Promise<SeriesDefaults> {
    const existing = await this.client.call<SonarrSeries[]>("GET", "/api/v3/series");
    const base = await this.client.baseDefaults(existing, this.overrides);
    return {
      ...base,
      seasonFolder: mostCommon(existing.map((s) => s.seasonFolder ?? true)) ?? true,
      seriesType: mostCommon(existing.flatMap((s) => (s.seriesType ? [s.seriesType] : []))) ?? "standard",
    };
  }

  /**
   * Monitor and search the chosen seasons (adding the series if needed).
   * New future seasons are monitored only if the latest season was chosen.
   */
  /** Sonarr's lookup by TMDb id, falling back to TVDB id (TMDb sometimes splits a show). */
  private async lookup(tmdbId: number, tvdbId?: number | null): Promise<SonarrSeries | undefined> {
    const byTmdb = await this.client.lookup<SonarrSeries[]>(`/api/v3/series/lookup?term=tmdb:${tmdbId}`);
    if (byTmdb[0]?.tvdbId) return byTmdb[0];
    if (!tvdbId) return undefined;
    const byTvdb = await this.client.lookup<SonarrSeries[]>(`/api/v3/series/lookup?term=tvdb:${tvdbId}`);
    return byTvdb[0]?.tvdbId ? byTvdb[0] : undefined;
  }

  private findExisting(all: SonarrSeries[], tmdbId: number, tvdbId?: number | null) {
    return all.find((s) => s.tmdbId === tmdbId) ?? (tvdbId ? all.find((s) => s.tvdbId === tvdbId) : undefined);
  }

  /** The existing Sonarr series for a show, if any. */
  async existing(tmdbId: number, tvdbId?: number | null): Promise<SonarrSeries | undefined> {
    const all = await this.client.call<SonarrSeries[]>("GET", "/api/v3/series");
    return this.findExisting(all, tmdbId, tvdbId);
  }

  episodes(seriesId: number, season?: number): Promise<SonarrEpisode[]> {
    const q = season === undefined ? "" : `&seasonNumber=${season}`;
    return this.client.call<SonarrEpisode[]>("GET", `/api/v3/episode?seriesId=${seriesId}${q}`);
  }

  /** Episode ids currently in Sonarr's download queue for a series. */
  async queuedEpisodeIds(seriesId: number): Promise<Set<number>> {
    const q = await this.client.call<{ records: Array<{ seriesId?: number; episodeId?: number }> }>(
      "GET",
      `/api/v3/queue?pageSize=500&seriesIds=${seriesId}`,
    );
    return new Set(q.records.flatMap((r) => (r.seriesId === seriesId && r.episodeId ? [r.episodeId] : [])));
  }

  /**
   * Monitor and search specific episodes of one season (adding the series,
   * with nothing else monitored, if needed). Episode searches look for
   * single-episode releases, so each one arrives as soon as it's done.
   */
  async requestEpisodes(
    tmdbId: number,
    season: number,
    episodeNumbers: number[],
    tvdbId?: number | null,
    opts: { pollMs?: number; readyTimeoutMs?: number } = {},
  ): Promise<{ result: "added" | "searching" | "already_have"; arrId: number; episodes: number[] }> {
    let series = await this.existing(tmdbId, tvdbId);
    let result: "added" | "searching" = "searching";

    if (!series) {
      const found = await this.lookup(tmdbId, tvdbId);
      if (!found) throw new UpstreamError("Sonarr couldn't find that series");
      if (!found.seasons.some((s) => s.seasonNumber === season)) {
        throw new UpstreamError(`Sonarr doesn't know season ${season}`);
      }
      const d = await this.defaults();
      series = await this.client.add<SonarrSeries>("/api/v3/series", {
        title: found.title,
        tvdbId: found.tvdbId,
        ...(found.tmdbId && { tmdbId: found.tmdbId }),
        year: found.year,
        titleSlug: found.titleSlug,
        images: found.images,
        qualityProfileId: d.qualityProfileId,
        rootFolderPath: d.rootFolderPath,
        seasonFolder: d.seasonFolder,
        seriesType: d.seriesType,
        monitored: true,
        monitorNewItems: "none",
        seasons: found.seasons.map((s) => ({ seasonNumber: s.seasonNumber, monitored: false })),
        addOptions: { monitor: "none", searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false },
      }, async () => (await this.client.call<SonarrSeries[]>("GET", `/api/v3/series?tvdbId=${found.tvdbId}`))[0]);
      result = "added";
    }
    const seriesId = series.id!;

    // A just-added series has no episodes until Sonarr's refresh finishes.
    const deadline = Date.now() + (opts.readyTimeoutMs ?? EPISODES_READY_TIMEOUT_MS);
    let eps = await this.episodes(seriesId, season);
    while (eps.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 2000));
      eps = await this.episodes(seriesId, season);
    }
    const wanted = eps.filter((e) => episodeNumbers.includes(e.episodeNumber));
    const missing = episodeNumbers.filter((n) => !wanted.some((e) => e.episodeNumber === n));
    if (missing.length) {
      throw new UpstreamError(
        eps.length === 0
          ? "Sonarr is still loading this show's episodes; try again in a minute"
          : `Sonarr doesn't know episode(s) ${missing.join(", ")} of season ${season}`,
      );
    }

    const todo = wanted.filter((e) => !e.hasFile);
    if (todo.length === 0) return { result: "already_have", arrId: seriesId, episodes: [] };
    if (!series.monitored) {
      await this.client.call("PUT", `/api/v3/series/${seriesId}`, { ...series, monitored: true });
    }
    await this.client.call("PUT", "/api/v3/episode/monitor", {
      episodeIds: todo.map((e) => e.id),
      monitored: true,
    });
    await this.client.call("POST", "/api/v3/command", { name: "EpisodeSearch", episodeIds: todo.map((e) => e.id) });
    return { result, arrId: seriesId, episodes: todo.map((e) => e.episodeNumber).sort((a, b) => a - b) };
  }

  /** The series as Sonarr numbers it: existing entry, else lookup. Undefined if Sonarr can't find it. */
  async seriesInfo(tmdbId: number, tvdbId?: number | null): Promise<SonarrSeries | undefined> {
    const all = await this.client.call<SonarrSeries[]>("GET", "/api/v3/series");
    return this.findExisting(all, tmdbId, tvdbId) ?? (await this.lookup(tmdbId, tvdbId));
  }

  async request(
    tmdbId: number,
    seasons: number[],
    tvdbId?: number | null,
  ): Promise<{ result: "added" | "searching" | "already_have"; arrId: number; seasons: number[] }> {
    const wanted = new Set(seasons);
    const all = await this.client.call<SonarrSeries[]>("GET", "/api/v3/series");
    const existing = this.findExisting(all, tmdbId, tvdbId);

    if (existing?.id !== undefined) {
      const latest = Math.max(0, ...existing.seasons.map((s) => s.seasonNumber));
      const toAdd = existing.seasons.filter((s) => wanted.has(s.seasonNumber) && !s.monitored);
      const complete = existing.seasons.filter(
        (s) =>
          wanted.has(s.seasonNumber) &&
          s.monitored &&
          (s.statistics?.episodeFileCount ?? 0) >= (s.statistics?.episodeCount ?? Infinity),
      );
      if (toAdd.length === 0 && complete.length === wanted.size) {
        return { result: "already_have", arrId: existing.id, seasons: [] };
      }
      const updated: SonarrSeries = {
        ...existing,
        monitored: true,
        seasons: existing.seasons.map((s) => (wanted.has(s.seasonNumber) ? { ...s, monitored: true } : s)),
      };
      if (wanted.has(latest)) updated.monitorNewItems = "all";
      await this.client.call("PUT", `/api/v3/series/${existing.id}`, updated);
      await this.client.call("POST", "/api/v3/command", { name: "SeriesSearch", seriesId: existing.id });
      return { result: "searching", arrId: existing.id, seasons: [...wanted].sort((a, b) => a - b) };
    }

    const found = await this.lookup(tmdbId, tvdbId);
    if (!found) throw new UpstreamError("Sonarr couldn't find that series");
    const unknown = [...wanted].filter((n) => !found.seasons.some((s) => s.seasonNumber === n));
    if (unknown.length) throw new UpstreamError(`Sonarr doesn't know season(s) ${unknown.join(", ")}`);

    const latest = Math.max(0, ...found.seasons.map((s) => s.seasonNumber));
    const d = await this.defaults();
    const added = await this.client.add<SonarrSeries>("/api/v3/series", {
      title: found.title,
      tvdbId: found.tvdbId,
      ...(found.tmdbId && { tmdbId: found.tmdbId }),
      year: found.year,
      titleSlug: found.titleSlug,
      images: found.images,
      qualityProfileId: d.qualityProfileId,
      rootFolderPath: d.rootFolderPath,
      seasonFolder: d.seasonFolder,
      seriesType: d.seriesType,
      monitored: true,
      monitorNewItems: wanted.has(latest) ? "all" : "none",
      seasons: found.seasons.map((s) => ({ seasonNumber: s.seasonNumber, monitored: wanted.has(s.seasonNumber) })),
      addOptions: { ignoreEpisodesWithFiles: true, searchForMissingEpisodes: true },
    }, async () => (await this.client.call<SonarrSeries[]>("GET", `/api/v3/series?tvdbId=${found.tvdbId}`))[0]);
    return { result: "added", arrId: added.id!, seasons: [...wanted].sort((a, b) => a - b) };
  }
}
