/**
 * TMDb and Sonarr (TVDB) don't always number a show's seasons the same way.
 * Example: The Great British Bake Off is one show with seasons 1–17 on TVDB,
 * but two TMDb entries: 34549 (2010–2016, seasons 1–7) and 87012 (2017–,
 * seasons 1–10). Requests go to Sonarr, so Sonarr's numbers are authoritative;
 * TMDb only supplies names, episode counts and air dates when we can align it.
 */

export interface TmdbSeason {
  number: number;
  name: string;
  episodeCount: number;
  airDate: string | null;
}

export type SeasonMapping =
  | { kind: "identity" }
  | { kind: "offset"; offset: number } // sonarr = tmdb + offset
  | { kind: "sonarr-only" }; // can't align safely: use Sonarr numbers without TMDb data

const year = (d: string | null | undefined) => (d ? Number(d.slice(0, 4)) : undefined);

const isRun = (ns: number[]) => ns.every((n, i) => n === i + 1);

export function mapSeasons(
  tmdb: { seasons: number[]; firstAirDate: string | null; lastAirDate: string | null },
  sonarr: { seasons: number[]; firstAired?: string | undefined; lastAired?: string | undefined },
): SeasonMapping {
  const t = [...tmdb.seasons].filter((n) => n > 0).sort((a, b) => a - b);
  const s = [...sonarr.seasons].filter((n) => n > 0).sort((a, b) => a - b);
  if (t.length === s.length && t.every((n, i) => n === s[i])) return { kind: "identity" };
  // Only align two contiguous 1..n runs where TMDb covers a part of Sonarr's show.
  if (!isRun(t) || !isRun(s) || t.length === 0 || t.length > s.length) return { kind: "sonarr-only" };

  const sameStart = year(tmdb.firstAirDate) !== undefined && year(tmdb.firstAirDate) === year(sonarr.firstAired);
  const sameEnd = year(tmdb.lastAirDate) !== undefined && year(tmdb.lastAirDate) === year(sonarr.lastAired);
  if (sameStart && !sameEnd) return { kind: "offset", offset: 0 }; // TMDb entry = the early seasons
  if (sameEnd && !sameStart) return { kind: "offset", offset: s.length - t.length }; // = the latest seasons
  if (sameStart && sameEnd && t.length === s.length) return { kind: "identity" };
  return { kind: "sonarr-only" };
}
