import { createHash } from "node:crypto";
import { type FetchFn, requestJson } from "../upstreams/http.js";
import type { TtlCache } from "./cache.js";
import type { MediaType } from "./tmdb.js";

/** A Plex library item (movie or show) that maps to a TMDb id. */
export interface PlexItem {
  mediaType: MediaType;
  tmdbId: number;
  ratingKey: string;
  title: string;
  /** Plex's sort title if set, else the title without a leading article, as Plex sorts. */
  sortTitle: string;
  year: number | null;
  /** "YYYY-MM-DD": movie release / show premiere, when Plex knows it. */
  released: string | null;
  summary: string;
  thumb: string | null;
  art: string | null;
  addedAt: number;
  lastViewedAt: number | null;
}

export interface PlexEpisodeState {
  ratingKey: string;
  watched: boolean;
  /** ms into the episode (in progress); 0 if not started. */
  viewOffset: number;
  duration: number;
  /** Plex's own frame from the episode. */
  thumb: string | null;
}

/** A Continue Watching entry. For episodes, `show` points at the parent show. */
export interface PlexResume {
  ratingKey: string;
  type: "movie" | "episode";
  title: string;
  /** Show ratingKey for episodes; same as ratingKey for movies. */
  itemKey: string;
  season: number | null;
  episode: number | null;
  viewOffset: number;
  duration: number;
  /** The episode's (or movie's) synopsis, when Plex has one. */
  summary: string;
  thumb: string | null;
  art: string | null;
}

interface RawMeta {
  ratingKey: string;
  type: string;
  title: string;
  titleSort?: string;
  year?: number;
  originallyAvailableAt?: string;
  summary?: string;
  thumb?: string;
  art?: string;
  addedAt?: number;
  lastViewedAt?: number;
  viewOffset?: number;
  duration?: number;
  grandparentRatingKey?: string;
  grandparentThumb?: string;
  grandparentArt?: string;
  parentIndex?: number;
  index?: number;
  Guid?: Array<{ id: string }>;
}

interface Container<K extends string, T> {
  MediaContainer: { [key in K]?: T[] } & { size?: number };
}

/** "Doctor Who (2005)" → "Doctor Who" when the suffix is just the item's own year. */
export function stripYear(title: string, year: number | undefined): string {
  if (!year) return title;
  const suffix = ` (${year})`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}

/** "The Office" → "Office": Plex sorts without leading English articles. */
export function sortableTitle(title: string): string {
  return title.replace(/^(the|an|a)\s+(?=\S)/i, "");
}

const tmdbIdOf = (m: RawMeta): number | undefined => {
  const g = m.Guid?.find((x) => x.id.startsWith("tmdb://"));
  const n = g ? Number(g.id.slice("tmdb://".length)) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Index of a profile's visible library, keyed by `${mediaType}:${tmdbId}` and by ratingKey. */
export interface PlexLibrary {
  byTmdb: Map<string, PlexItem>;
  byRatingKey: Map<string, PlexItem>;
}

export class PlexServer {
  constructor(
    private readonly fetch: FetchFn,
    private readonly url: string,
    private readonly clientId: string,
    private readonly cache: TtlCache,
    private readonly timeoutMs: number,
  ) {}

  private get<T>(token: string, path: string, ttlMs: number): Promise<T> {
    // Cache per token, but never use the token itself as a key.
    return this.cache.get(`plex:${hashKey(token)}:${path}`, ttlMs, () =>
      requestJson<T>(this.fetch, `${this.url}${path}`, {
        timeoutMs: this.timeoutMs,
        headers: {
          "X-Plex-Token": token,
          "X-Plex-Client-Identifier": this.clientId,
          "X-Plex-Product": "Sofarr",
        },
      }),
    );
  }

  library(token: string): Promise<PlexLibrary> {
    return this.cache.get(`plexlib:${hashKey(token)}`, 60_000, async () => {
      const sections = await this.get<Container<"Directory", { key: string; type: string }>>(
        token,
        "/library/sections",
        60_000,
      );
      const wanted = (sections.MediaContainer.Directory ?? []).filter(
        (d) => d.type === "movie" || d.type === "show",
      );
      const lists = await Promise.all(
        wanted.map(async (d) => {
          const body = await this.get<Container<"Metadata", RawMeta>>(
            token,
            `/library/sections/${d.key}/all?includeGuids=1`,
            60_000,
          );
          const mediaType: MediaType = d.type === "movie" ? "movie" : "tv";
          return (body.MediaContainer.Metadata ?? []).flatMap((m): PlexItem[] => {
            const tmdbId = tmdbIdOf(m);
            if (tmdbId === undefined) return []; // e.g. DVR recordings without a match
            return [
              {
                mediaType,
                tmdbId,
                ratingKey: m.ratingKey,
                title: stripYear(m.title, m.year),
                sortTitle: m.titleSort ?? sortableTitle(stripYear(m.title, m.year)),
                year: m.year ?? null,
                released: m.originallyAvailableAt ?? null,
                summary: m.summary ?? "",
                thumb: m.thumb ?? null,
                art: m.art ?? null,
                addedAt: m.addedAt ?? 0,
                lastViewedAt: m.lastViewedAt ?? null,
              },
            ];
          });
        }),
      );
      const lib: PlexLibrary = { byTmdb: new Map(), byRatingKey: new Map() };
      for (const item of lists.flat()) {
        lib.byTmdb.set(`${item.mediaType}:${item.tmdbId}`, item);
        lib.byRatingKey.set(item.ratingKey, item);
      }
      return lib;
    });
  }

  /** Forget cached Plex responses (after playback changed watch state). */
  invalidate(): void {
    this.cache.invalidate("plex:");
    this.cache.invalidate("plexlib:");
  }

  async continueWatching(token: string, count = 20): Promise<PlexResume[]> {
    const body = await this.get<Container<"Metadata", RawMeta>>(
      token,
      `/hubs/home/continueWatching?count=${count}`,
      30_000,
    );
    return (body.MediaContainer.Metadata ?? []).flatMap((m): PlexResume[] => {
      if (m.type !== "movie" && m.type !== "episode") return [];
      const isEp = m.type === "episode";
      return [
        {
          ratingKey: m.ratingKey,
          type: m.type,
          title: m.title,
          itemKey: isEp ? (m.grandparentRatingKey ?? m.ratingKey) : m.ratingKey,
          season: isEp ? (m.parentIndex ?? null) : null,
          episode: isEp ? (m.index ?? null) : null,
          viewOffset: m.viewOffset ?? 0,
          duration: m.duration ?? 0,
          summary: m.summary ?? "",
          thumb: (isEp ? m.grandparentThumb : m.thumb) ?? m.thumb ?? null,
          art: (isEp ? m.grandparentArt : m.art) ?? m.art ?? null,
        },
      ];
    });
  }

  /** Seasons of a show in the profile's library: season number → episodes present / watched. */
  async seasonCounts(token: string, showKey: string): Promise<Map<number, { episodes: number; watched: number }>> {
    const body = await this.get<Container<"Metadata", { index?: number; leafCount?: number; viewedLeafCount?: number }>>(
      token,
      `/library/metadata/${encodeURIComponent(showKey)}/children`,
      30_000,
    );
    const out = new Map<number, { episodes: number; watched: number }>();
    for (const s of body.MediaContainer.Metadata ?? []) {
      if (s.index !== undefined) out.set(s.index, { episodes: s.leafCount ?? 0, watched: s.viewedLeafCount ?? 0 });
    }
    return out;
  }

  /** Episodes of one season present in the profile's library, by episode number, with watch state. */
  async episodeNumbers(token: string, showKey: string, season: number): Promise<Map<number, PlexEpisodeState>> {
    const seasons = await this.get<Container<"Metadata", { ratingKey: string; index?: number }>>(
      token,
      `/library/metadata/${encodeURIComponent(showKey)}/children`,
      30_000,
    );
    const s = (seasons.MediaContainer.Metadata ?? []).find((x) => x.index === season);
    if (!s) return new Map();
    const eps = await this.get<
      Container<"Metadata", { index?: number; ratingKey: string; viewCount?: number; viewOffset?: number; duration?: number; thumb?: string }>
    >(
      token,
      `/library/metadata/${encodeURIComponent(s.ratingKey)}/children`,
      30_000,
    );
    return new Map(
      (eps.MediaContainer.Metadata ?? []).flatMap((e): Array<[number, PlexEpisodeState]> =>
        e.index !== undefined
          ? [
              [
                e.index,
                {
                  ratingKey: e.ratingKey,
                  watched: (e.viewCount ?? 0) > 0,
                  viewOffset: e.viewOffset ?? 0,
                  duration: e.duration ?? 0,
                  thumb: e.thumb ?? null,
                },
              ],
            ]
          : [],
      ),
    );
  }

  /** Raw image bytes for a Plex artwork path, resized by Plex's photo transcoder. */
  async image(token: string, path: string, width: number, height: number): Promise<Response> {
    const u = new URL(`${this.url}/photo/:/transcode`);
    u.searchParams.set("url", path);
    u.searchParams.set("width", String(width));
    u.searchParams.set("height", String(height));
    u.searchParams.set("minSize", "1");
    u.searchParams.set("upscale", "1");
    return this.fetch(u.toString(), {
      headers: { "X-Plex-Token": token, "X-Plex-Client-Identifier": this.clientId },
      signal: AbortSignal.timeout(this.timeoutMs * 2),
    });
  }
}

function hashKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** Only Plex artwork paths may be proxied (no arbitrary server endpoints). */
export const PLEX_IMAGE_PATH = /^\/library\/metadata\/\d+\/(thumb|art|clearLogo)\/\d+$/;
