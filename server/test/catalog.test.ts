import { describe, expect, it } from "vitest";
import { groupQueue } from "../src/catalog/arr.js";
import { stripYear } from "../src/catalog/plex.js";
import { classifyRelease } from "../src/catalog/titles.js";
import {
  FakePlex,
  fakeFetch,
  type Handler,
  header,
  json,
  makeApp,
  PLEX_URL,
  signIn,
  signInAdmin,
} from "./helpers.js";

describe("classifyRelease", () => {
  const today = "2026-11-08";
  it("uses the regional digital/physical date when known", () => {
    expect(classifyRelease("2026-07-15", { date: "2026-11-17", regionKnown: true }, today)).toEqual({
      released: false,
      availableFrom: "2026-11-17",
    });
    expect(classifyRelease("2026-07-15", { date: "2026-10-01", regionKnown: true }, today)).toEqual({
      released: true,
      availableFrom: "2026-10-01",
    });
  });
  it("treats recent theatrical-only movies as not yet available", () => {
    expect(classifyRelease("2026-10-01", { date: null, regionKnown: true }, today).released).toBe(false);
    expect(classifyRelease("2026-12-18", undefined, today).released).toBe(false);
  });
  it("assumes older movies without regional data are available", () => {
    expect(classifyRelease("2001-05-01", { date: null, regionKnown: false }, today).released).toBe(true);
    expect(classifyRelease(null, undefined, today).released).toBe(false);
  });
});

describe("groupQueue", () => {
  it("sums progress per title and prefers the active state", () => {
    const g = groupQueue(
      [
        { seriesId: 1, size: 100, sizeleft: 0, timeleft: "00:00:00", trackedDownloadState: "importPending" },
        { seriesId: 1, size: 300, sizeleft: 150, timeleft: "00:10:00", trackedDownloadState: "downloading" },
        { seriesId: 1, size: 100, sizeleft: 100, timeleft: "1.02:00:00", trackedDownloadState: "downloading" },
        { seriesId: 2, size: 0, sizeleft: 0 },
        { size: 5 },
      ],
      (r) => r.seriesId,
    );
    expect(g.get(1)).toEqual({ percent: 50, timeLeft: "1.02:00:00", state: "downloading", items: 3 });
    expect(g.get(2)).toMatchObject({ percent: 0, timeLeft: null, state: "unknown" });
    expect(g.size).toBe(2);
  });
});

describe("stripYear", () => {
  it("drops a redundant year suffix only", () => {
    expect(stripYear("Doctor Who (2005)", 2005)).toBe("Doctor Who");
    expect(stripYear("Doctor Who (2005)", 1963)).toBe("Doctor Who (2005)");
    expect(stripYear("1917", 2019)).toBe("1917");
  });
});

// ---------------------------------------------------------------------------
// /api/home end to end against fake Plex server, Radarr, Sonarr and TMDb.
// ---------------------------------------------------------------------------

const RADARR = "http://radarr:7878";
const SONARR = "http://sonarr:8989";
const TMDB = "https://api.themoviedb.org/3";

const movie = (id: number, title: string, date: string, extra = {}) => ({
  id,
  title,
  release_date: date,
  overview: `${title} overview`,
  poster_path: `/p${id}.jpg`,
  backdrop_path: `/b${id}.jpg`,
  vote_average: 7.5,
  vote_count: 1000,
  ...extra,
});
const show = (id: number, name: string, date: string, extra = {}) => ({
  id,
  name,
  first_air_date: date,
  overview: "",
  poster_path: `/p${id}.jpg`,
  backdrop_path: null,
  vote_average: 8,
  vote_count: 500,
  ...extra,
});

/** Plex server routes; only the given server token is accepted. */
function plexServer(token: string): Array<[string | RegExp, Handler]> {
  const authed =
    (body: unknown): Handler =>
    (_u, init) =>
      header(init, "x-plex-token") === token ? json(body) : json({}, 401);
  return [
    [
      `${PLEX_URL}/library/sections`,
      authed({
        MediaContainer: {
          Directory: [
            { key: "1", type: "movie" },
            { key: "2", type: "show" },
            { key: "3", type: "artist" },
          ],
        },
      }),
    ],
    [
      `${PLEX_URL}/library/sections/1/all`,
      authed({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: "10",
              type: "movie",
              title: "The Matrix",
              year: 1999,
              thumb: "/library/metadata/10/thumb/1",
              art: "/library/metadata/10/art/1",
              addedAt: 100,
              lastViewedAt: 5000,
              Guid: [{ id: "imdb://tt0133093" }, { id: "tmdb://603" }],
            },
            // No TMDb match (e.g. a home video): ignored.
            { ratingKey: "11", type: "movie", title: "Home Video", addedAt: 999, Guid: [] },
          ],
        },
      }),
    ],
    [
      `${PLEX_URL}/library/sections/2/all`,
      authed({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: "20",
              type: "show",
              title: "Doctor Who (2005)",
              year: 2005,
              thumb: "/library/metadata/20/thumb/2",
              art: "/library/metadata/20/art/2",
              addedAt: 200,
              lastViewedAt: 4000,
              Guid: [{ id: "tmdb://200" }],
            },
          ],
        },
      }),
    ],
    [
      `${PLEX_URL}/hubs/home/continueWatching`,
      authed({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: "21",
              type: "episode",
              title: "My Rom-Com",
              grandparentRatingKey: "20",
              grandparentThumb: "/library/metadata/20/thumb/2",
              grandparentArt: "/library/metadata/20/art/2",
              parentIndex: 2,
              index: 8,
              viewOffset: 300,
              duration: 1200,
            },
            { ratingKey: "10", type: "movie", title: "The Matrix", viewOffset: 0, duration: 100 },
            { ratingKey: "99", type: "clip", title: "ignored" },
          ],
        },
      }),
    ],
    [
      `${PLEX_URL}/photo/:/transcode`,
      (u, init) =>
        header(init, "x-plex-token") === token && u.searchParams.get("url") === "/library/metadata/10/thumb/1"
          ? new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), { headers: { "content-type": "image/jpeg" } })
          : new Response("nope", { status: 404 }),
    ],
  ];
}

function arrRoutes(): Record<string, Handler> {
  const key =
    (k: string, body: unknown): Handler =>
    (_u, init) =>
      header(init, "x-api-key") === k ? json(body) : json({}, 401);
  return {
    [`${RADARR}/api/v3/movie`]: key("rk", [
      { id: 1, tmdbId: 100, monitored: true, hasFile: true }, // imported, Plex hasn't scanned yet
      { id: 2, tmdbId: 101, monitored: true, hasFile: false }, // downloading
      { id: 3, tmdbId: 102, monitored: true, hasFile: false }, // requested, searching
      { id: 4, tmdbId: 603, monitored: true, hasFile: true }, // owned
    ]),
    [`${RADARR}/api/v3/queue`]: key("rk", {
      totalRecords: 1,
      records: [{ movieId: 2, size: 1000, sizeleft: 250, timeleft: "00:05:00", trackedDownloadState: "downloading" }],
    }),
    [`${SONARR}/api/v3/series`]: key("sk", [
      { id: 7, tmdbId: 200, monitored: true, statistics: { episodeFileCount: 3 } },
    ]),
    [`${SONARR}/api/v3/queue`]: key("sk", {
      totalRecords: 1,
      records: [{ seriesId: 7, size: 10, sizeleft: 0, timeleft: "00:00:00", trackedDownloadState: "importPending" }],
    }),
  };
}

function tmdbRoutes(): Record<string, Handler> {
  const ok =
    (body: unknown): Handler =>
    (u) =>
      u.searchParams.get("api_key") === "0123456789abcdef0123456789abcdef" ? json(body) : json({}, 401);
  return {
    [`${TMDB}/trending/movie/week`]: ok({
      results: [
        movie(603, "The Matrix", "1999-03-31"),
        movie(100, "Imported", "2020-01-01"),
        movie(101, "Downloading", "2020-01-01"),
        movie(102, "Requested", "2020-01-01"),
        movie(104, "In Theaters", "2026-10-20"),
        movie(105, "Old Classic", "1980-01-01"),
        movie(106, "Has Digital", "2026-09-01"),
      ],
    }),
    [`${TMDB}/trending/tv/week`]: ok({
      results: [show(200, "Doctor Who", "2005-03-26"), show(201, "Other Show", "2010-01-01"), show(202, "Future Show", "2027-03-01")],
    }),
    // Seed #1 = The Matrix (most recently watched)
    [`${TMDB}/movie/603/recommendations`]: ok({
      results: [
        movie(604, "The Matrix Reloaded", "2003-05-15"),
        movie(605, "Obscure", "2003-01-01", { vote_count: 3 }), // filtered: too few votes
        movie(606, "Bad", "2003-01-01", { vote_average: 3.1 }), // filtered: low rating
        movie(603, "The Matrix", "1999-03-31"), // the seed itself: filtered
      ],
    }),
    [`${TMDB}/tv/200/recommendations`]: ok({ results: [show(300, "The Office", "2005-03-24")] }),
    [`${TMDB}/movie/104/release_dates`]: ok({
      results: [{ iso_3166_1: "US", release_dates: [{ type: 3, release_date: "2026-10-20T00:00:00.000Z" }] }],
    }),
    [`${TMDB}/movie/105/release_dates`]: ok({ results: [] }),
    [`${TMDB}/movie/106/release_dates`]: ok({
      results: [{ iso_3166_1: "US", release_dates: [{ type: 4, release_date: "2026-10-28T00:00:00.000Z" }] }],
    }),
    [`${TMDB}/movie/604/release_dates`]: ok({ results: [] }),
    [`${TMDB}/search/multi`]: (u) =>
      u.searchParams.get("api_key") !== "0123456789abcdef0123456789abcdef"
        ? json({}, 401)
        : u.searchParams.get("query") === "matrix"
          ? json({
              results: [
                { ...show(9999, "Thin Show", "2010-01-01", { poster_path: null, backdrop_path: null, vote_count: 1 }), media_type: "tv" },
                { id: 6384, name: "Keanu Reeves", media_type: "person" },
                { ...movie(603, "The Matrix", "1999-03-31", { poster_path: null, backdrop_path: null }), media_type: "movie" },
                { ...movie(102, "Requested", "2020-01-01"), media_type: "movie" },
                { ...movie(104, "In Theaters", "2026-10-20"), media_type: "movie" },
                { ...show(200, "Doctor Who", "2005-03-26"), media_type: "tv" },
              ],
            })
          : json({ results: [] }),
    [`${TMDB}/movie/101`]: ok(movie(101, "Downloading", "2020-01-01")),
    [`${TMDB}/movie/100`]: ok(movie(100, "Imported", "2020-01-01")),
  };
}

const catalogEnv = {
  SOFARR_RADARR_URL: RADARR,
  SOFARR_RADARR_API_KEY: "rk",
  SOFARR_SONARR_URL: SONARR,
  SOFARR_SONARR_API_KEY: "sk",
  SOFARR_TMDB_API_KEY: "0123456789abcdef0123456789abcdef",
};

async function homeSetup(opts: { tmdb?: boolean; extraRoutes?: Array<[string | RegExp, Handler]> } = {}) {
  const plex = new FakePlex();
  const fetch = fakeFetch([
    ...(opts.extraRoutes ?? []),
    ...plexServer("srv-owner"),
    ...Object.entries(arrRoutes()),
    ...(opts.tmdb === false ? [] : Object.entries(tmdbRoutes())),
    ...plex.routes(),
  ]);
  const app = makeApp(catalogEnv, fetch);
  const cookie = await signInAdmin(app, plex);
  return { app, cookie, fetch, plex };
}

describe("GET /api/home", () => {
  it("builds rows with one merged status per title", async () => {
    const { app, cookie } = await homeSetup();
    const res = await app.inject({ url: "/api/home", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { rows, warnings } = res.json();
    expect(warnings).toEqual([]);
    expect(rows.map((r: { id: string }) => r.id)).toEqual([
      "continue",
      "downloading",
      "because-0",
      "trending-movies",
      "because-1",
      "trending-tv",
      "recently-added",
    ]);
    const row = (id: string) => rows.find((r: { id: string }) => r.id === id);
    const statusOf = (id: string) =>
      Object.fromEntries(row(id).items.map((i: { title: string; status: string }) => [i.title, i.status]));

    expect(statusOf("trending-movies")).toEqual({
      "The Matrix": "owned",
      Imported: "downloading",
      Downloading: "downloading",
      Requested: "requested",
      "In Theaters": "upcoming",
      "Old Classic": "available",
      "Has Digital": "available",
    });
    expect(statusOf("trending-tv")).toEqual({
      "Doctor Who": "owned",
      "Other Show": "available",
      "Future Show": "upcoming",
    });

    const tm = row("trending-movies").items;
    expect(tm[0]).toMatchObject({ plexKey: "10", id: "movie:603", poster: "https://image.tmdb.org/t/p/w342/p603.jpg" });
    expect(tm[1].download).toMatchObject({ state: "waitingForPlex", percent: 100 });
    expect(tm[2].download).toMatchObject({ state: "downloading", percent: 75, timeLeft: "00:05:00" });
    expect(tm[4]).toMatchObject({ availableFrom: null });
    expect(row("trending-tv").items[2]).toMatchObject({ availableFrom: "2027-03-01" });
  });

  it("builds Continue Watching from Plex with episode labels and resume points", async () => {
    const { app, cookie } = await homeSetup();
    const { rows } = (await app.inject({ url: "/api/home", headers: { cookie } })).json();
    const items = rows[0].items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "Doctor Who", // year suffix stripped
      status: "owned",
      plexKey: "20",
      poster: "/api/plex/image?path=%2Flibrary%2Fmetadata%2F20%2Fthumb%2F2&w=342&h=513",
      resume: { plexKey: "21", label: "S2 · E8 · My Rom-Com", percent: 25 },
    });
    expect(items[1].resume).toEqual({ plexKey: "10", label: null, percent: 0 });
  });

  it("filters weak recommendations and the seed itself", async () => {
    const { app, cookie } = await homeSetup();
    const { rows } = (await app.inject({ url: "/api/home", headers: { cookie } })).json();
    expect(rows[2]).toMatchObject({ title: "Because you watched The Matrix" });
    expect(rows[2].items.map((i: { title: string }) => i.title)).toEqual(["The Matrix Reloaded"]);
    expect(rows[4]).toMatchObject({ title: "Because you watched Doctor Who" });
  });

  it("lists active downloads, including owned shows getting episodes", async () => {
    const { app, cookie } = await homeSetup();
    const { rows } = (await app.inject({ url: "/api/home", headers: { cookie } })).json();
    const dl = rows.find((r: { id: string }) => r.id === "downloading").items;
    expect(dl.map((i: { title: string; status: string }) => `${i.title}:${i.status}`).sort()).toEqual([
      "Doctor Who:owned",
      "Downloading:downloading",
    ]);
  });

  it("still renders Plex rows when TMDb is down, with a warning", async () => {
    const { app, cookie } = await homeSetup({ tmdb: false });
    const { rows, warnings } = (await app.inject({ url: "/api/home", headers: { cookie } })).json();
    expect(rows.map((r: { id: string }) => r.id)).toEqual(["continue", "downloading", "recently-added"]);
    expect(warnings).toEqual(["tmdb: unreachable (ECONNREFUSED)"]);
  });

  it("never exposes tokens or API keys", async () => {
    const { app, cookie } = await homeSetup();
    const body = (await app.inject({ url: "/api/home", headers: { cookie } })).body;
    for (const s of ["srv-owner", "owner-token", "rk", "sk", "0123456789abcdef"]) {
      expect(body).not.toContain(`"${s}`);
      expect(body).not.toContain(`=${s}`);
    }
  });

  it("requires a selected profile", async () => {
    const plex = new FakePlex();
    const app = makeApp(catalogEnv, fakeFetch(plex.routes()));
    expect((await app.inject("/api/home")).statusCode).toBe(401);
    const { cookie } = await signIn(app, plex);
    const res = await app.inject({ url: "/api/home", headers: { cookie: cookie! } });
    expect(res.json()).toEqual({ error: "no_profile_selected" });
  });
});

describe("GET /api/plex/image", () => {
  it("proxies Plex artwork with the profile's token", async () => {
    const { app, cookie } = await homeSetup();
    const res = await app.inject({
      url: "/api/plex/image?path=%2Flibrary%2Fmetadata%2F10%2Fthumb%2F1&w=342&h=513",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toBe("private, max-age=86400");
    expect([...res.rawPayload.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  it("only allows Plex artwork paths", async () => {
    const { app, cookie, fetch } = await homeSetup();
    const before = fetch.calls.length;
    for (const path of ["/:/prefs", "/library/metadata/1/thumb/1/../../../:/prefs", "http://evil/x", ""]) {
      const res = await app.inject({
        url: `/api/plex/image?path=${encodeURIComponent(path)}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(fetch.calls.length).toBe(before);
  });

  it("passes through a missing image as 404", async () => {
    const { app, cookie } = await homeSetup();
    const res = await app.inject({
      url: "/api/plex/image?path=%2Flibrary%2Fmetadata%2F99%2Fthumb%2F1",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/search", () => {
  it("returns movies and shows with merged status, people dropped, thin entries last", async () => {
    const { app, cookie } = await homeSetup();
    const res = await app.inject({ url: "/api/search?q=%20matrix%20", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { query, results } = res.json();
    expect(query).toBe("matrix");
    expect(results.map((r: { title: string; status: string }) => `${r.title}:${r.status}`)).toEqual([
      "The Matrix:owned",
      "Requested:requested",
      "In Theaters:upcoming",
      "Doctor Who:owned",
      "Thin Show:available",
    ]);
    // Owned, but TMDb has no artwork: falls back to Plex's (proxied).
    expect(results[0]).toMatchObject({
      backdrop: "/api/plex/image?path=%2Flibrary%2Fmetadata%2F10%2Fart%2F1&w=780&h=439",
      poster: "/api/plex/image?path=%2Flibrary%2Fmetadata%2F10%2Fthumb%2F1&w=342&h=513",
    });
  });

  it("returns an empty list for no matches, and validates the query", async () => {
    const { app, cookie } = await homeSetup();
    expect((await app.inject({ url: "/api/search?q=zzz", headers: { cookie } })).json().results).toEqual([]);
    expect((await app.inject({ url: "/api/search?q=%20%20", headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/search", headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/search?q=${"x".repeat(101)}`, headers: { cookie } })).statusCode).toBe(400);
  });

  it("requires a profile", async () => {
    const app = makeApp(catalogEnv, fakeFetch(new FakePlex().routes()));
    expect((await app.inject("/api/search?q=matrix")).statusCode).toBe(401);
  });
});
