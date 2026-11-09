import { UpstreamError } from "../upstreams/http.js";
import type { Arr, ArrEntry } from "./arr.js";
import { mapLimit } from "./cache.js";
import type { PlexItem, PlexLibrary, PlexServer } from "./plex.js";
import { fromPlex, fromTmdb, type HomeRelease, plexImageUrl, type StatusContext, type Title } from "./titles.js";
import type { Tmdb, TmdbItem } from "./tmdb.js";

export interface ResumeInfo {
  /** ratingKey of the movie/episode to play. */
  plexKey: string;
  /** "S2 · E8 · My Rom-Com" for episodes; null for movies. */
  label: string | null;
  percent: number;
}

export type RowItem = Title & {
  resume?: ResumeInfo;
  /** My Library only: "YYYY-MM-DD" release / premiere date, for sorting. */
  released?: string | null;
};

export interface Row {
  id: string;
  title: string;
  items: RowItem[];
}

export interface HomeDeps {
  plex: PlexServer;
  arr: Arr;
  tmdb?: Tmdb;
  now?: () => Date;
}

export interface HomeResult {
  rows: Row[];
  /** Sources that failed; their rows are missing but the rest still render. */
  warnings: string[];
}

const ROW_MAX = 20;
/** Recommendations below this bar are mostly noise (see DESIGN.md). */
const MIN_VOTES = 100;
const MIN_RATING = 6.0;
const SEED_ROWS = 3;

/** Await an upstream call; on an upstream failure, note it in `warnings` and use the fallback. */
function softFail(warnings: string[]) {
  return async <T>(source: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      warnings.push(`${source}: ${err.message}`);
      return fallback;
    }
  };
}

const emptyLibrary = (): PlexLibrary => ({ byTmdb: new Map(), byRatingKey: new Map() });

const goodRec = (i: TmdbItem) => !i.adult && i.voteCount >= MIN_VOTES && i.voteAverage >= MIN_RATING;

export async function buildHome(deps: HomeDeps, serverToken: string): Promise<HomeResult> {
  const warnings: string[] = [];
  const soft = softFail(warnings);

  const [library, arr, resume] = await Promise.all([
    soft("plex", deps.plex.library(serverToken), emptyLibrary()),
    soft("radarr/sonarr", deps.arr.entries(), new Map<string, ArrEntry>()),
    soft("plex", deps.plex.continueWatching(serverToken), []),
  ]);

  // Seeds for "Because you watched": most recently watched movies/shows.
  const seeds = [...library.byTmdb.values()]
    .filter((i) => i.lastViewedAt)
    .sort((a, b) => b.lastViewedAt! - a.lastViewedAt!)
    .slice(0, SEED_ROWS);

  let trendingMovies: TmdbItem[] = [];
  let trendingTv: TmdbItem[] = [];
  let recs: Array<{ seed: PlexItem; items: TmdbItem[] }> = [];
  if (deps.tmdb) {
    const tmdb = deps.tmdb;
    [trendingMovies, trendingTv, recs] = await Promise.all([
      soft("tmdb", tmdb.trending("movie"), []),
      soft("tmdb", tmdb.trending("tv"), []),
      Promise.all(
        seeds.map(async (seed) => ({
          seed,
          items: (await soft("tmdb", tmdb.recommendations(seed.mediaType, seed.tmdbId), []))
            .filter(goodRec)
            .filter((i) => !(i.mediaType === seed.mediaType && i.tmdbId === seed.tmdbId)),
        })),
      ),
    ]);
  } else {
    warnings.push("tmdb: not configured (trending and recommendations unavailable)");
  }

  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const ctx: StatusContext = { library, arr, today, release: new Map() };

  // Home-release lookups only for movies we'd otherwise offer to get.
  if (deps.tmdb) {
    const tmdb = deps.tmdb;
    const needs = new Set<number>();
    for (const i of [...trendingMovies, ...recs.flatMap((r) => r.items)]) {
      if (i.mediaType !== "movie") continue;
      const k = `movie:${i.tmdbId}`;
      if (!library.byTmdb.has(k) && !arr.has(k)) needs.add(i.tmdbId);
    }
    const ids = [...needs];
    const results = await mapLimit(ids, 8, (id) =>
      soft<HomeRelease | undefined>("tmdb", tmdb.homeRelease(id), undefined),
    );
    ids.forEach((id, n) => {
      const r = results[n];
      if (r) ctx.release!.set(id, r);
    });
  }

  const rows: Row[] = [];
  const push = (id: string, title: string, items: RowItem[]) => {
    if (items.length) rows.push({ id, title, items: items.slice(0, ROW_MAX) });
  };

  // Continue Watching
  push(
    "continue",
    "Continue Watching",
    resume.flatMap((r): RowItem[] => {
      const item = library.byRatingKey.get(r.itemKey);
      if (!item) return [];
      const base = fromPlex(item, ctx);
      const label =
        r.type === "episode"
          ? [r.season != null && `S${r.season}`, r.episode != null && `E${r.episode}`, r.title]
              .filter(Boolean)
              .join(" · ")
          : null;
      return [
        {
          ...base,
          // The episode being resumed says more than the show's synopsis.
          overview: r.summary || base.overview,
          backdrop: plexImageUrl(r.art, "backdrop") ?? base.backdrop,
          resume: {
            plexKey: r.ratingKey,
            label,
            percent: r.duration > 0 ? Math.round((r.viewOffset / r.duration) * 100) : 0,
          },
        },
      ];
    }),
  );

  // Downloading now (TMDb artwork via Plex when owned; otherwise just the TMDb-less title from arr)
  const downloading: RowItem[] = [];
  for (const [key, e] of arr) {
    if (!e.download) continue;
    const owned = library.byTmdb.get(key);
    if (owned) {
      downloading.push(fromPlex(owned, ctx));
    } else if (deps.tmdb) {
      // Not in Plex yet: look the title up for artwork (cached, cheap).
      const t = await soft("tmdb", deps.tmdb.details(e.mediaType, e.tmdbId), undefined);
      if (t) downloading.push(fromTmdb(t, ctx));
    }
  }
  push("downloading", "Downloading Now", downloading);

  const [r0, r1, r2] = recs;
  const recRow = (r: (typeof recs)[number] | undefined, n: number) => {
    if (r) push(`because-${n}`, `Because you watched ${r.seed.title}`, r.items.map((i) => fromTmdb(i, ctx)));
  };

  recRow(r0, 0);
  push("trending-movies", "Trending Movies", trendingMovies.map((i) => fromTmdb(i, ctx)));
  recRow(r1, 1);
  push("trending-tv", "Trending TV", trendingTv.map((i) => fromTmdb(i, ctx)));
  push(
    "recently-added",
    "Recently Added",
    [...library.byTmdb.values()]
      .sort((a, b) => b.addedAt - a.addedAt)
      .slice(0, ROW_MAX)
      .map((i) => fromPlex(i, ctx)),
  );
  recRow(r2, 2);

  return { rows, warnings: [...new Set(warnings)] };
}

/** Library order: by Plex's sort title (which drops "The", "A"…), then year. */
export function byLibraryOrder(a: PlexItem, b: PlexItem): number {
  return a.sortTitle.localeCompare(b.sortTitle, undefined, { sensitivity: "base", numeric: true }) || (a.year ?? 0) - (b.year ?? 0);
}

/**
 * "My Library": everything in the profile's Plex library, one section per media type,
 * in title order (the UI re-sorts by `released` on request). No ROW_MAX: it's a
 * browse of everything you have.
 */
export async function buildLibrary(deps: Pick<HomeDeps, "plex" | "arr" | "now">, serverToken: string): Promise<HomeResult> {
  const warnings: string[] = [];
  const soft = softFail(warnings);
  const [library, arr] = await Promise.all([
    soft("plex", deps.plex.library(serverToken), emptyLibrary()),
    // Only for "downloading" on shows getting new episodes; optional.
    soft("radarr/sonarr", deps.arr.entries(), new Map<string, ArrEntry>()),
  ]);
  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const ctx: StatusContext = { library, arr, today, release: new Map() };
  const items = [...library.byTmdb.values()].sort(byLibraryOrder);
  const rows: Row[] = [];
  for (const [id, title, type] of [
    ["library-tv", "TV Shows", "tv"],
    ["library-movies", "Movies", "movie"],
  ] as const) {
    const list = items
      .filter((i) => i.mediaType === type)
      .map((i): RowItem => ({ ...fromPlex(i, ctx), released: i.released }));
    if (list.length) rows.push({ id, title, items: list });
  }
  return { rows, warnings: [...new Set(warnings)] };
}
