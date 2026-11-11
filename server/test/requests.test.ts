import { describe, expect, it } from "vitest";
import { seasonStatus } from "../src/catalog/detail.js";
import { mapSeasons } from "../src/catalog/seasonMap.js";
import { FakePlex, fakeFetch, type Handler, json, makeApp, PLEX_URL, signIn, signInAdmin } from "./helpers.js";

const RADARR = "http://radarr:7878";
const SONARR = "http://sonarr:8989";
const TMDB = "https://api.themoviedb.org/3";

/** Stateful fake Radarr + Sonarr that record writes. */
class FakeArr {
  movies: Array<Record<string, unknown>> = [
    { id: 1, tmdbId: 813, title: "Casablanca", monitored: true, hasFile: true, qualityProfileId: 4, rootFolderPath: "/movies", minimumAvailability: "released" },
    { id: 2, tmdbId: 500, title: "Unmonitored", monitored: false, hasFile: false, qualityProfileId: 4, rootFolderPath: "/movies", minimumAvailability: "released" },
  ];
  series: Array<Record<string, unknown>> = [
    {
      id: 7,
      tmdbId: 1421,
      tvdbId: 95011,
      title: "Parks and Recreation",
      monitored: true,
      monitorNewItems: "none",
      qualityProfileId: 4,
      rootFolderPath: "/tv",
      seasonFolder: true,
      seriesType: "standard",
      seasons: [
        { seasonNumber: 0, monitored: false },
        { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 24, episodeCount: 24 } },
        { seasonNumber: 2, monitored: false, statistics: { episodeFileCount: 0, episodeCount: 0 } },
        { seasonNumber: 3, monitored: false, statistics: { episodeFileCount: 0, episodeCount: 0 } },
      ],
    },
  ];
  writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  lookups: string[] = [];
  lookupDelayMs = 0;
  failNextAdd = false;
  /** seriesId → episodes Sonarr knows. */
  episodes = new Map<number, Array<Record<string, unknown>>>([
    [
      7,
      [1, 2, 3, 4].map((n) => ({
        id: 700 + n,
        seasonNumber: 2,
        episodeNumber: n,
        title: `PR 2x${n}`,
        airDate: n === 4 ? "2027-01-01" : `2010-09-0${n}`,
        monitored: n === 3,
        hasFile: n === 1,
      })),
    ],
  ]);
  sonarrQueue: Array<Record<string, unknown>> = [{ seriesId: 7, episodeId: 702, downloadId: "H", size: 10, sizeleft: 5 }];
  /** Calls to GET /episode before a new series' episodes "appear". */
  episodesAppearAfter = 0;

  routes(): Array<[string | RegExp, Handler]> {
    const body = (init: RequestInit) => JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    const record = (init: RequestInit, u: URL) => {
      const b = body(init);
      this.writes.push({ method: init.method!, path: u.pathname, body: b });
      return b;
    };
    const profiles = json([{ id: 1, name: "Any" }, { id: 4, name: "HD-1080p" }]);
    return [
      [`${RADARR}/api/v3/qualityprofile`, () => profiles.clone()],
      [`${RADARR}/api/v3/rootfolder`, () => json([{ id: 1, path: "/other" }, { id: 2, path: "/movies" }])],
      [
        `${RADARR}/api/v3/movie`,
        (u, init) => {
          if (init.method === "POST") {
            if (this.failNextAdd) return json([{ errorMessage: "boom" }], 400);
            const b = record(init, u);
            const added = { ...b, id: 99, hasFile: false };
            this.movies.push(added);
            return json(added, 201);
          }
          const tmdbId = u.searchParams.get("tmdbId");
          return json(tmdbId ? this.movies.filter((m) => String(m.tmdbId) === tmdbId) : this.movies);
        },
      ],
      [/^http:\/\/radarr:7878\/api\/v3\/movie\/\d+$/, (u, init) => json(record(init, u))],
      [
        `${RADARR}/api/v3/movie/lookup/tmdb`,
        (u) =>
          u.searchParams.get("tmdbId") === "603"
            ? json({ title: "The Matrix", tmdbId: 603, year: 1999, titleSlug: "the-matrix-603", images: [{ coverType: "poster" }] })
            : json({}, 404),
      ],
      [`${RADARR}/api/v3/queue`, () => json({ totalRecords: 0, records: [] })],
      [`${RADARR}/api/v3/command`, (u, init) => json({ id: 1, ...record(init, u) }, 201)],

      [`${SONARR}/api/v3/qualityprofile`, () => profiles.clone()],
      [`${SONARR}/api/v3/rootfolder`, () => json([{ id: 1, path: "/tv" }])],
      [
        `${SONARR}/api/v3/series`,
        (u, init) => {
          if (init.method === "POST") {
            const b = record(init, u);
            const added = { ...b, id: 70 };
            this.series.push(added);
            this.episodes.set(
              70,
              [1, 2, 3].map((n) => ({ id: 900 + n, seasonNumber: 1, episodeNumber: n, title: `BB 1x${n}`, airDate: "2008-01-20", monitored: false, hasFile: false })),
            );
            return json(added, 201);
          }
          return json(this.series);
        },
      ],
      [/^http:\/\/sonarr:8989\/api\/v3\/series\/\d+$/, (u, init) => json(record(init, u))],
      [
        `${SONARR}/api/v3/series/lookup`,
        async (u) => {
          const term = u.searchParams.get("term");
          this.lookups.push(term!);
          if (this.lookupDelayMs) await new Promise((r) => setTimeout(r, this.lookupDelayMs));
          if (term === "tmdb:87012" || term === "tvdb:184871") {
            return json([
              {
                title: "The Great British Bake Off",
                tvdbId: 184871,
                tmdbId: 87012,
                year: 2010,
                titleSlug: "the-great-british-bake-off",
                firstAired: "2010-08-17T00:00:00Z",
                lastAired: "2026-11-03T20:00:00Z",
                images: [],
                seasons: Array.from({ length: 18 }, (_, n) => ({ seasonNumber: n, monitored: true })),
              },
            ]);
          }
          return term === "tmdb:1396"
            ? json([
                {
                  title: "Breaking Bad",
                  tvdbId: 81189,
                  tmdbId: 1396,
                  year: 2008,
                  titleSlug: "breaking-bad",
                  images: [],
                  seasons: [0, 1, 2, 3, 4, 5].map((n) => ({ seasonNumber: n, monitored: true })),
                },
              ])
            : json([]);
        },
      ],
      [`${SONARR}/api/v3/queue`, () => json({ totalRecords: this.sonarrQueue.length, records: this.sonarrQueue })],
      [
        `${SONARR}/api/v3/episode`,
        (u) => {
          const id = Number(u.searchParams.get("seriesId"));
          const season = u.searchParams.get("seasonNumber");
          if (this.episodesAppearAfter > 0) {
            this.episodesAppearAfter--;
            return json([]);
          }
          const eps = this.episodes.get(id) ?? [];
          return json(season ? eps.filter((e) => String(e.seasonNumber) === season) : eps);
        },
      ],
      [`${SONARR}/api/v3/episode/monitor`, (u, init) => json(record(init, u), 202)],
      [`${SONARR}/api/v3/command`, (u, init) => json({ id: 2, ...record(init, u) }, 201)],
    ];
  }
}

const tmdbKey = "0123456789abcdef0123456789abcdef";
// Another language's logo outranks it, but the configured language (en) wins; then the best rated.
const matrixLogos = [
  { file_path: "/fr.png", iso_639_1: "fr", vote_average: 9 },
  { file_path: "/en-low.png", iso_639_1: "en", vote_average: 2 },
  { file_path: "/en-top.png", iso_639_1: "en", vote_average: 5.5 },
  { file_path: "/neutral.svg", iso_639_1: null, vote_average: 8 },
];
function tmdbRoutes(): Array<[string | RegExp, Handler]> {
  const ok =
    (b: unknown): Handler =>
    (u) =>
      u.searchParams.get("api_key") === tmdbKey ? json(b) : json({}, 401);
  return [
    [`${TMDB}/movie/603`, ok({ id: 603, title: "The Matrix", release_date: "1999-03-31", genres: [{ name: "Action" }], runtime: 136, videos: { results: [{ site: "YouTube", type: "Trailer", key: "vKQi3bBA1y8", official: true }] }, images: { logos: matrixLogos } })],
    [`${TMDB}/movie/603/images`, ok({ logos: matrixLogos })],
    [`${TMDB}/movie/813/images`, ok({ logos: [] })],
    [`${TMDB}/movie/603/release_dates`, ok({ results: [] })],
    [`${TMDB}/movie/813`, ok({ id: 813, title: "Casablanca", release_date: "1980-07-02" })],
    [`${TMDB}/movie/500`, ok({ id: 500, title: "Unmonitored", release_date: "1990-01-01" })],
    [
      `${TMDB}/tv/1396`,
      ok({
        id: 1396,
        name: "Breaking Bad",
        first_air_date: "2008-01-20",
        episode_run_time: [],
        last_episode_to_air: { runtime: 47 },
        seasons: [
          { season_number: 0, name: "Specials", episode_count: 9, air_date: "2009-02-17" },
          { season_number: 1, name: "Season 1", episode_count: 7, air_date: "2008-01-20" },
          { season_number: 2, name: "Season 2", episode_count: 13, air_date: "2009-03-08" },
        ],
      }),
    ],
    [
      `${TMDB}/tv/1421`,
      ok({
        id: 1421,
        name: "Parks and Recreation",
        first_air_date: "2009-09-23",
        seasons: [1, 2, 3].map((n) => ({ season_number: n, name: `Season ${n}`, episode_count: 24, air_date: "2010-01-01" })),
      }),
    ],
    [`${TMDB}/movie/404404`, () => json({ status_code: 34 }, 404)],
    [`${TMDB}/movie/404404/images`, () => json({ status_code: 34 }, 404)],
    [
      `${TMDB}/tv/87012`,
      ok({
        id: 87012,
        name: "The Great British Bake Off",
        first_air_date: "2017-08-29",
        last_air_date: "2026-11-03",
        external_ids: { tvdb_id: null },
        seasons: Array.from({ length: 10 }, (_, i) => ({ season_number: i + 1, name: `Collection ${i + 1}`, episode_count: 10, air_date: `${2017 + i}-08-29` })),
      }),
    ],
    [`${TMDB}/tv/87012/external_ids`, ok({ tvdb_id: null })],
    [
      `${TMDB}/tv/34549`,
      ok({
        id: 34549,
        name: "The Great British Bake Off",
        first_air_date: "2010-08-17",
        last_air_date: "2016-10-26",
        external_ids: { tvdb_id: 184871 },
        seasons: Array.from({ length: 7 }, (_, i) => ({ season_number: i + 1, name: `Series ${i + 1}`, episode_count: 10, air_date: `${2010 + i}-08-17` })),
      }),
    ],
    [`${TMDB}/tv/34549/external_ids`, ok({ tvdb_id: 184871 })],
    [`${TMDB}/tv/1396/external_ids`, ok({ tvdb_id: 81189 })],
    [
      `${TMDB}/tv/1396/season/1`,
      ok({
        episodes: [
          { episode_number: 1, name: "Pilot", air_date: "2008-01-20" },
          { episode_number: 2, name: "Cat's in the Bag...", air_date: "2008-01-27" },
        ],
      }),
    ],
  ];
}

const emptyPlexServer: Array<[string | RegExp, Handler]> = [
  [`${PLEX_URL}/library/sections`, () => json({ MediaContainer: { Directory: [] } })],
];

const env = {
  SOFARR_RADARR_URL: RADARR,
  SOFARR_RADARR_API_KEY: "rk",
  SOFARR_SONARR_URL: SONARR,
  SOFARR_SONARR_API_KEY: "sk",
  SOFARR_TMDB_API_KEY: tmdbKey,
};

async function setup(extraEnv: Record<string, string> = {}, sonarrBudgetMs?: number) {
  const plex = new FakePlex();
  const arr = new FakeArr();
  const fetch = fakeFetch([...emptyPlexServer, ...arr.routes(), ...tmdbRoutes(), ...plex.routes()]);
  const app = makeApp({ ...env, ...extraEnv }, fetch, undefined, sonarrBudgetMs);
  const cookie = await signInAdmin(app, plex);
  const post = (payload: unknown, c = cookie) =>
    app.inject({ method: "POST", url: "/api/requests", headers: { cookie: c }, payload: payload as object });
  return { app, cookie, arr, plex, post };
}

describe("POST /api/requests (movies)", () => {
  it("adds a new movie with library-derived defaults and searches", async () => {
    const { post, arr } = await setup();
    const res = await post({ mediaType: "movie", tmdbId: 603 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ result: "added", title: { id: "movie:603", status: "requested" } });
    expect(arr.writes).toEqual([
      {
        method: "POST",
        path: "/api/v3/movie",
        body: {
          title: "The Matrix",
          tmdbId: 603,
          year: 1999,
          titleSlug: "the-matrix-603",
          images: [{ coverType: "poster" }],
          qualityProfileId: 4, // most-used, not the first ("Any")
          rootFolderPath: "/movies", // most-used, not the first ("/other")
          minimumAvailability: "released",
          monitored: true,
          addOptions: { monitor: "movieOnly", searchForMovie: true },
        },
      },
    ]);
  });

  it("re-enables and searches an unmonitored movie instead of adding a duplicate", async () => {
    const { post, arr } = await setup();
    const res = await post({ mediaType: "movie", tmdbId: 500 });
    expect(res.json().result).toBe("searching");
    expect(arr.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PUT /api/v3/movie/2", "POST /api/v3/command"]);
    expect(arr.writes[0]!.body).toMatchObject({ id: 2, monitored: true });
    expect(arr.writes[1]!.body).toEqual({ name: "MoviesSearch", movieIds: [2] });
  });

  it("does nothing for a movie already on disk", async () => {
    const { post, arr } = await setup();
    expect((await post({ mediaType: "movie", tmdbId: 813 })).json().result).toBe("already_have");
    expect(arr.writes).toEqual([]);
  });

  it("honours explicit profile/root overrides", async () => {
    const { post, arr } = await setup({ SOFARR_RADARR_QUALITY_PROFILE: "any", SOFARR_RADARR_ROOT_FOLDER: "/other/" });
    await post({ mediaType: "movie", tmdbId: 603 });
    expect(arr.writes[0]!.body).toMatchObject({ qualityProfileId: 1, rootFolderPath: "/other" });
  });

  it("reports a bad override clearly", async () => {
    const { post } = await setup({ SOFARR_RADARR_QUALITY_PROFILE: "Nope" });
    const res = await post({ mediaType: "movie", tmdbId: 603 });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ source: "radarr", detail: 'quality profile "Nope" not found' });
  });

  it("surfaces Radarr errors as 502 and logs nothing", async () => {
    const { post, arr, app, cookie } = await setup();
    arr.failNextAdd = true;
    const res = await post({ mediaType: "movie", tmdbId: 603 });
    expect(res.statusCode).toBe(502);
    const log = await app.inject({ url: "/api/requests", headers: { cookie } });
    expect(log.json().requests).toEqual([]);
  });
});

describe("POST /api/requests (shows)", () => {
  it("adds a new series monitoring only the chosen seasons", async () => {
    const { post, arr } = await setup();
    const res = await post({ mediaType: "tv", tmdbId: 1396, seasons: [1, 2, 2], seasonNumbering: "sonarr" });
    expect(res.statusCode).toBe(201);
    const add = arr.writes[0]!;
    expect(add.path).toBe("/api/v3/series");
    expect(add.body).toMatchObject({
      tvdbId: 81189,
      tmdbId: 1396,
      qualityProfileId: 4,
      rootFolderPath: "/tv",
      seasonFolder: true,
      seriesType: "standard",
      monitored: true,
      monitorNewItems: "none", // latest season (5) not chosen
      addOptions: { ignoreEpisodesWithFiles: true, searchForMissingEpisodes: true },
    });
    expect(add.body).not.toHaveProperty("addOptions.monitor");
    expect(add.body.seasons).toEqual([
      { seasonNumber: 0, monitored: false },
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: true },
      { seasonNumber: 3, monitored: false },
      { seasonNumber: 4, monitored: false },
      { seasonNumber: 5, monitored: false },
    ]);
  });

  it("follows future seasons when the latest season is chosen", async () => {
    const { post, arr } = await setup();
    await post({ mediaType: "tv", tmdbId: 1396, seasons: [5], seasonNumbering: "sonarr" });
    expect(arr.writes[0]!.body.monitorNewItems).toBe("all");
  });

  it("adds seasons to an existing series and searches", async () => {
    const { post, arr } = await setup();
    const res = await post({ mediaType: "tv", tmdbId: 1421, seasons: [3], seasonNumbering: "sonarr" });
    expect(res.json().result).toBe("searching");
    expect(arr.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PUT /api/v3/series/7", "POST /api/v3/command"]);
    expect(arr.writes[0]!.body.seasons).toEqual([
      { seasonNumber: 0, monitored: false },
      { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 24, episodeCount: 24 } },
      { seasonNumber: 2, monitored: false, statistics: { episodeFileCount: 0, episodeCount: 0 } },
      { seasonNumber: 3, monitored: true, statistics: { episodeFileCount: 0, episodeCount: 0 } },
    ]);
    expect(arr.writes[0]!.body.monitorNewItems).toBe("all"); // 3 is the latest
    expect(arr.writes[1]!.body).toEqual({ name: "SeriesSearch", seriesId: 7 });
  });

  it("does nothing when every chosen season is already complete", async () => {
    const { post, arr } = await setup();
    expect((await post({ mediaType: "tv", tmdbId: 1421, seasons: [1], seasonNumbering: "sonarr" })).json().result).toBe("already_have");
    expect(arr.writes).toEqual([]);
  });

  it("rejects seasons Sonarr doesn't know", async () => {
    const { post } = await setup();
    const res = await post({ mediaType: "tv", tmdbId: 1396, seasons: [9], seasonNumbering: "sonarr" });
    expect(res.statusCode).toBe(502);
    expect(res.json().detail).toBe("Sonarr doesn't know season(s) 9");
  });
});

describe("shows whose season numbering differs (TMDb split vs Sonarr/TVDB)", () => {
  it("title page lists Sonarr's numbers for TMDb's later-era entry", async () => {
    const { app, cookie } = await setup();
    const d = (await app.inject({ url: "/api/titles/tv/87012", headers: { cookie } })).json();
    expect(d.seasonNumbering).toBe("offset");
    expect(d.seasons.map((s: { number: number; tmdbNumber: number | null }) => [s.number, s.tmdbNumber])).toEqual(
      Array.from({ length: 10 }, (_, i) => [i + 8, i + 1]),
    );
    expect(d.seasons.at(-1)).toMatchObject({ number: 17, name: "Season 17", airDate: "2026-08-29" });
  });

  it("title page aligns TMDb's early-era entry via its TVDB id", async () => {
    const { app, cookie, arr } = await setup();
    const d = (await app.inject({ url: "/api/titles/tv/34549", headers: { cookie } })).json();
    expect(arr.lookups).toEqual(["tmdb:34549", "tvdb:184871"]);
    expect(d.seasonNumbering).toBe("identity");
    expect(d.seasons.map((s: { number: number }) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(d.seasons[0]).toMatchObject({ name: "Series 1", tmdbNumber: null });
  });

  it("translates TMDb-numbered requests to Sonarr's numbers", async () => {
    const { post, arr } = await setup();
    // TMDb's "season 10" of 87012 is Sonarr's season 17 (the 2026 series).
    const res = await post({ mediaType: "tv", tmdbId: 87012, seasons: [10], seasonNumbering: "tmdb" });
    expect(res.statusCode).toBe(201);
    const monitored = (arr.writes[0]!.body.seasons as Array<{ seasonNumber: number; monitored: boolean }>)
      .filter((s) => s.monitored)
      .map((s) => s.seasonNumber);
    expect(monitored).toEqual([17]);
  });

  it("refuses rather than guesses when numbering can't be aligned", async () => {
    const { post, arr } = await setup();
    // Breaking Bad fixture: TMDb 1–2 vs Sonarr 1–5 with no air dates.
    const res = await post({ mediaType: "tv", tmdbId: 1396, seasons: [1], seasonNumbering: "tmdb" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "season_numbering_mismatch" });
    expect(arr.writes).toEqual([]);
  });

  it("doesn't hold the title page for a slow Sonarr lookup, and caches it", async () => {
    const { app, cookie, arr } = await setup({}, 50);
    arr.lookupDelayMs = 300;
    const started = Date.now();
    const first = (await app.inject({ url: "/api/titles/tv/87012", headers: { cookie } })).json();
    expect(Date.now() - started).toBeLessThan(290);
    expect(first.seasonNumbering).toBe("tmdb");
    expect(first.seasons.at(-1)).toMatchObject({ number: 10, name: "Collection 10" });

    await new Promise((r) => setTimeout(r, 400)); // background lookup finishes
    const second = (await app.inject({ url: "/api/titles/tv/87012", headers: { cookie } })).json();
    expect(second.seasonNumbering).toBe("offset");
    expect(arr.lookups).toEqual(["tmdb:87012"]); // cached, not repeated
  });
});

describe("episodes", () => {
  it("lists a tracked season's episodes with per-episode status", async () => {
    const { app, cookie } = await setup();
    const r = (await app.inject({ url: "/api/titles/tv/1421/seasons/2", headers: { cookie } })).json();
    expect(r).toMatchObject({ season: 2, numbering: "sonarr" });
    expect(r.episodes.map((e: { number: number; status: string }) => `${e.number}:${e.status}`)).toEqual([
      "1:owned", // has file
      "2:downloading", // in the queue
      "3:requested", // monitored, no file yet
      "4:upcoming", // airs in 2027
    ]);
    expect(r.episodes[0]).toMatchObject({ title: "PR 2x1", airDate: "2010-09-01" });
  });

  it("lists an untracked show's episodes from TMDb", async () => {
    const { app, cookie } = await setup();
    const r = (await app.inject({ url: "/api/titles/tv/1396/seasons/1?numbering=tmdb", headers: { cookie } })).json();
    expect(r.episodes).toEqual([
      { number: 1, title: "Pilot", airDate: "2008-01-20", overview: "", status: "available" },
      { number: 2, title: "Cat's in the Bag...", airDate: "2008-01-27", overview: "", status: "available" },
    ]);
  });

  it("requests specific episodes of a tracked series: monitor + episode search", async () => {
    const { post, arr, app, cookie } = await setup();
    const res = await post({ mediaType: "tv", tmdbId: 1421, seasons: [2], episodes: [1, 2, 3, 3], seasonNumbering: "sonarr" });
    expect(res.json().result).toBe("searching");
    expect(arr.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PUT /api/v3/episode/monitor", "POST /api/v3/command"]);
    // Episode 1 already has a file: not requested again.
    expect(arr.writes[0]!.body).toEqual({ episodeIds: [702, 703], monitored: true });
    expect(arr.writes[1]!.body).toEqual({ name: "EpisodeSearch", episodeIds: [702, 703] });
    const log = (await app.inject({ url: "/api/requests", headers: { cookie } })).json().requests;
    expect(log[0]).toMatchObject({ title: "Parks and Recreation", seasons: [2], episodes: [2, 3] });
  });

  it("adds an untracked series with nothing monitored, waits for its episodes, then requests them", async () => {
    const { post, arr } = await setup();
    arr.episodesAppearAfter = 1; // Sonarr hasn't loaded the episode list on the first check
    const res = await post({ mediaType: "tv", tmdbId: 1396, seasons: [1], episodes: [1], seasonNumbering: "sonarr" });
    expect(res.statusCode).toBe(201);
    const [add, monitor, search] = arr.writes;
    expect(add!.path).toBe("/api/v3/series");
    expect(add!.body).toMatchObject({ monitorNewItems: "none", addOptions: { monitor: "none", searchForMissingEpisodes: false } });
    expect((add!.body.seasons as Array<{ monitored: boolean }>).every((s) => !s.monitored)).toBe(true);
    expect(monitor!.body).toEqual({ episodeIds: [901], monitored: true });
    expect(search!.body).toEqual({ name: "EpisodeSearch", episodeIds: [901] });
  });

  it("is a no-op when every chosen episode is already on disk", async () => {
    const { post, arr } = await setup();
    const res = await post({ mediaType: "tv", tmdbId: 1421, seasons: [2], episodes: [1], seasonNumbering: "sonarr" });
    expect(res.json().result).toBe("already_have");
    expect(arr.writes).toEqual([]);
  });

  it("rejects unknown episodes and multi-season episode requests", async () => {
    const { post } = await setup();
    const bad = await post({ mediaType: "tv", tmdbId: 1421, seasons: [2], episodes: [9], seasonNumbering: "sonarr" });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().detail).toBe("Sonarr doesn't know episode(s) 9 of season 2");
    const multi = await post({ mediaType: "tv", tmdbId: 1421, seasons: [1, 2], episodes: [1], seasonNumbering: "sonarr" });
    expect(multi.statusCode).toBe(400);
  });
});

describe("request validation and access", () => {
  it("validates the body", async () => {
    const { post } = await setup();
    for (const bad of [
      {},
      { mediaType: "movie" },
      { mediaType: "movie", tmdbId: -1 },
      { mediaType: "tv", tmdbId: 1396 }, // seasons required
      { mediaType: "tv", tmdbId: 1396, seasons: [], seasonNumbering: "sonarr" },
      { mediaType: "tv", tmdbId: 1396, seasons: [0], seasonNumbering: "sonarr" }, // specials not requestable
      { mediaType: "tv", tmdbId: 1396, seasons: [1] }, // numbering required
      { mediaType: "tv", tmdbId: 1396, seasons: [1], seasonNumbering: "tvdb" },
      { mediaType: "movie", tmdbId: 603, extra: true },
    ]) {
      expect((await post(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it("requires a profile, and refuses restricted profiles", async () => {
    const plex = new FakePlex();
    plex.users.push({
      id: 3,
      uuid: "tot-uuid",
      username: "tot",
      token: "tot-token",
      serverToken: "srv-tot",
      home: { admin: false, restricted: true },
    });
    const arr = new FakeArr();
    const fetch = fakeFetch([...emptyPlexServer, ...arr.routes(), ...tmdbRoutes(), ...plex.routes()]);
    const app = makeApp(env, fetch);
    const { cookie } = await signIn(app, plex);
    const headers = { cookie: cookie! };
    const post = () =>
      app.inject({ method: "POST", url: "/api/requests", headers, payload: { mediaType: "movie", tmdbId: 603 } });

    expect((await post()).json()).toEqual({ error: "no_profile_selected" });

    await app.inject({ url: "/api/profiles", headers });
    const sel = await app.inject({ method: "POST", url: "/api/profiles/tot-uuid/select", headers, payload: {} });
    expect(sel.statusCode).toBe(200);
    const res = await post();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "restricted_profile" });
    expect(arr.writes).toEqual([]);
  });

  it("logs requests: admin sees all, others only their own", async () => {
    const { post, app, cookie } = await setup();
    await post({ mediaType: "movie", tmdbId: 603 });
    await post({ mediaType: "tv", tmdbId: 1396, seasons: [2, 1], seasonNumbering: "sonarr" });
    const all = (await app.inject({ url: "/api/requests", headers: { cookie } })).json().requests;
    expect(all.map((r: Record<string, unknown>) => [r.profile, r.title, r.result, r.seasons])).toEqual([
      ["owner", "Breaking Bad", "added", [1, 2]],
      ["owner", "The Matrix", "added", undefined],
    ]);

    // Switch to the kid profile: sees none of owner's requests.
    await app.inject({ method: "POST", url: "/api/profiles/kid-uuid/select", headers: { cookie }, payload: { pin: "1234" } });
    expect((await app.inject({ url: "/api/requests", headers: { cookie } })).json().requests).toEqual([]);
  });
});

describe("GET /api/titles/:mediaType/:tmdbId", () => {
  it("returns details, trailer and status", async () => {
    const { app, cookie } = await setup();
    const res = await app.inject({ url: "/api/titles/movie/603", headers: { cookie } });
    expect(res.json()).toMatchObject({
      id: "movie:603",
      title: "The Matrix",
      status: "available",
      genres: ["Action"],
      runtime: 136,
      trailerYoutubeKey: "vKQi3bBA1y8",
      logo: "https://image.tmdb.org/t/p/w500/en-top.png",
    });
  });

  it("has no logo when TMDb has none", async () => {
    const { app, cookie } = await setup();
    expect((await app.inject({ url: "/api/titles/movie/813", headers: { cookie } })).json().logo).toBeNull();
  });

  it("/logo returns just the logo in the configured language, cacheable", async () => {
    const { app, cookie } = await setup();
    const res = await app.inject({ url: "/api/titles/movie/603/logo", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ logo: "https://image.tmdb.org/t/p/w500/en-top.png" });
    expect(res.headers["cache-control"]).toBe("private, max-age=86400");
  });

  it("/logo answers null when there is no logo, and 404 for an unknown title", async () => {
    const { app, cookie } = await setup();
    expect((await app.inject({ url: "/api/titles/movie/813/logo", headers: { cookie } })).json()).toEqual({ logo: null });
    expect((await app.inject({ url: "/api/titles/movie/404404/logo", headers: { cookie } })).statusCode).toBe(404);
  });

  it("/logo requires a signed-in profile", async () => {
    const { app } = await setup();
    expect((await app.inject({ url: "/api/titles/movie/603/logo" })).statusCode).toBe(401);
  });

  it("returns per-season status for shows, skipping specials", async () => {
    const { app, cookie, arr } = await setup();
    arr.sonarrQueue = [];
    const tv = (await app.inject({ url: "/api/titles/tv/1421", headers: { cookie } })).json();
    expect(tv.status).toBe("requested");
    expect(tv.seasons.map((s: { number: number; status: string }) => `${s.number}:${s.status}`)).toEqual([
      "1:requested",
      "2:available",
      "3:available",
    ]);
    const bb = (await app.inject({ url: "/api/titles/tv/1396", headers: { cookie } })).json();
    expect(bb.runtime).toBe(47); // falls back to the latest episode
    // TMDb (1–2) and Sonarr (1–5, no air dates) can't be aligned: use Sonarr's numbers, never guess.
    expect(bb.seasonNumbering).toBe("sonarr-only");
    expect(bb.seasons.map((s: { number: number }) => s.number)).toEqual([1, 2, 3, 4, 5]);
    expect(bb.seasons[0]).toMatchObject({ name: "Season 1", tmdbNumber: null, aired: null, status: "available" });
  });

  it("404s unknown titles and 400s bad params", async () => {
    const { app, cookie } = await setup();
    expect((await app.inject({ url: "/api/titles/movie/404404", headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/titles/book/1", headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/titles/movie/abc", headers: { cookie } })).statusCode).toBe(400);
  });
});

describe("seasonStatus", () => {
  const s = (number: number, episodeCount: number, aired: boolean | null = true) => ({ number, episodeCount, aired });
  const none = new Set<number>();
  it("ranks owned > downloading > partial > requested > upcoming > available", () => {
    expect(seasonStatus(s(1, 10), 10, none, none)).toBe("owned");
    expect(seasonStatus(s(1, 10), 4, new Set([1]), none)).toBe("downloading");
    expect(seasonStatus(s(1, 10), 4, none, new Set([1]))).toBe("partial");
    expect(seasonStatus(s(1, 10), 0, none, new Set([1]))).toBe("requested");
    expect(seasonStatus(s(1, 10, false), 0, none, none)).toBe("upcoming");
    expect(seasonStatus(s(1, 0, null), 0, none, none)).toBe("available"); // unknown: let Sonarr decide
    expect(seasonStatus(s(1, 10), 0, none, none)).toBe("available");
  });
});

describe("mapSeasons", () => {
  const run = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  // The Great British Bake Off: one show on TVDB/Sonarr (seasons 1–17), two entries on TMDb.
  const sonarr = { seasons: [0, ...run(17)], firstAired: "2010-08-17T00:00:00Z", lastAired: "2026-11-03T20:00:00Z" };

  it("aligns TMDb's later-era entry to Sonarr's latest seasons", () => {
    // TMDb 87012: 2017–, seasons 1–10  →  Sonarr 8–17
    expect(mapSeasons({ seasons: run(10), firstAirDate: "2017-08-29", lastAirDate: "2026-11-03" }, sonarr)).toEqual({
      kind: "offset",
      offset: 7,
    });
  });

  it("aligns TMDb's early-era entry to Sonarr's first seasons", () => {
    // TMDb 34549: 2010–2016, seasons 1–7  →  Sonarr 1–7
    expect(mapSeasons({ seasons: run(7), firstAirDate: "2010-08-17", lastAirDate: "2016-10-26" }, sonarr)).toEqual({
      kind: "offset",
      offset: 0,
    });
  });

  it("is identity when numbering matches", () => {
    expect(
      mapSeasons(
        { seasons: [0, ...run(5)], firstAirDate: "2008-01-20", lastAirDate: "2013-09-29" },
        { seasons: [0, ...run(5)], firstAired: "2008-01-20T00:00:00Z", lastAired: "2013-09-29T00:00:00Z" },
      ),
    ).toEqual({ kind: "identity" });
  });

  it("refuses to guess when it can't align", () => {
    // TMDb has more seasons than Sonarr (e.g. anime split differently)
    expect(mapSeasons({ seasons: run(4), firstAirDate: "2020-01-01", lastAirDate: "2024-01-01" }, { seasons: run(2), firstAired: "2020-01-01", lastAired: "2024-01-01" }).kind).toBe("sonarr-only");
    // Gaps in numbering
    expect(mapSeasons({ seasons: [1, 3], firstAirDate: "2020-01-01", lastAirDate: "2021-01-01" }, { seasons: run(4), firstAired: "2020-01-01" }).kind).toBe("sonarr-only");
    // Neither start nor end matches
    expect(mapSeasons({ seasons: run(2), firstAirDate: "2015-01-01", lastAirDate: "2016-01-01" }, { seasons: run(5), firstAired: "2010-01-01", lastAired: "2020-01-01" }).kind).toBe("sonarr-only");
  });
});
