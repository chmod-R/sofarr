import { describe, expect, it } from "vitest";
import type { FetchFn } from "../src/upstreams/http.js";
import {
  FakePlex,
  fakeFetch,
  type Handler,
  header,
  json,
  makeApp,
  PLEX_URL,
  signInAdmin,
} from "./helpers.js";

const env = {
  SOFARR_RADARR_URL: "http://radarr:7878",
  SOFARR_RADARR_API_KEY: "radarr-key",
  SOFARR_SONARR_URL: "http://sonarr:8989",
  SOFARR_SONARR_API_KEY: "sonarr-key",
  SOFARR_QBITTORRENT_URL: "http://qbit:8080",
  SOFARR_QBITTORRENT_USERNAME: "admin",
  SOFARR_QBITTORRENT_PASSWORD: "pw",
  SOFARR_TMDB_API_KEY: "0123456789abcdef0123456789abcdef",
};

/** App + signed-in admin cookie; `upstreams` routes are layered over a fake Plex. */
async function setup(upstreams: Record<string, Handler>, extraEnv: Record<string, string> = {}) {
  const plex = new FakePlex();
  const state = { plexDown: false };
  const fetch = fakeFetch([
    [
      `${PLEX_URL}/identity`,
      (u, init) => {
        if (state.plexDown) {
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
        }
        return plex.routes()[0]![1](u, init);
      },
    ],
    ...Object.entries(upstreams),
    ...plex.routes(),
  ]);
  const app = makeApp({ ...env, ...extraEnv }, fetch);
  const cookie = await signInAdmin(app, plex);
  const check = () => app.inject({ url: "/api/health/upstreams", headers: { cookie } });
  return { app, fetch, check, state };
}

describe("GET /api/health", () => {
  it("reports liveness and version without sign-in", async () => {
    const res = await makeApp().inject("/api/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", version: "0.1.0" });
  });
});

describe("GET /api/health/upstreams", () => {
  it("checks every configured upstream with the right credentials", async () => {
    const { check } = await setup({
      "http://radarr:7878/api/v3/system/status": (_u, init) =>
        header(init, "x-api-key") === "radarr-key" ? json({ version: "6.0.0" }) : json({}, 401),
      "http://sonarr:8989/api/v3/system/status": (_u, init) =>
        header(init, "x-api-key") === "sonarr-key" ? json({ version: "4.0.0" }) : json({}, 401),
      "http://qbit:8080/api/v2/auth/login": (_u, init) =>
        String(init.body) === "username=admin&password=pw"
          ? new Response("Ok.", { headers: { "set-cookie": "SID=abc123; HttpOnly; path=/" } })
          : new Response("Fails."),
      "http://qbit:8080/api/v2/app/version": (_u, init) =>
        header(init, "cookie") === "SID=abc123"
          ? new Response("v5.1.0")
          : new Response("Forbidden", { status: 403 }),
      "http://qbit:8080/api/v2/auth/logout": () => new Response(""),
      "https://api.themoviedb.org/3/configuration": (u) =>
        u.searchParams.get("api_key") === env.SOFARR_TMDB_API_KEY ? json({}) : json({}, 401),
    });
    const { upstreams } = (await check()).json();

    expect(upstreams.plex).toMatchObject({ status: "ok" });
    expect(upstreams.radarr).toMatchObject({ status: "ok", version: "6.0.0" });
    expect(upstreams.sonarr).toMatchObject({ status: "ok", version: "4.0.0" });
    expect(upstreams.qbittorrent).toMatchObject({ status: "ok", version: "v5.1.0" });
    expect(upstreams.tmdb).toMatchObject({ status: "ok" });
  });

  it("handles newer qBittorrent login (204 + QBT_SID_<port> cookie) and logs out", async () => {
    const { check, fetch } = await setup({
      "http://qbit:8080/api/v2/auth/login": () =>
        new Response(null, {
          status: 204,
          headers: { "set-cookie": "QBT_SID_8080=xyz/789; HttpOnly; SameSite=Lax; path=/" },
        }),
      "http://qbit:8080/api/v2/app/version": (_u, init) =>
        header(init, "cookie") === "QBT_SID_8080=xyz/789"
          ? new Response("v5.2.0")
          : new Response("Forbidden", { status: 403 }),
      "http://qbit:8080/api/v2/auth/logout": () => new Response(""),
    });
    const { upstreams } = (await check()).json();
    expect(upstreams.qbittorrent).toMatchObject({ status: "ok", version: "v5.2.0" });
    expect(fetch.calls).toContain("POST http://qbit:8080/api/v2/auth/logout");
  });

  it("reports failures without leaking secrets", async () => {
    const { check, state } = await setup({
      "http://radarr:7878/api/v3/system/status": () => json({}, 401),
      "http://qbit:8080/api/v2/auth/login": () => new Response("Fails."),
    });
    state.plexDown = true;
    const res = await check();
    const { upstreams } = res.json();

    expect(upstreams.plex).toMatchObject({ status: "error", error: "unreachable (ECONNREFUSED)" });
    expect(upstreams.radarr).toMatchObject({ status: "error", error: "HTTP 401 (check credentials)" });
    expect(upstreams.qbittorrent).toMatchObject({
      status: "error",
      error: "login rejected (check credentials)",
    });
    for (const secret of ["radarr-key", "sonarr-key", "pw", env.SOFARR_TMDB_API_KEY]) {
      expect(res.body).not.toContain(secret);
    }
  });

  it("marks unconfigured upstreams and doesn't call them", async () => {
    const { check, fetch } = await setup(
      {},
      {
        SOFARR_RADARR_URL: "",
        SOFARR_RADARR_API_KEY: "",
        SOFARR_SONARR_URL: "",
        SOFARR_SONARR_API_KEY: "",
        SOFARR_QBITTORRENT_URL: "",
        SOFARR_TMDB_API_KEY: "",
      },
    );
    const before = fetch.calls.length;
    const { upstreams } = (await check()).json();
    expect(upstreams.plex.status).toBe("ok");
    for (const k of ["radarr", "sonarr", "qbittorrent", "tmdb"]) {
      expect(upstreams[k]).toEqual({ status: "not_configured" });
    }
    expect(fetch.calls.slice(before)).toEqual([`GET ${PLEX_URL}/identity`]);
  });

  it("sends a v4 TMDb token as a bearer header", async () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.e30.sig";
    const { check } = await setup(
      {
        "https://api.themoviedb.org/3/configuration": (u, init) =>
          header(init, "authorization") === `Bearer ${token}` && !u.searchParams.has("api_key")
            ? json({})
            : json({}, 401),
      },
      { SOFARR_TMDB_API_KEY: token },
    );
    expect((await check()).json().upstreams.tmdb.status).toBe("ok");
  });

  it("times out slow upstreams", async () => {
    const hang: Handler = (_u, init) =>
      new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(init.signal?.reason));
      });
    const { check } = await setup(
      { "http://radarr:7878/api/v3/system/status": hang },
      { SOFARR_UPSTREAM_TIMEOUT_MS: "150" },
    );
    expect((await check()).json().upstreams.radarr).toMatchObject({
      status: "error",
      error: "timed out after 150 ms",
    });
  });
});

// Keep the FetchFn type import used (documents the contract the fakes satisfy).
export type { FetchFn };
