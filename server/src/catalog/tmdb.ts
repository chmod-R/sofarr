import { type FetchFn, requestJson } from "../upstreams/http.js";
import type { TtlCache } from "./cache.js";

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";

const HOUR = 60 * 60 * 1000;

export type MediaType = "movie" | "tv";

/** The subset of TMDb list results Sofarr uses (movie and tv share this after normalising). */
export interface TmdbItem {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year: number | null;
  /** Primary release / first air date (YYYY-MM-DD) */
  date: string | null;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  voteAverage: number;
  voteCount: number;
  adult: boolean;
}

interface RawItem {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  adult?: boolean;
}

interface RawFull extends RawItem {
  tagline?: string;
  genres?: Array<{ name: string }>;
  runtime?: number;
  episode_run_time?: number[];
  last_episode_to_air?: { runtime?: number | null } | null;
  last_air_date?: string | null;
  external_ids?: { tvdb_id?: number | null };
  seasons?: Array<{ season_number: number; name: string; episode_count: number; air_date?: string | null }>;
  videos?: { results: Array<{ site: string; type: string; key: string; official?: boolean }> };
  images?: RawImages;
  credits?: { cast?: Array<{ name: string }> };
  aggregate_credits?: { cast?: Array<{ name: string }> };
  release_dates?: ReleaseDates;
  content_ratings?: { results: Array<{ iso_3166_1: string; rating?: string }> };
}

interface RawImages {
  logos?: Array<{ file_path: string; iso_639_1?: string | null; vote_average?: number }>;
}

export interface TmdbFull extends TmdbItem {
  tagline: string | null;
  genres: string[];
  runtime: number | null;
  trailerYoutubeKey: string | null;
  /** Title logo (transparent artwork of the title's name), when TMDb has one. */
  logo: string | null;
  /** Age rating in the configured region ("PG-13", "TV-MA"), when TMDb knows it. */
  certification: string | null;
  /** The first few billed cast names. */
  cast: string[];
  lastAirDate: string | null;
  tvdbId: number | null;
  seasons: Array<{ number: number; name: string; episodeCount: number; airDate: string | null }>;
}

interface ReleaseDates {
  results: Array<{ iso_3166_1: string; release_dates: Array<{ type: number; release_date: string; certification?: string }> }>;
}

export interface TmdbEpisode {
  number: number;
  title: string;
  airDate: string | null;
  overview: string;
  /** A frame from the episode. */
  still: string | null;
  /** Minutes. */
  runtime: number | null;
}

export function posterUrl(path: string | null, size = "w342"): string | null {
  return path ? `${IMG}/${size}${path}` : null;
}

export function backdropUrl(path: string | null, size = "w780"): string | null {
  return path ? `${IMG}/${size}${path}` : null;
}

/** Logos are transparent PNGs, or SVGs that TMDb only serves at original size. */
export function logoUrl(path: string | null): string | null {
  if (!path) return null;
  return `${IMG}/${path.endsWith(".svg") ? "original" : "w500"}${path}`;
}

/** The best-rated logo in the wanted language, else a language-neutral one, else English. */
export function pickLogo(images: RawImages | undefined, lang: string): string | null {
  const logos = images?.logos ?? [];
  for (const want of [lang, null, "en"]) {
    const best = logos
      .filter((l) => (l.iso_639_1 ?? null) === want)
      .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))[0];
    if (best) return logoUrl(best.file_path);
  }
  return null;
}

function normalise(raw: RawItem, mediaType: MediaType): TmdbItem {
  const date = (mediaType === "movie" ? raw.release_date : raw.first_air_date) || null;
  return {
    mediaType,
    tmdbId: raw.id,
    title: (mediaType === "movie" ? raw.title : raw.name) ?? "",
    year: date ? Number(date.slice(0, 4)) : null,
    date,
    overview: raw.overview ?? "",
    posterPath: raw.poster_path ?? null,
    backdropPath: raw.backdrop_path ?? null,
    voteAverage: raw.vote_average ?? 0,
    voteCount: raw.vote_count ?? 0,
    adult: raw.adult ?? false,
  };
}

export class Tmdb {
  private readonly bearer: boolean;

  constructor(
    private readonly fetch: FetchFn,
    private readonly apiKey: string,
    private readonly cache: TtlCache,
    private readonly opts: { timeoutMs: number; language: string; region: string },
  ) {
    this.bearer = apiKey.startsWith("eyJ");
  }

  /** "en-US" → "en": artwork is tagged by language only. */
  private get imageLanguage(): string {
    return this.opts.language.split("-")[0]!.toLowerCase();
  }

  private get<T>(path: string, params: Record<string, string> = {}, ttlMs = 6 * HOUR): Promise<T> {
    return this.getAs<T, T>(path, params, ttlMs, (raw) => raw);
  }

  /**
   * Like `get`, but caches what `pick` keeps instead of the whole answer: detail
   * responses with cast and image lists are large, and only a few fields are used.
   */
  private getAs<Raw, T>(path: string, params: Record<string, string>, ttlMs: number, pick: (raw: Raw) => T): Promise<T> {
    const u = new URL(`${API}${path}`);
    u.searchParams.set("language", this.opts.language);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const cacheKey = `tmdb:${u.pathname}?${u.searchParams}`;
    if (!this.bearer) u.searchParams.set("api_key", this.apiKey);
    return this.cache.get(cacheKey, ttlMs, async () =>
      pick(
        await requestJson<Raw>(this.fetch, u.toString(), {
          timeoutMs: this.opts.timeoutMs,
          headers: this.bearer ? { Authorization: `Bearer ${this.apiKey}` } : {},
        }),
      ),
    );
  }

  /** Movies and shows matching a query (people are dropped), in TMDb's relevance order. */
  async search(query: string): Promise<TmdbItem[]> {
    const body = await this.get<{ results: Array<RawItem & { media_type?: string }> }>(
      "/search/multi",
      { query, include_adult: "false", page: "1" },
      60 * 60 * 1000,
    );
    return body.results
      .filter((r) => r.media_type === "movie" || r.media_type === "tv")
      .map((r) => normalise(r, r.media_type as MediaType));
  }

  async trending(mediaType: MediaType): Promise<TmdbItem[]> {
    const body = await this.get<{ results: RawItem[] }>(`/trending/${mediaType}/week`);
    return body.results.map((r) => normalise(r, mediaType));
  }

  async recommendations(mediaType: MediaType, tmdbId: number): Promise<TmdbItem[]> {
    const body = await this.get<{ results: RawItem[] }>(`/${mediaType}/${tmdbId}/recommendations`);
    return body.results.map((r) => normalise(r, mediaType));
  }

  /** Everything the title page needs, in one request. */
  fullDetails(mediaType: MediaType, tmdbId: number): Promise<TmdbFull> {
    return this.getAs<RawFull, TmdbFull>(
      `/${mediaType}/${tmdbId}`,
      {
        append_to_response:
          mediaType === "tv"
            ? "videos,images,aggregate_credits,content_ratings,external_ids"
            : "videos,images,credits,release_dates",
        // Without this, appended images are limited to the request language and miss neutral ones.
        include_image_language: `${this.imageLanguage},null`,
      },
      24 * HOUR,
      (raw) => this.toFull(raw, mediaType),
    );
  }

  private toFull(raw: RawFull, mediaType: MediaType): TmdbFull {
    const region = this.opts.region;
    const certification =
      mediaType === "tv"
        ? raw.content_ratings?.results.find((r) => r.iso_3166_1 === region)?.rating
        : raw.release_dates?.results
            .find((r) => r.iso_3166_1 === region)
            ?.release_dates.map((d) => d.certification)
            .find(Boolean);
    const trailer =
      raw.videos?.results.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official) ??
      raw.videos?.results.find((v) => v.site === "YouTube" && v.type === "Trailer") ??
      raw.videos?.results.find((v) => v.site === "YouTube" && v.type === "Teaser");
    return {
      ...normalise(raw, mediaType),
      tagline: raw.tagline || null,
      genres: (raw.genres ?? []).map((g) => g.name),
      runtime: raw.runtime ?? raw.episode_run_time?.[0] ?? (raw.last_episode_to_air?.runtime || null),
      trailerYoutubeKey: trailer?.key ?? null,
      logo: pickLogo(raw.images, this.imageLanguage),
      certification: certification || null,
      cast: ((mediaType === "tv" ? raw.aggregate_credits : raw.credits)?.cast ?? []).slice(0, 4).map((c) => c.name),
      lastAirDate: raw.last_air_date ?? null,
      tvdbId: raw.external_ids?.tvdb_id ?? null,
      seasons: (raw.seasons ?? [])
        .filter((s) => s.season_number > 0)
        .map((s) => ({
          number: s.season_number,
          name: s.name,
          episodeCount: s.episode_count,
          airDate: s.air_date ?? null,
        })),
    };
  }

  async seasonEpisodes(
    tmdbId: number,
    season: number,
  ): Promise<TmdbEpisode[]> {
    const body = await this.get<{
      episodes?: Array<{
        episode_number: number;
        name?: string;
        air_date?: string | null;
        overview?: string;
        still_path?: string | null;
        runtime?: number | null;
      }>;
    }>(`/tv/${tmdbId}/season/${season}`, {}, 6 * HOUR);
    return (body.episodes ?? []).map((e) => ({
      number: e.episode_number,
      title: e.name ?? `Episode ${e.episode_number}`,
      airDate: e.air_date ?? null,
      overview: e.overview ?? "",
      still: e.still_path ? `${IMG}/w300${e.still_path}` : null,
      runtime: e.runtime || null,
    }));
  }

  /** A title's logo on its own: light enough to look up for whatever is in focus. */
  logo(mediaType: MediaType, tmdbId: number): Promise<string | null> {
    return this.getAs<RawImages, string | null>(
      `/${mediaType}/${tmdbId}/images`,
      { include_image_language: `${this.imageLanguage},null` },
      24 * HOUR,
      (raw) => pickLogo(raw, this.imageLanguage),
    );
  }

  async tvdbId(tmdbId: number): Promise<number | null> {
    const body = await this.get<{ tvdb_id?: number | null }>(`/tv/${tmdbId}/external_ids`, {}, 24 * HOUR);
    return body.tvdb_id ?? null;
  }

  async details(mediaType: MediaType, tmdbId: number): Promise<TmdbItem> {
    const raw = await this.get<RawItem>(`/${mediaType}/${tmdbId}`, {}, 24 * HOUR);
    return normalise(raw, mediaType);
  }

  /** Earliest digital (4) or physical (5) release in the configured region, if TMDb knows one. */
  async homeRelease(tmdbId: number): Promise<{ date: string | null; regionKnown: boolean }> {
    const body = await this.get<ReleaseDates>(`/movie/${tmdbId}/release_dates`, {}, 24 * HOUR);
    const region = body.results.find((r) => r.iso_3166_1 === this.opts.region);
    const dates = (region?.release_dates ?? [])
      .filter((d) => d.type === 4 || d.type === 5)
      .map((d) => d.release_date.slice(0, 10))
      .sort();
    return { date: dates[0] ?? null, regionKnown: Boolean(region) };
  }
}
