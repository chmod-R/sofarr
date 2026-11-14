import { describe, expect, it } from "vitest";
import { FakePlex, fakeFetch, type Handler, header, json, makeApp, PLEX_URL, signInAdmin } from "./helpers.js";

const TMDB = "https://api.themoviedb.org/3";
const KEY = "0123456789abcdef0123456789abcdef";

/** A one-show Plex library whose watch state the test can change. */
function fakeLibrary() {
  const eps = [
    { ratingKey: "301", index: 1, viewCount: 1, duration: 1_200_000 }, // watched
    { ratingKey: "302", index: 2, viewOffset: 900_000, duration: 1_200_000 }, // 75% in
    { ratingKey: "303", index: 3, duration: 1_200_000 }, // not started
  ] as Array<Record<string, unknown>>;
  const authed = (h: Handler): Handler => (u, init) => (header(init, "x-plex-token") === "srv-owner" ? h(u, init) : json({}, 401));
  const routes: Array<[string | RegExp, Handler]> = [
    [`${PLEX_URL}/library/sections`, authed(() => json({ MediaContainer: { Directory: [{ key: "2", type: "show" }] } }))],
    [
      `${PLEX_URL}/library/sections/2/all`,
      authed(() => json({ MediaContainer: { Metadata: [{ ratingKey: "20", type: "show", title: "Doctor Who", Guid: [{ id: "tmdb://200" }] }] } })),
    ],
    [
      `${PLEX_URL}/library/metadata/20/children`,
      authed(() =>
        json({
          MediaContainer: {
            Metadata: [{ ratingKey: "30", index: 1, leafCount: eps.length, viewedLeafCount: eps.filter((e) => e.viewCount).length }],
          },
        }),
      ),
    ],
    [`${PLEX_URL}/library/metadata/30/children`, authed(() => json({ MediaContainer: { Metadata: eps } }))],
    // playback of episode 302
    [
      `${PLEX_URL}/library/metadata/302`,
      authed(() => json({ MediaContainer: { Metadata: [{ ratingKey: "302", type: "episode", title: "E2", duration: 1_200_000, viewOffset: 900_000 }] } })),
    ],
    [`${PLEX_URL}/video/:/transcode/universal/decision`, authed(() => json({ MediaContainer: { Metadata: [] } }))],
    [
      `${PLEX_URL}/:/timeline`,
      authed((u) => {
        // Plex marks an episode watched when stopped near the end.
        if (u.searchParams.get("state") === "stopped" && u.searchParams.get("ratingKey") === "302") {
          const e = eps[1]!;
          e.viewCount = 1;
          delete e.viewOffset;
        }
        return new Response("");
      }),
    ],
    [`${PLEX_URL}/video/:/transcode/universal/stop`, authed(() => new Response(""))],
    [`${PLEX_URL}/video/:/transcode/universal/ping`, authed(() => new Response(""))],
    [
      `${TMDB}/tv/200`,
      () =>
        json({
          id: 200,
          name: "Doctor Who",
          first_air_date: "2001-10-02",
          seasons: [{ season_number: 1, name: "Season 1", episode_count: 3, air_date: "2001-10-02" }],
        }),
    ],
    [
      `${TMDB}/tv/200/season/1`,
      () => json({ episodes: [1, 2, 3].map((n) => ({ episode_number: n, name: `E${n}`, air_date: "2001-10-02" })) }),
    ],
  ];
  return routes;
}

async function setup() {
  const plex = new FakePlex();
  const app = makeApp({ SOFARR_TMDB_API_KEY: KEY }, fakeFetch([...fakeLibrary(), ...plex.routes()]));
  const cookie = await signInAdmin(app, plex);
  return { app, cookie };
}

describe("watch state on title pages", () => {
  it("shows per-season watched counts", async () => {
    const { app, cookie } = await setup();
    const d = (await app.inject({ url: "/api/titles/tv/200", headers: { cookie } })).json();
    expect(d.seasons[0]).toMatchObject({ number: 1, inPlex: 3, watched: 1, status: "owned" });
  });

  it("shows watched and in-progress episodes", async () => {
    const { app, cookie } = await setup();
    const r = (await app.inject({ url: "/api/titles/tv/200/seasons/1?numbering=tmdb", headers: { cookie } })).json();
    expect(r.episodes.map((e: Record<string, unknown>) => [e.number, e.plexKey, e.watched, e.progress ?? null])).toEqual([
      [1, "301", true, null],
      [2, "302", false, { percent: 75, remainingMs: 300_000 }],
      [3, "303", false, null],
    ]);
  });

  it("reflects playback immediately (cache dropped when playback stops)", async () => {
    const { app, cookie } = await setup();
    const url = "/api/titles/tv/200/seasons/1?numbering=tmdb";
    expect((await app.inject({ url, headers: { cookie } })).json().episodes[1].watched).toBe(false);

    const caps = { hevc: true, eac3: true, ac3: true };
    const p = (await app.inject({ method: "POST", url: "/api/play", headers: { cookie }, payload: { plexKey: "302", capabilities: caps } })).json();
    await app.inject({ method: "POST", url: `/api/play/${p.id}/progress`, payload: { timeMs: 1_190_000, state: "stopped" } });

    const after = (await app.inject({ url, headers: { cookie } })).json();
    expect(after.episodes[1]).toMatchObject({ watched: true });
    expect(after.episodes[1].progress).toBeUndefined();
    const season = (await app.inject({ url: "/api/titles/tv/200", headers: { cookie } })).json().seasons[0];
    expect(season.watched).toBe(2);
  });
});
