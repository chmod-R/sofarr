import { describe, expect, it } from "vitest";
import { Arr, queueIds } from "../src/catalog/arr.js";
import { TtlCache } from "../src/catalog/cache.js";
import { liveProgress, QBittorrent, type Torrent, toTimeLeft } from "../src/catalog/qbit.js";
import { fakeFetch, type Handler, header, json } from "./helpers.js";

const t = (over: Partial<Torrent>): Torrent => ({
  hash: "aa",
  state: "downloading",
  progress: 0.5,
  size: 1000,
  amount_left: 500,
  dlspeed: 2_000_000,
  eta: 90,
  ...over,
});

describe("liveProgress", () => {
  it("combines a title's torrents", () => {
    expect(
      liveProgress([
        t({ hash: "a", size: 1000, amount_left: 250, dlspeed: 1_000_000, eta: 60 }),
        t({ hash: "b", size: 3000, amount_left: 1500, dlspeed: 2_000_000, eta: 3700 }),
      ]),
    ).toEqual({ percent: 56.3, timeLeft: "01:01:40", state: "downloading", speedBps: 3_000_000 });
  });

  it("reports stalled / queued / paused, without a misleading ETA", () => {
    expect(liveProgress([t({ state: "stalledDL", eta: 8_640_000 })])).toMatchObject({ state: "stalled", timeLeft: null });
    expect(liveProgress([t({ state: "queuedDL" })])).toMatchObject({ state: "queued", timeLeft: null });
    expect(liveProgress([t({ state: "stoppedDL" })])).toMatchObject({ state: "paused" });
  });

  it("defers to *arr once everything has finished downloading (importing etc.)", () => {
    expect(liveProgress([t({ progress: 1, amount_left: 0, state: "uploading" })])).toBeNull();
    expect(liveProgress([])).toBeNull();
  });

  it("formats multi-day ETAs like *arr does", () => {
    expect(toTimeLeft(90061)).toBe("1.01:01:01");
    expect(toTimeLeft(59)).toBe("00:00:59");
  });
});

describe("queueIds", () => {
  it("counts a season pack once even though *arr lists it per episode", () => {
    const ids = queueIds(
      [
        { seriesId: 7, downloadId: "DEB2C888" },
        { seriesId: 7, downloadId: "DEB2C888" },
        { seriesId: 7, downloadId: "ABC" },
        { seriesId: 8 },
      ],
      (r) => r.seriesId,
    );
    expect(ids.get(7)).toEqual(["deb2c888", "abc"]);
    expect(ids.has(8)).toBe(false);
  });
});

describe("QBittorrent client", () => {
  function server() {
    const state = { logins: 0, valid: new Set<string>(), down: false };
    const routes: Record<string, Handler> = {
      "http://qbit:8080/api/v2/auth/login": () => {
        state.logins++;
        const sid = `s${state.logins}`;
        state.valid.add(sid);
        return new Response(null, { status: 204, headers: { "set-cookie": `QBT_SID_8080=${sid}; HttpOnly; path=/` } });
      },
      "http://qbit:8080/api/v2/torrents/info": (_u, init) => {
        if (state.down) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
        const sid = header(init, "cookie")?.split("=")[1];
        return sid && state.valid.has(sid)
          ? json([t({ hash: "DEB2C888", size: 4000, amount_left: 1000, dlspeed: 12_600_000, eta: 180 })])
          : new Response("Forbidden", { status: 403 });
      },
    };
    return { state, fetch: fakeFetch(routes) };
  }

  it("reuses one session and logs in again when it expires", async () => {
    const { state, fetch } = server();
    const cache = new TtlCache();
    const q = new QBittorrent(fetch, { url: "http://qbit:8080", username: "u", password: "p" }, cache, 1000);
    expect((await q.torrents()).get("deb2c888")?.dlspeed).toBe(12_600_000);
    cache.invalidate("qbit:");
    await q.torrents();
    expect(state.logins).toBe(1);

    state.valid.clear(); // qBittorrent restarted / session expired
    cache.invalidate("qbit:");
    await q.torrents();
    expect(state.logins).toBe(2);
  });

  it("overlays live progress onto *arr entries, and falls back when qBittorrent is down", async () => {
    const { state, fetch: qfetch } = server();
    const arrRoutes = fakeFetch({
      "http://sonarr:8989/api/v3/series": () => json([{ id: 7, tmdbId: 62649, tvdbId: 1, monitored: true, seasons: [], statistics: { episodeFileCount: 0 } }]),
      "http://sonarr:8989/api/v3/queue": () =>
        json({
          totalRecords: 2,
          // *arr's own (stale) numbers: 25%
          records: [1, 2].map((ep) => ({ seriesId: 7, seasonNumber: 1, downloadId: "DEB2C888", size: 4000, sizeleft: 3000, timeleft: "00:20:00", trackedDownloadState: "downloading", episodeId: ep })),
        }),
    });
    const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith("http://qbit") ? qfetch(input, init) : arrRoutes(input, init)) as typeof globalThis.fetch;
    const cache = new TtlCache();
    const qbit = new QBittorrent(fetch, { url: "http://qbit:8080", username: "u", password: "p" }, cache, 1000);
    const arr = new Arr(fetch, cache, 1000, undefined, { url: "http://sonarr:8989", apiKey: "k" }, qbit);

    const live = (await arr.entries()).get("tv:62649")!;
    expect(live.download).toMatchObject({ percent: 75, timeLeft: "00:03:00", speedBps: 12_600_000, state: "downloading", seasons: [1] });

    state.down = true;
    cache.invalidate("qbit:");
    const fallback = (await arr.entries()).get("tv:62649")!;
    expect(fallback.download).toMatchObject({ percent: 25, timeLeft: "00:20:00" });
    expect(fallback.download).not.toHaveProperty("speedBps");
  });
});
