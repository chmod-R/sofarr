import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { FetchFn } from "../src/upstreams/http.js";

export type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
export type FakeFetch = FetchFn & { calls: string[] };

/** Routes are matched on `origin + pathname`, exactly or by RegExp. */
export function fakeFetch(routes: Array<[string | RegExp, Handler]> | Record<string, Handler>) {
  const list = Array.isArray(routes) ? routes : Object.entries(routes);
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const key = `${url.origin}${url.pathname}`;
    calls.push(`${init.method ?? "GET"} ${key}`);
    const hit = list.find(([m]) => (typeof m === "string" ? m === key : m.test(key)));
    if (!hit) {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }
    return hit[1](url, init);
  }) as FakeFetch;
  fn.calls = calls;
  return fn;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

export const PLEX_URL = "http://plex:32400";
export const SERVER_ID = "srv-1";

interface FakeUser {
  id: number;
  uuid: string;
  username: string;
  token: string;
  /** Server access token, if this user can reach the server. */
  serverToken?: string;
  owned?: boolean;
  home?: { admin: boolean; pin?: string; restricted?: boolean };
}

/** An in-memory plex.tv + Plex server identity endpoint. */
export class FakePlex {
  users: FakeUser[] = [
    {
      id: 1,
      uuid: "owner-uuid",
      username: "owner",
      token: "owner-token",
      serverToken: "srv-owner",
      owned: true,
      home: { admin: true },
    },
    {
      id: 2,
      uuid: "kid-uuid",
      username: "kid",
      token: "kid-token",
      serverToken: "srv-kid",
      home: { admin: false, pin: "1234" },
    },
    { id: 9, uuid: "friend-uuid", username: "friend", token: "friend-token", serverToken: "srv-friend" },
    { id: 10, uuid: "stranger-uuid", username: "stranger", token: "stranger-token" },
  ];
  pins = new Map<number, { code: string; token: string | null; expired: boolean }>();
  private nextPin = 100;

  /** Simulate the user entering the code at plex.tv/link. */
  link(username: string): void {
    const user = this.users.find((u) => u.username === username)!;
    const pin = [...this.pins.values()].at(-1)!;
    pin.token = user.token;
  }

  private byToken(init: RequestInit) {
    return this.users.find((u) => u.token === header(init, "x-plex-token"));
  }

  routes(): Array<[string | RegExp, Handler]> {
    return [
      [`${PLEX_URL}/identity`, () => json({ MediaContainer: { machineIdentifier: SERVER_ID } })],
      [
        "https://plex.tv/api/v2/pins",
        (_u, init) => {
          if (init.method !== "POST" || !header(init, "x-plex-client-identifier")) {
            return json({}, 400);
          }
          const id = this.nextPin++;
          this.pins.set(id, { code: "AB12", token: null, expired: false });
          return json({
            id,
            code: "AB12",
            qr: "https://plex.tv/api/v2/pins/qr/AB12",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            authToken: null,
          });
        },
      ],
      [
        /^https:\/\/plex\.tv\/api\/v2\/pins\/\d+$/,
        (u) => {
          const id = Number(u.pathname.split("/").at(-1));
          const pin = this.pins.get(id);
          if (!pin || pin.expired) return json({ errors: [] }, 404);
          return json({ id, code: pin.code, expiresAt: new Date().toISOString(), authToken: pin.token });
        },
      ],
      [
        "https://plex.tv/api/v2/user",
        (_u, init) => {
          const user = this.byToken(init);
          return user
            ? json({ id: user.id, uuid: user.uuid, username: user.username, thumb: null })
            : json({}, 401);
        },
      ],
      [
        "https://plex.tv/api/v2/resources",
        (_u, init) => {
          const user = this.byToken(init);
          if (!user) return json({}, 401);
          return json(
            user.serverToken
              ? [
                  {
                    name: "plex-server",
                    clientIdentifier: SERVER_ID,
                    provides: "server",
                    owned: user.owned ?? false,
                    accessToken: user.serverToken,
                  },
                  { name: "phone", clientIdentifier: "x", provides: "client,player", owned: true },
                ]
              : [],
          );
        },
      ],
      [
        "https://plex.tv/api/v2/home/users",
        (_u, init) => {
          const caller = this.byToken(init);
          if (!caller?.home?.admin) return json({}, 401);
          return json({
            users: this.users
              .filter((u) => u.home)
              .map((u) => ({
                id: u.id,
                uuid: u.uuid,
                title: u.username,
                thumb: null,
                admin: u.home!.admin,
                protected: Boolean(u.home!.pin),
                restricted: Boolean(u.home!.restricted),
              })),
          });
        },
      ],
      [
        /^https:\/\/plex\.tv\/api\/v2\/home\/users\/[^/]+\/switch$/,
        (u, init) => {
          const caller = this.byToken(init);
          if (!caller?.home?.admin || init.method !== "POST") return json({}, 401);
          const target = this.users.find((x) => x.uuid === u.pathname.split("/").at(-2));
          if (!target?.home) return json({}, 404);
          if (target.home.pin && u.searchParams.get("pin") !== target.home.pin) {
            return json({ errors: [{ code: 1041 }] }, 403);
          }
          return json({ id: target.id, uuid: target.uuid, authToken: target.token });
        },
      ],
    ];
  }
}

export function makeApp(
  env: Record<string, string> = {},
  fetch: FetchFn = fakeFetch({}),
  now: () => Date = () => new Date("2026-11-08T12:00:00Z"),
  sonarrBudgetMs?: number,
): FastifyInstance {
  const config = loadConfig({ SOFARR_LOG_LEVEL: "silent", SOFARR_PLEX_URL: PLEX_URL, ...env });
  return buildApp(config, {
    fetch,
    db: openDb(":memory:"),
    now,
    ...(sonarrBudgetMs !== undefined && { sonarrBudgetMs }),
  });
}

/** Run the full PIN sign-in as `username`; returns the session cookie header. */
export async function signIn(app: FastifyInstance, plex: FakePlex, username = "owner") {
  const start = await app.inject({ method: "POST", url: "/api/auth/pin" });
  const pending = start.cookies.find((c) => c.name === "sofarr_pending")!;
  plex.link(username);
  const done = await app.inject({
    url: "/api/auth/pin",
    cookies: { sofarr_pending: pending.value },
  });
  const session = done.cookies.find((c) => c.name === "sofarr_session");
  return { res: done, cookie: session ? `sofarr_session=${session.value}` : undefined };
}

/** Sign in as the owner and select the admin profile. */
export async function signInAdmin(app: FastifyInstance, plex: FakePlex) {
  const { cookie } = await signIn(app, plex);
  await app.inject({ url: "/api/profiles", headers: { cookie: cookie! } });
  await app.inject({
    method: "POST",
    url: "/api/profiles/owner-uuid/select",
    headers: { cookie: cookie! },
    payload: {},
  });
  return cookie!;
}
