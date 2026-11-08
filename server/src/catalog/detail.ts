import type { Arr, ArrEntry } from "./arr.js";
import type { Season as SonarrSeason, SonarrWriter } from "./arrWrite.js";
import type { PlexServer } from "./plex.js";
import { mapSeasons, type SeasonMapping } from "./seasonMap.js";
import { fromTmdb, type StatusContext, type Title } from "./titles.js";
import type { MediaType, Tmdb, TmdbFull } from "./tmdb.js";

export type SeasonStatus = "owned" | "partial" | "downloading" | "requested" | "upcoming" | "available";

export interface SeasonInfo {
  /** The number to request (Sonarr's numbering when Sonarr is configured). */
  number: number;
  /** TMDb's number for the same season when it differs (null if unknown). */
  tmdbNumber: number | null;
  name: string;
  /** 0 when unknown. */
  episodeCount: number;
  airDate: string | null;
  /** true = started airing, false = not yet, null = unknown. */
  aired: boolean | null;
  /** Episodes of this season in the profile's Plex library. */
  inPlex: number;
  /** Of those, how many this profile has watched. */
  watched: number;
  status: SeasonStatus;
}

export interface TitleDetail extends Title {
  tagline: string | null;
  genres: string[];
  runtime: number | null;
  trailerYoutubeKey: string | null;
  seasons?: SeasonInfo[];
  /** How `seasons[].number` relates to TMDb: same, shifted, or Sonarr's numbering only. */
  seasonNumbering?: SeasonMapping["kind"] | "tmdb";
}

export interface DetailDeps {
  plex: PlexServer;
  arr: Arr;
  tmdb: Tmdb;
  sonarr?: SonarrWriter;
  now?: () => Date;
  /** How long the title page waits for Sonarr's numbering before falling back to TMDb's. */
  sonarrBudgetMs?: number;
}

export function seasonStatus(
  s: { number: number; episodeCount: number; aired: boolean | null },
  inPlex: number,
  downloading: Set<number>,
  monitored: Set<number>,
): SeasonStatus {
  if (s.episodeCount > 0 && inPlex >= s.episodeCount) return "owned";
  if (downloading.has(s.number)) return "downloading";
  if (inPlex > 0) return "partial";
  if (monitored.has(s.number)) return "requested";
  if (s.aired === false) return "upcoming";
  return "available";
}

/** Find the *arr entry for a show by TMDb id, or by TVDB id when TMDb splits the show. */
function arrEntryFor(arr: Map<string, ArrEntry>, tmdbId: number, tvdbId: number | null) {
  return (
    arr.get(`tv:${tmdbId}`) ??
    (tvdbId ? [...arr.values()].find((e) => e.mediaType === "tv" && e.tvdbId === tvdbId) : undefined)
  );
}

async function buildSeasons(
  deps: DetailDeps,
  full: TmdbFull,
  today: string,
): Promise<{ seasons: Omit<SeasonInfo, "inPlex" | "watched" | "status">[]; numbering: NonNullable<TitleDetail["seasonNumbering"]> }> {
  const fromTmdbSeason = (s: TmdbFull["seasons"][number], number: number) => ({
    number,
    tmdbNumber: number === s.number ? null : s.number,
    name: number === s.number ? s.name : `Season ${number}`,
    episodeCount: s.episodeCount,
    airDate: s.airDate,
    aired: s.airDate ? s.airDate <= today : false,
  });

  let series: Awaited<ReturnType<SonarrWriter["seriesInfo"]>>;
  if (deps.sonarr) {
    // A slow lookup keeps running (and lands in the cache) after we stop waiting.
    const info = deps.sonarr.seriesInfo(full.tmdbId, full.tvdbId).catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<undefined>((r) => {
      timer = setTimeout(() => r(undefined), deps.sonarrBudgetMs ?? 3000);
    });
    series = await Promise.race([info, budget]);
    clearTimeout(timer);
  }
  if (!series) {
    return { seasons: full.seasons.map((s) => fromTmdbSeason(s, s.number)), numbering: "tmdb" };
  }

  const sonarrSeasons = series.seasons.filter((s) => s.seasonNumber > 0);
  const mapping = mapSeasons(
    { seasons: full.seasons.map((s) => s.number), firstAirDate: full.date, lastAirDate: full.lastAirDate },
    { seasons: sonarrSeasons.map((s) => s.seasonNumber), firstAired: series.firstAired, lastAired: series.lastAired },
  );

  if (mapping.kind === "sonarr-only") {
    const fromSonarr = (s: SonarrSeason) => {
      const st = s.statistics;
      const airDate = st?.previousAiring?.slice(0, 10) ?? null;
      return {
        number: s.seasonNumber,
        tmdbNumber: null,
        name: `Season ${s.seasonNumber}`,
        episodeCount: st?.totalEpisodeCount ?? 0,
        airDate,
        aired: st ? Boolean(st.previousAiring) || (st.nextAiring ? false : null) : null,
      };
    };
    return { seasons: sonarrSeasons.map(fromSonarr), numbering: "sonarr-only" };
  }

  const offset = mapping.kind === "offset" ? mapping.offset : 0;
  const known = new Set(sonarrSeasons.map((s) => s.seasonNumber));
  return {
    seasons: full.seasons.map((s) => fromTmdbSeason(s, s.number + offset)).filter((s) => known.has(s.number)),
    numbering: offset === 0 ? "identity" : "offset",
  };
}

export async function buildDetail(
  deps: DetailDeps,
  serverToken: string,
  mediaType: MediaType,
  tmdbId: number,
): Promise<TitleDetail> {
  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const [full, library, arr] = await Promise.all([
    deps.tmdb.fullDetails(mediaType, tmdbId),
    deps.plex.library(serverToken),
    deps.arr.entries(),
  ]);
  const key = `${mediaType}:${tmdbId}`;
  const ctx: StatusContext = { library, arr, today, release: new Map() };

  if (mediaType === "tv") {
    // A split TMDb entry may be tracked in Sonarr under its sibling's TMDb id.
    const entry = arrEntryFor(arr, tmdbId, full.tvdbId);
    if (entry && !arr.has(key)) ctx.arr = new Map([...arr, [key, entry]]);
  } else if (!library.byTmdb.has(key) && !arr.has(key)) {
    ctx.release!.set(tmdbId, await deps.tmdb.homeRelease(tmdbId));
  }

  const detail: TitleDetail = {
    ...fromTmdb(full, ctx),
    tagline: full.tagline,
    genres: full.genres,
    runtime: full.runtime,
    trailerYoutubeKey: full.trailerYoutubeKey,
  };

  if (mediaType === "tv") {
    const { seasons, numbering } = await buildSeasons(deps, full, today);
    const owned = library.byTmdb.get(key);
    const counts = owned
      ? await deps.plex.seasonCounts(serverToken, owned.ratingKey)
      : new Map<number, { episodes: number; watched: number }>();
    const entry = ctx.arr.get(key);
    const downloading = new Set(entry?.download?.seasons ?? []);
    const monitored = new Set(entry?.monitoredSeasons ?? []);
    detail.seasonNumbering = numbering;
    detail.seasons = seasons.map((s) => {
      const c = counts.get(s.number);
      const inPlex = c?.episodes ?? 0;
      return { ...s, inPlex, watched: c?.watched ?? 0, status: seasonStatus(s, inPlex, downloading, monitored) };
    });
  }
  return detail;
}
