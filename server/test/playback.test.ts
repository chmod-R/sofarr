import { describe, expect, it } from "vitest";
import { chooseProfile } from "../src/playback/plexPlayback.js";
import { FakePlex, fakeFetch, type Handler, header, json, makeApp, PLEX_URL, signIn, signInAdmin } from "./helpers.js";

const SAFARI = { nativeHls: true, hevc: true, hevcMain10: true, eac3: true, ac3: true };
const CHROME = { nativeHls: false, hevc: false, hevcMain10: false, eac3: false, ac3: false };

describe("chooseProfile", () => {
  it("uses Plex's iOS profile for Safari-class browsers (copies 10-bit HEVC + E-AC3)", () => {
    expect(chooseProfile(SAFARI)).toMatchObject({ platform: "Safari", profileName: "iOS", container: "mp4" });
    expect(chooseProfile(SAFARI).extra).toContain("videoCodec=h264,hevc&audioCodec=aac,ac3,eac3");
  });
  it("falls back to fMP4 for hls.js, offering HEVC only when MediaSource can decode it", () => {
    const c = chooseProfile(CHROME);
    expect(c).toMatchObject({ platform: "Chrome", container: "mp4" });
    expect(c.profileName).toBeUndefined();
    expect(c.extra).toContain("videoCodec=h264&audioCodec=aac&");
    expect(chooseProfile({ ...CHROME, hevc: true }).extra).toContain("videoCodec=h264,hevc");
    // Native HLS without Main 10 (e.g. older Mac): Safari profile, not iOS.
    expect(chooseProfile({ ...SAFARI, hevcMain10: false }).profileName).toBeUndefined();
  });
});

/** Fake Plex playback endpoints. Records transcoder/timeline calls. */
class FakeStream {
  calls: Array<{ path: string; params: URLSearchParams; headers: Headers }> = [];
  emptyFirstSegment = false;
  items: Record<string, Record<string, unknown>> = {
    "10": {
      ratingKey: "10",
      type: "movie",
      title: "The Matrix",
      duration: 8_000_000,
      viewOffset: 1_200_000,
      Media: [
        {
          Part: [
            {
              id: 55,
              Stream: [
                { id: 1, streamType: 1, codec: "hevc" },
                { id: 2, streamType: 2, codec: "eac3", languageTag: "en", extendedDisplayTitle: "English (EAC3 5.1)", selected: true },
                { id: 3, streamType: 2, codec: "aac", languageTag: "fr", extendedDisplayTitle: "Français (AAC Stereo)" },
                { id: 4, streamType: 3, codec: "srt", languageTag: "en", extendedDisplayTitle: "English (SRT)" },
                { id: 5, streamType: 3, codec: "pgs", languageTag: "en", extendedDisplayTitle: "English Forced (PGS)", forced: true },
                { id: 6, streamType: 3, codec: "eia_608", extendedDisplayTitle: "CC" },
              ],
            },
          ],
        },
      ],
    },
    "11": { ratingKey: "11", type: "movie", title: "Almost Done", duration: 1_000_000, viewOffset: 990_000 },
    "20": {
      ratingKey: "20",
      type: "show",
      title: "Doctor Who",
      OnDeck: { Metadata: { ratingKey: "22", type: "episode" } },
    },
    "21": { ratingKey: "21", type: "episode", title: "Pilot", grandparentTitle: "Doctor Who", parentIndex: 1, index: 1, parentRatingKey: "30", grandparentRatingKey: "20", duration: 1_300_000 },
    "22": { ratingKey: "22", type: "episode", title: "Episode Two", grandparentTitle: "Doctor Who", parentIndex: 1, index: 2, parentRatingKey: "30", grandparentRatingKey: "20", duration: 1_300_000, viewOffset: 60_000 },
    "23": { ratingKey: "23", type: "episode", title: "New Season", grandparentTitle: "Doctor Who", parentIndex: 2, index: 1, parentRatingKey: "31", grandparentRatingKey: "20", duration: 1_300_000 },
  };
  children: Record<string, string[]> = { "20": ["30", "31"], "30": ["21", "22"], "31": ["23"] };
  seasons: Record<string, Record<string, unknown>> = {
    "30": { ratingKey: "30", type: "season", index: 1 },
    "31": { ratingKey: "31", type: "season", index: 2 },
  };

  partSelections: Array<Record<string, string>> = [];

  routes(token: string): Array<[string | RegExp, Handler]> {
    const authed = (h: Handler): Handler => (u, init) => (header(init, "x-plex-token") === token ? h(u, init) : json({}, 401));
    const log = (u: URL, init: RequestInit) =>
      this.calls.push({ path: u.pathname, params: u.searchParams, headers: new Headers(init.headers) });
    return [
      [
        /^http:\/\/plex:32400\/library\/metadata\/\d+\/children$/,
        authed((u) => {
          const k = u.pathname.split("/").at(-2)!;
          return json({ MediaContainer: { Metadata: (this.children[k] ?? []).map((c) => this.items[c] ?? this.seasons[c]) } });
        }),
      ],
      [
        /^http:\/\/plex:32400\/library\/metadata\/\d+$/,
        authed((u) => {
          const it = this.items[u.pathname.split("/").at(-1)!];
          return it ? json({ MediaContainer: { Metadata: [it] } }) : json({}, 404);
        }),
      ],
      [
        `${PLEX_URL}/video/:/transcode/universal/decision`,
        authed((u, init) => {
          log(u, init);
          return json({ MediaContainer: { generalDecisionText: "ok", Metadata: [{ Media: [{ Part: [{ Stream: [{ streamType: 1, decision: "copy" }, { streamType: 2, decision: "copy" }] }] }] }] } });
        }),
      ],
      [
        `${PLEX_URL}/video/:/transcode/universal/start.m3u8`,
        authed((u, init) => {
          log(u, init);
          const s = u.searchParams.get("session");
          return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nsession/${s}/base/index.m3u8\n`, {
            headers: { "content-type": "application/vnd.apple.mpegurl" },
          });
        }),
      ],
      [
        /^http:\/\/plex:32400\/video\/:\/transcode\/universal\/session\/[^/]+\/base\/[^/]+$/,
        authed((u, init) => {
          log(u, init);
          const file = u.pathname.split("/").at(-1)!;
          if (file === "index.m3u8") {
            // Like real Plex: gzipped playlist whose Content-Length is the compressed size.
            // (fetch() would hand us the decompressed body; the fake hands it over directly.)
            return new Response('#EXTM3U\n#EXT-X-MAP:URI="header"\n#EXTINF:10,\n00000.ts\n#EXT-X-ENDLIST\n', {
              headers: { "content-type": "application/vnd.apple.mpegurl", "content-encoding": "gzip", "content-length": "17" },
            });
          }
          if (file === "00000.ts" && this.emptyFirstSegment) {
            this.emptyFirstSegment = false;
            return new Response(new Uint8Array(0), { headers: { "content-length": "0" } });
          }
          const bytes = new Uint8Array(file === "header" ? [0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70] : [1, 2, 3, 4, 5]);
          return new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) } });
        }),
      ],
      [`${PLEX_URL}/:/timeline`, authed((u, init) => (log(u, init), new Response("")))],
      [
        /^http:\/\/plex:32400\/library\/parts\/\d+$/,
        authed((u, init) => {
          if (init.method !== "PUT") return json({}, 405);
          this.partSelections.push(Object.fromEntries(u.searchParams));
          // Like Plex: remember the choice on the part's streams.
          const streams = (this.items["10"]!.Media as Array<{ Part: Array<{ Stream: Array<Record<string, unknown>> }> }>)[0]!.Part[0]!.Stream;
          for (const [param, type] of [["audioStreamID", 2], ["subtitleStreamID", 3]] as const) {
            const v = u.searchParams.get(param);
            if (v === null) continue;
            for (const st of streams) if (st.streamType === type) st.selected = String(st.id) === v;
          }
          return new Response("");
        }),
      ],
      [`${PLEX_URL}/video/:/transcode/universal/ping`, authed((u, init) => (log(u, init), new Response("")))],
      [`${PLEX_URL}/video/:/transcode/universal/stop`, authed((u, init) => (log(u, init), new Response("")))],
    ];
  }
}

async function setup() {
  const plex = new FakePlex();
  const stream = new FakeStream();
  const app = makeApp({}, fakeFetch([...stream.routes("srv-owner"), ...plex.routes()]));
  const cookie = await signInAdmin(app, plex);
  const play = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/play", headers: { cookie }, payload: { capabilities: SAFARI, ...payload } });
  return { app, cookie, stream, play, plex };
}

describe("POST /api/play", () => {
  it("starts a movie where Plex says to resume, with the browser-appropriate profile", async () => {
    const { play, stream } = await setup();
    const res = await play({ plexKey: "10" });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p).toMatchObject({ title: "The Matrix", subtitle: null, durationMs: 8_000_000, startMs: 1_200_000, decision: { video: "copy", audio: "copy" }, next: null });
    expect(p.src).toBe(`/api/play/${p.id}/start.m3u8`);
    expect(p.id.length).toBeGreaterThanOrEqual(32);
    const d = stream.calls.find((c) => c.path.endsWith("/decision"))!;
    expect(d.params.get("offset")).toBe("1200");
    expect(d.params.get("path")).toBe("/library/metadata/10");
    expect(d.headers.get("x-plex-client-profile-name")).toBe("iOS");
    expect(d.headers.get("x-plex-product")).toBe("Sofarr");
  });

  it("restarts from the beginning when the resume point is in the last 5%, or when asked", async () => {
    const { play } = await setup();
    expect((await play({ plexKey: "11" })).json().startMs).toBe(0);
    expect((await play({ plexKey: "10", offsetMs: 0 })).json().startMs).toBe(0);
  });

  it("plays a show's next-up episode, and knows the next episode across seasons", async () => {
    const { play } = await setup();
    const p = (await play({ plexKey: "20" })).json();
    expect(p).toMatchObject({ ratingKey: "22", title: "Doctor Who", subtitle: "S1 · E2 · Episode Two", startMs: 60_000 });
    expect(p.next).toEqual({ plexKey: "23", title: "Doctor Who", subtitle: "S2 · E1 · New Season" });
    expect((await play({ plexKey: "21" })).json().next.plexKey).toBe("22");
  });

  it("validates input and requires a profile", async () => {
    const { play, app, plex } = await setup();
    expect((await play({ plexKey: "../x" })).statusCode).toBe(400);
    expect((await play({ plexKey: "99" })).statusCode).toBe(404);
    const bare = await app.inject({ method: "POST", url: "/api/play", payload: { plexKey: "10", capabilities: SAFARI } });
    expect(bare.statusCode).toBe(401);
    const { cookie } = await signIn(app, plex);
    const noProfile = await app.inject({ method: "POST", url: "/api/play", headers: { cookie: cookie! }, payload: { plexKey: "10", capabilities: SAFARI } });
    expect(noProfile.json()).toEqual({ error: "no_profile_selected" });
  });
});

describe("stream proxy", () => {
  it("proxies playlists and segments with correct content types, never exposing the token", async () => {
    const { play, app, stream } = await setup();
    const p = (await play({ plexKey: "10" })).json();
    const master = await app.inject({ url: p.src }); // no cookie: the id is the capability
    expect(master.statusCode).toBe(200);
    expect(master.headers["content-type"]).toBe("application/vnd.apple.mpegurl");
    expect(master.body).not.toContain("srv-owner");
    const variant = master.body.split("\n").find((l) => l.startsWith("session/"))!;
    const base = p.src.replace("start.m3u8", "");
    const idx = await app.inject({ url: base + variant });
    expect(idx.headers["content-type"]).toBe("application/vnd.apple.mpegurl");
    // Never forward a compressed Content-Length for a decompressed body (browsers hang waiting).
    expect(idx.headers["content-length"]).not.toBe("17");
    expect(idx.body).toContain("#EXT-X-ENDLIST");
    const dir = base + variant.replace("index.m3u8", "");
    const init = await app.inject({ url: `${dir}header` });
    expect(init.headers["content-type"]).toBe("video/mp4");
    expect([...init.rawPayload.subarray(4, 8)]).toEqual([0x66, 0x74, 0x79, 0x70]);
    const seg = await app.inject({ url: `${dir}00000.ts` });
    expect(seg.headers["content-type"]).toBe("video/mp4");
    expect(seg.headers["content-length"]).toBe("5"); // unencoded: forwarded
    expect(seg.headers["cache-control"]).toBe("no-store");
    expect([...seg.rawPayload]).toEqual([1, 2, 3, 4, 5]);
    // The token went to Plex in a header, never in the URL.
    expect(stream.calls.every((c) => !c.params.toString().includes("srv-owner"))).toBe(true);
  });

  it("retries a segment Plex answers with an empty 200", async () => {
    const { play, app, stream } = await setup();
    const p = (await play({ plexKey: "10" })).json();
    stream.emptyFirstSegment = true;
    const master = await app.inject({ url: p.src });
    const dir = p.src.replace("start.m3u8", "") + master.body.split("\n").find((l) => l.startsWith("session/"))!.replace("index.m3u8", "");
    const seg = await app.inject({ url: `${dir}00000.ts` });
    expect([...seg.rawPayload]).toEqual([1, 2, 3, 4, 5]);
    expect(stream.calls.filter((c) => c.path.endsWith("/00000.ts"))).toHaveLength(2);
  });

  it("refuses unknown sessions, other Plex sessions and odd file names", async () => {
    const { play, app } = await setup();
    const p = (await play({ plexKey: "10" })).json();
    const base = p.src.replace("start.m3u8", "");
    expect((await app.inject({ url: "/api/play/nope/start.m3u8" })).statusCode).toBe(404);
    expect((await app.inject({ url: `${base}session/sofarr-someone-else/base/00000.ts` })).statusCode).toBe(404);
    expect((await app.inject({ url: `${base}session/x/base/..%2F..%2Fprefs` })).statusCode).toBe(404);
  });
});

describe("progress", () => {
  it("reports position to Plex, pings while playing, and stops the transcoder on stop", async () => {
    const { play, app, stream } = await setup();
    const p = (await play({ plexKey: "10" })).json();
    const progress = (payload: object) => app.inject({ method: "POST", url: `/api/play/${p.id}/progress`, payload });

    expect((await progress({ timeMs: 1_234_567, state: "playing" })).json()).toEqual({ ok: true });
    const tl = stream.calls.find((c) => c.path === "/:/timeline")!;
    expect(Object.fromEntries(tl.params)).toMatchObject({ ratingKey: "10", state: "playing", time: "1234567", duration: "8000000" });
    expect(tl.headers.get("x-plex-session-identifier")).toMatch(/^sofarr-/);
    expect(stream.calls.some((c) => c.path.endsWith("/ping"))).toBe(true);

    expect((await progress({ timeMs: 2_000_000, state: "stopped" })).statusCode).toBe(200);
    expect(stream.calls.some((c) => c.path.endsWith("/stop"))).toBe(true);
    expect((await app.inject({ url: p.src })).statusCode).toBe(404);
    expect((await progress({ timeMs: 1, state: "playing" })).statusCode).toBe(404);
    expect((await progress({ timeMs: -5, state: "playing" })).statusCode).toBe(404);
  });

  it("validates progress reports", async () => {
    const { play, app } = await setup();
    const p = (await play({ plexKey: "10" })).json();
    const bad = await app.inject({ method: "POST", url: `/api/play/${p.id}/progress`, payload: { timeMs: 5, state: "rewinding" } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("audio and subtitle tracks", () => {
  it("lists tracks with the current selection; image subtitles flagged, 608 captions left out", async () => {
    const { play } = await setup();
    const p = (await play({ plexKey: "10" })).json();
    expect(p.tracks).toEqual({
      partId: 55,
      audio: [
        { id: 2, label: "English (EAC3 5.1)", language: "en", selected: true },
        { id: 3, label: "Français (AAC Stereo)", language: "fr", selected: false },
      ],
      subtitles: [
        { id: 4, label: "English (SRT)", language: "en", selected: false, forced: false, kind: "text" },
        { id: 5, label: "English Forced (PGS)", language: "en", selected: false, forced: true, kind: "image" },
      ],
    });
  });

  it("saves the choice to Plex and restarts the stream at the current position", async () => {
    const { play, app, stream } = await setup();
    const p = (await play({ plexKey: "10" })).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/play/${p.id}/tracks`,
      payload: { audioStreamId: 3, subtitleStreamId: 4, timeMs: 1_500_000 },
    });
    expect(res.statusCode).toBe(200);
    const n = res.json();
    expect(stream.partSelections).toEqual([{ audioStreamID: "3", subtitleStreamID: "4", allParts: "1" }]);
    expect(n.id).not.toBe(p.id);
    expect(n.startMs).toBe(1_500_000);
    expect(n.tracks.audio.find((a: { selected: boolean }) => a.selected).id).toBe(3);
    expect(n.tracks.subtitles.find((x: { selected: boolean }) => x.selected).id).toBe(4);
    // The old stream is gone: Plex told where we were, transcoder stopped, URL dead.
    expect(stream.calls.some((c) => c.path === "/:/timeline" && c.params.get("time") === "1500000")).toBe(true);
    expect(stream.calls.some((c) => c.path.endsWith("/stop"))).toBe(true);
    expect((await app.inject({ url: p.src })).statusCode).toBe(404);
    expect((await app.inject({ url: n.src })).statusCode).toBe(200);
  });

  it("turns subtitles off with 0, and rejects unknown tracks", async () => {
    const { play, app, stream } = await setup();
    const p = (await play({ plexKey: "10" })).json();
    const post = (payload: object, id = p.id) => app.inject({ method: "POST", url: `/api/play/${id}/tracks`, payload });
    expect((await post({ audioStreamId: 99, timeMs: 0 })).json()).toEqual({ error: "unknown_audio_track" });
    expect((await post({ subtitleStreamId: 6, timeMs: 0 })).json()).toEqual({ error: "unknown_subtitle_track" }); // 608: not selectable
    expect((await post({ timeMs: 0 })).statusCode).toBe(400);
    expect(stream.partSelections).toEqual([]);
    const off = (await post({ subtitleStreamId: 0, timeMs: 10 })).json();
    expect(stream.partSelections).toEqual([{ subtitleStreamID: "0", allParts: "1" }]);
    expect(off.tracks.subtitles.every((x: { selected: boolean }) => !x.selected)).toBe(true);
  });
});
