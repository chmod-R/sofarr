import type { ArrEntry, DownloadInfo } from "./arr.js";
import type { PlexItem, PlexLibrary } from "./plex.js";
import { backdropUrl, type MediaType, posterUrl, type TmdbItem } from "./tmdb.js";

/**
 * - owned:       in the profile's Plex library, playable
 * - downloading: in the Radarr/Sonarr queue (or downloaded, waiting for Plex to pick it up)
 * - requested:   added to Radarr/Sonarr, nothing downloading yet (searching / waiting)
 * - upcoming:    movie without a home (digital/physical) release yet; Get it = grab on release
 * - available:   none of the above; Get it adds and searches now
 */
export type TitleStatus = "owned" | "downloading" | "requested" | "upcoming" | "available";

export interface Title {
  id: string; // `${mediaType}:${tmdbId}`
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  rating: number | null;
  status: TitleStatus;
  /** Plex ratingKey when owned. */
  plexKey?: string;
  /** Queue progress; may accompany `owned` for shows getting new episodes. */
  download?: DownloadInfo;
  /** For `upcoming` (and requested titles that aren't out yet): expected release date (YYYY-MM-DD) if known. */
  availableFrom?: string | null;
  /** In the library and recent: just added, or a show that just got new episodes. */
  fresh?: "new" | "new-episodes";
}

/** How long a library title keeps its "New" / "New episodes" ribbon. */
const FRESH_DAYS = 14;

/** Proxied, resized Plex artwork (the app never sees a Plex token). */
export function plexImageUrl(path: string | null, kind: "poster" | "backdrop" | "still"): string | null {
  if (!path) return null;
  const [w, h] = kind === "poster" ? [342, 513] : kind === "still" ? [300, 169] : [780, 439];
  return `/api/plex/image?path=${encodeURIComponent(path)}&w=${w}&h=${h}`;
}

export interface StatusContext {
  library: PlexLibrary;
  arr: Map<string, ArrEntry>;
  /** For movies not owned or tracked: home release lookup result. */
  release?: Map<number, HomeRelease>;
  today: string; // YYYY-MM-DD
}

export interface HomeRelease {
  date: string | null;
  regionKnown: boolean;
}

/** Movies older than this with no regional home-release data are assumed available. */
const ASSUME_RELEASED_AFTER_DAYS = 120;

/**
 * Is a movie out on digital/physical? `null` date with known region = theatrical only so far.
 */
export function classifyRelease(
  primaryDate: string | null,
  rel: HomeRelease | undefined,
  today: string,
): { released: boolean; availableFrom: string | null } {
  if (rel?.date) return { released: rel.date <= today, availableFrom: rel.date };
  if (!primaryDate) return { released: false, availableFrom: null };
  if (primaryDate > today) return { released: false, availableFrom: null };
  const ageDays = (Date.parse(today) - Date.parse(primaryDate)) / 86_400_000;
  return { released: ageDays > ASSUME_RELEASED_AFTER_DAYS, availableFrom: null };
}

export function resolveStatus(
  mediaType: MediaType,
  tmdbId: number,
  primaryDate: string | null,
  ctx: StatusContext,
): Pick<Title, "status" | "plexKey" | "download" | "availableFrom" | "fresh"> {
  const key = `${mediaType}:${tmdbId}`;
  const plex = ctx.library.byTmdb.get(key);
  const arr = ctx.arr.get(key);
  const out: Pick<Title, "status" | "plexKey" | "download" | "availableFrom" | "fresh"> = {
    status: "available",
  };
  if (arr?.download) out.download = arr.download;

  if (plex) {
    out.status = "owned";
    out.plexKey = plex.ratingKey;
    const cutoff = Date.parse(ctx.today) / 1000 - FRESH_DAYS * 86_400;
    if (plex.addedAt >= cutoff) out.fresh = "new";
    else if (plex.latestAt >= cutoff) out.fresh = "new-episodes";
  } else if (arr?.download || arr?.hasFiles) {
    // hasFiles but not in Plex yet = imported, waiting for a Plex library scan.
    out.status = "downloading";
    out.download ??= { percent: 100, timeLeft: null, state: "waitingForPlex", items: 0 };
  } else if (arr) {
    out.status = "requested";
  } else if (mediaType === "movie") {
    const r = classifyRelease(primaryDate, ctx.release?.get(tmdbId), ctx.today);
    if (!r.released) {
      out.status = "upcoming";
      out.availableFrom = r.availableFrom;
    }
  } else if (primaryDate && primaryDate > ctx.today) {
    out.status = "upcoming";
    out.availableFrom = primaryDate;
  }
  return out;
}

export function fromTmdb(item: TmdbItem, ctx: StatusContext): Title {
  return {
    id: `${item.mediaType}:${item.tmdbId}`,
    mediaType: item.mediaType,
    tmdbId: item.tmdbId,
    title: item.title,
    year: item.year,
    overview: item.overview,
    poster: posterUrl(item.posterPath),
    backdrop: backdropUrl(item.backdropPath),
    rating: item.voteCount > 0 ? Math.round(item.voteAverage * 10) / 10 : null,
    ...resolveStatus(item.mediaType, item.tmdbId, item.date, ctx),
  };
}

export function fromPlex(item: PlexItem, ctx: StatusContext): Title {
  return {
    id: `${item.mediaType}:${item.tmdbId}`,
    mediaType: item.mediaType,
    tmdbId: item.tmdbId,
    title: item.title,
    year: item.year,
    overview: item.summary,
    poster: plexImageUrl(item.thumb, "poster"),
    backdrop: plexImageUrl(item.art, "backdrop"),
    rating: null,
    ...resolveStatus(item.mediaType, item.tmdbId, null, ctx),
  };
}
