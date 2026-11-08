import { UpstreamError } from "../upstreams/http.js";
import type { Arr, ArrEntry } from "./arr.js";
import { mapLimit } from "./cache.js";
import type { PlexLibrary, PlexServer } from "./plex.js";
import { fromTmdb, type HomeRelease, plexImageUrl, type StatusContext, type Title } from "./titles.js";
import type { Tmdb, TmdbItem } from "./tmdb.js";

export interface SearchDeps {
  plex: PlexServer;
  arr: Arr;
  tmdb: Tmdb;
  now?: () => Date;
}

/** Near-empty TMDb entries (no artwork, a handful of votes) go after everything else. */
const isThin = (i: TmdbItem) => !i.posterPath && !i.backdropPath && i.voteCount < 5;

export async function search(deps: SearchDeps, serverToken: string, query: string): Promise<{ results: Title[] }> {
  const soft = <T>(p: Promise<T>, fallback: T) =>
    p.catch((err) => {
      if (err instanceof UpstreamError) return fallback;
      throw err;
    });
  const emptyLib: PlexLibrary = { byTmdb: new Map(), byRatingKey: new Map() };
  const [items, library, arr] = await Promise.all([
    deps.tmdb.search(query),
    soft(deps.plex.library(serverToken), emptyLib),
    soft(deps.arr.entries(), new Map<string, ArrEntry>()),
  ]);
  const ordered = [...items.filter((i) => !i.adult && !isThin(i)), ...items.filter((i) => !i.adult && isThin(i))];

  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const ctx: StatusContext = { library, arr, today, release: new Map() };
  const needRelease = ordered
    .filter((i) => i.mediaType === "movie" && !library.byTmdb.has(`movie:${i.tmdbId}`) && !arr.has(`movie:${i.tmdbId}`))
    .map((i) => i.tmdbId);
  const rel = await mapLimit(needRelease, 8, (id) => soft<HomeRelease | undefined>(deps.tmdb.homeRelease(id), undefined));
  needRelease.forEach((id, n) => rel[n] && ctx.release!.set(id, rel[n]!));

  return {
    results: ordered.map((i) => {
      const t = fromTmdb(i, ctx);
      // TMDb has no artwork for some entries; Plex does for anything in the library.
      const lib = library.byTmdb.get(t.id);
      if (lib && !t.backdrop) t.backdrop = plexImageUrl(lib.art, "backdrop") ?? plexImageUrl(lib.thumb, "backdrop");
      if (lib && !t.poster) t.poster = plexImageUrl(lib.thumb, "poster");
      return t;
    }),
  };
}
