import { UpstreamError } from "../upstreams/http.js";
import type { SonarrWriter } from "./arrWrite.js";
import type { PlexEpisodeState, PlexServer } from "./plex.js";
import { mapSeasons } from "./seasonMap.js";
import { plexImageUrl } from "./titles.js";
import type { Tmdb, TmdbEpisode } from "./tmdb.js";

export type EpisodeStatus = "owned" | "downloading" | "requested" | "upcoming" | "available";

export interface EpisodeInfo {
  number: number;
  title: string;
  airDate: string | null;
  overview: string;
  /** A frame from the episode (TMDb's, else Plex's own when it's in the library). */
  still: string | null;
  /** Minutes, when known. */
  runtime: number | null;
  status: EpisodeStatus;
  /** Plex ratingKey when the episode is in the profile's library (playable). */
  plexKey?: string;
  /** This profile has watched it (Plex). */
  watched?: boolean;
  /** Started but not finished. */
  progress?: { percent: number; remainingMs: number };
}

export interface SeasonEpisodes {
  /** The season, in the numbering the caller asked for. */
  season: number;
  numbering: "sonarr" | "tmdb";
  episodes: EpisodeInfo[];
}

export interface EpisodeDeps {
  plex: PlexServer;
  tmdb: Tmdb;
  sonarr?: SonarrWriter;
  now?: () => Date;
}

export function episodeStatus(
  e: { airDate: string | null },
  flags: { inPlex: boolean; hasFile: boolean; queued: boolean; monitored: boolean },
  today: string,
): EpisodeStatus {
  if (flags.inPlex || flags.hasFile) return "owned";
  if (flags.queued) return "downloading";
  if (flags.monitored) return "requested";
  if (!e.airDate || e.airDate > today) return "upcoming";
  return "available";
}

/**
 * Episodes of one season. `numbering` says which numbering `season` uses
 * (the title page's `seasonNumbering`: Sonarr's, or TMDb's as a fallback).
 */
export async function buildEpisodes(
  deps: EpisodeDeps,
  serverToken: string,
  plexShowKey: string | undefined,
  tmdbId: number,
  season: number,
  numbering: "sonarr" | "tmdb",
): Promise<SeasonEpisodes> {
  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const full = await deps.tmdb.fullDetails("tv", tmdbId);

  // Work out both numbers for this season.
  let sonarrSeason: number | undefined = numbering === "sonarr" ? season : undefined;
  let tmdbSeason: number | undefined = numbering === "tmdb" ? season : undefined;
  const series = deps.sonarr ? await deps.sonarr.seriesInfo(tmdbId, full.tvdbId) : undefined;
  if (series) {
    const m = mapSeasons(
      { seasons: full.seasons.map((s) => s.number), firstAirDate: full.date, lastAirDate: full.lastAirDate },
      { seasons: series.seasons.map((s) => s.seasonNumber), firstAired: series.firstAired, lastAired: series.lastAired },
    );
    const offset = m.kind === "offset" ? m.offset : m.kind === "identity" ? 0 : undefined;
    if (offset !== undefined) {
      sonarrSeason ??= season + offset;
      tmdbSeason ??= season - offset;
    }
  }
  // Plex files follow Sonarr's naming, so its season numbers match Sonarr's.
  const plexSeason = sonarrSeason ?? season;
  const inPlex = plexShowKey
    ? await deps.plex
        .episodeNumbers(serverToken, plexShowKey, plexSeason)
        .catch(() => new Map<number, PlexEpisodeState>())
    : new Map<number, PlexEpisodeState>();
  const withKey = <T extends { number: number; still: string | null; runtime: number | null }>(e: T): T & Pick<EpisodeInfo, "plexKey" | "watched" | "progress"> => {
    const p = inPlex.get(e.number);
    if (!p) return e;
    const out: T & Pick<EpisodeInfo, "plexKey" | "watched" | "progress"> = { ...e, plexKey: p.ratingKey, watched: p.watched };
    out.still ??= plexImageUrl(p.thumb, "still");
    out.runtime ??= p.duration > 0 ? Math.round(p.duration / 60_000) : null;
    if (p.viewOffset > 0 && p.duration > 0) {
      out.progress = {
        percent: Math.min(99, Math.round((p.viewOffset / p.duration) * 100)),
        remainingMs: Math.max(0, p.duration - p.viewOffset),
      };
    }
    return out;
  };

  // Prefer Sonarr's episode list when it already tracks the show.
  const existing = deps.sonarr && series?.id !== undefined ? series : undefined;
  if (existing && sonarrSeason !== undefined && deps.sonarr) {
    const [eps, queued] = await Promise.all([
      deps.sonarr.episodes(existing.id!, sonarrSeason),
      deps.sonarr.queuedEpisodeIds(existing.id!),
    ]);
    if (eps.length) {
      // Sonarr's list has no artwork: take stills (and missing runtimes) from TMDb's matching season.
      const art = new Map<number, TmdbEpisode>();
      if (tmdbSeason !== undefined) {
        const list = await deps.tmdb.seasonEpisodes(tmdbId, tmdbSeason).catch(() => []);
        for (const e of list) art.set(e.number, e);
      }
      return {
        season,
        numbering,
        episodes: eps
          .filter((e) => e.episodeNumber > 0)
          .sort((a, b) => a.episodeNumber - b.episodeNumber)
          .map((e) => {
            const airDate = e.airDate ?? null;
            return withKey({
              number: e.episodeNumber,
              title: e.title ?? `Episode ${e.episodeNumber}`,
              airDate,
              overview: e.overview ?? "",
              still: art.get(e.episodeNumber)?.still ?? null,
              runtime: e.runtime || art.get(e.episodeNumber)?.runtime || null,
              status: episodeStatus(
                { airDate },
                { inPlex: inPlex.has(e.episodeNumber), hasFile: e.hasFile, queued: queued.has(e.id), monitored: e.monitored },
                today,
              ),
            });
          }),
      };
    }
  }

  if (tmdbSeason === undefined) {
    throw new UpstreamError("can't match this season to TMDb's episode list");
  }
  const eps = await deps.tmdb.seasonEpisodes(tmdbId, tmdbSeason);
  return {
    season,
    numbering,
    episodes: eps.map((e) =>
      withKey({
        ...e,
        status: episodeStatus(e, { inPlex: inPlex.has(e.number), hasFile: false, queued: false, monitored: false }, today),
      }),
    ),
  };
}
