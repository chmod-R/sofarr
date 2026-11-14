import { describe, expect, it } from "vitest";
import { FakePlex, fakeFetch, makeApp, signIn, signInAdmin } from "./helpers.js";

function setup() {
  const plex = new FakePlex();
  const fetch = fakeFetch(plex.routes());
  const app = makeApp({}, fetch);
  return { plex, fetch, app };
}

describe("PIN sign-in", () => {
  it("returns a code, waits, then signs the owner in", async () => {
    const { app, plex } = setup();
    const start = await app.inject({ method: "POST", url: "/api/auth/pin" });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({
      code: "AB12",
      linkUrl: "https://plex.tv/link",
      qrUrl: "https://plex.tv/api/v2/pins/qr/AB12",
    });
    const pending = start.cookies.find((c) => c.name === "sofarr_pending")!;
    expect(pending).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/api/auth" });

    const poll = () =>
      app.inject({ url: "/api/auth/pin", cookies: { sofarr_pending: pending.value } });
    expect((await poll()).json()).toEqual({ status: "waiting" });

    plex.link("owner");
    const done = await poll();
    expect(done.json()).toEqual({ status: "signed_in" });
    const session = done.cookies.find((c) => c.name === "sofarr_session")!;
    expect(session).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(session.value).not.toContain("owner-token");

    // Pending login is consumed.
    expect((await poll()).statusCode).toBe(404);

    const me = await app.inject({
      url: "/api/auth/session",
      cookies: { sofarr_session: session.value },
    });
    expect(me.json()).toEqual({
      signedIn: true,
      account: { username: "owner", thumb: null },
      profile: null,
    });
  });

  it("never returns Plex tokens to the browser", async () => {
    const { app, plex } = setup();
    const { res, cookie } = await signIn(app, plex);
    const bodies = [res.body];
    for (const url of ["/api/auth/session", "/api/profiles"]) {
      bodies.push((await app.inject({ url, headers: { cookie: cookie! } })).body);
    }
    bodies.push(
      (
        await app.inject({
          method: "POST",
          url: "/api/profiles/owner-uuid/select",
          headers: { cookie: cookie! },
          payload: {},
        })
      ).body,
    );
    for (const b of bodies) expect(b).not.toMatch(/-token|srv-/);
  });

  it("rejects polling without the browser's pending cookie", async () => {
    const { app } = setup();
    await app.inject({ method: "POST", url: "/api/auth/pin" });
    const res = await app.inject({ url: "/api/auth/pin" });
    expect(res.statusCode).toBe(404);
    const forged = await app.inject({ url: "/api/auth/pin", cookies: { sofarr_pending: "guess" } });
    expect(forged.statusCode).toBe(404);
  });

  it("denies accounts that don't own the server", async () => {
    for (const who of ["friend", "stranger"]) {
      const { app, plex } = setup();
      const { res, cookie } = await signIn(app, plex, who);
      expect(res.statusCode).toBe(403);
      expect(res.json().status).toBe("denied");
      expect(cookie).toBeUndefined();
    }
  });

  it("reports an expired PIN", async () => {
    const { app, plex } = setup();
    const start = await app.inject({ method: "POST", url: "/api/auth/pin" });
    const pending = start.cookies.find((c) => c.name === "sofarr_pending")!;
    for (const p of plex.pins.values()) p.expired = true;
    const res = await app.inject({ url: "/api/auth/pin", cookies: { sofarr_pending: pending.value } });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ status: "expired" });
  });

  it("reports Plex outages as 502", async () => {
    const app = makeApp({}, fakeFetch({}));
    const res = await app.inject({ method: "POST", url: "/api/auth/pin" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "plex_unavailable" });
  });

  it("returns 503 when Plex isn't configured", async () => {
    const app = makeApp({ SOFARR_PLEX_URL: "" });
    expect((await app.inject({ method: "POST", url: "/api/auth/pin" })).statusCode).toBe(503);
  });

  it("logs out", async () => {
    const { app, plex } = setup();
    const { cookie } = await signIn(app, plex);
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: cookie! } });
    expect(out.json()).toEqual({ signedIn: false });
    expect(out.cookies.find((c) => c.name === "sofarr_session")?.value).toBe("");
    const me = await app.inject({ url: "/api/auth/session", headers: { cookie: cookie! } });
    expect(me.statusCode).toBe(401);
  });

  it("rejects cross-origin POSTs", async () => {
    const { app, plex } = setup();
    const { cookie } = await signIn(app, plex);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: cookie!, origin: "http://evil.example", host: "sofarr.lan:5656" },
    });
    expect(res.statusCode).toBe(403);
    const same = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: cookie!, origin: "http://sofarr.lan:5656", host: "sofarr.lan:5656" },
    });
    expect(same.statusCode).toBe(200);
  });
});

describe("profiles", () => {
  async function signedIn() {
    const s = setup();
    const { cookie } = await signIn(s.app, s.plex);
    const list = await s.app.inject({ url: "/api/profiles", headers: { cookie: cookie! } });
    return { ...s, cookie: cookie!, list };
  }

  const select = (app: ReturnType<typeof setup>["app"], cookie: string, uuid: string, payload = {}) =>
    app.inject({ method: "POST", url: `/api/profiles/${uuid}/select`, headers: { cookie }, payload });

  it("lists Plex Home users, admin first", async () => {
    const { list } = await signedIn();
    expect(list.json()).toEqual({
      profiles: [
        { uuid: "owner-uuid", title: "owner", thumb: null, isAdmin: true, isProtected: false },
        { uuid: "kid-uuid", title: "kid", thumb: null, isAdmin: false, isProtected: true },
      ],
    });
  });

  it("selects the owner's own profile without switching", async () => {
    const { app, cookie, fetch } = await signedIn();
    const res = await select(app, cookie, "owner-uuid");
    expect(res.json().profile).toMatchObject({ uuid: "owner-uuid", isAdmin: true });
    expect(fetch.calls.some((c) => c.includes("/switch"))).toBe(false);
    const me = await app.inject({ url: "/api/auth/session", headers: { cookie } });
    expect(me.json().profile.uuid).toBe("owner-uuid");
  });

  it("enforces the PIN on protected profiles via Plex", async () => {
    const { app, cookie } = await signedIn();
    expect((await select(app, cookie, "kid-uuid")).json()).toEqual({ error: "pin_required" });
    expect((await select(app, cookie, "kid-uuid", { pin: "0000" })).json()).toEqual({
      error: "wrong_pin",
    });
    expect((await select(app, cookie, "kid-uuid", { pin: "12a4" })).statusCode).toBe(400);
    const ok = await select(app, cookie, "kid-uuid", { pin: "1234" });
    expect(ok.json().profile).toMatchObject({ uuid: "kid-uuid", isAdmin: false });
  });

  it("enforces the PIN on the owner's own profile too", async () => {
    const { app, cookie, plex, fetch } = await signedIn();
    plex.users[0]!.home!.pin = "4321";
    await app.inject({ url: "/api/profiles", headers: { cookie } }); // Plex now reports it protected
    expect((await select(app, cookie, "owner-uuid")).json()).toEqual({ error: "pin_required" });
    expect((await select(app, cookie, "owner-uuid", { pin: "1111" })).json()).toEqual({ error: "wrong_pin" });
    const me = await app.inject({ url: "/api/auth/session", headers: { cookie } });
    expect(me.json().profile).toBeNull(); // a wrong PIN selects nothing
    const ok = await select(app, cookie, "owner-uuid", { pin: "4321" });
    expect(ok.json().profile).toMatchObject({ uuid: "owner-uuid", isAdmin: true, isProtected: true });
    expect(fetch.calls.filter((c) => c.includes("/owner-uuid/switch"))).toHaveLength(2);
  });

  it("rejects unknown profiles", async () => {
    const { app, cookie } = await signedIn();
    expect((await select(app, cookie, "nope")).statusCode).toBe(404);
  });

  it("requires sign-in", async () => {
    const { app } = setup();
    expect((await app.inject({ url: "/api/profiles" })).statusCode).toBe(401);
  });

  it("can go back to the picker", async () => {
    const { app, cookie } = await signedIn();
    await select(app, cookie, "owner-uuid");
    await app.inject({ method: "POST", url: "/api/profiles/deselect", headers: { cookie } });
    const me = await app.inject({ url: "/api/auth/session", headers: { cookie } });
    expect(me.json().profile).toBeNull();
  });
});

describe("admin-only routes", () => {
  it("/api/health/upstreams requires the admin profile", async () => {
    const { app, plex } = setup();
    expect((await app.inject("/api/health/upstreams")).statusCode).toBe(401);

    const { cookie } = await signIn(app, plex);
    const noProfile = await app.inject({ url: "/api/health/upstreams", headers: { cookie: cookie! } });
    expect(noProfile.json()).toEqual({ error: "no_profile_selected" });

    await app.inject({ url: "/api/profiles", headers: { cookie: cookie! } });
    await app.inject({
      method: "POST",
      url: "/api/profiles/kid-uuid/select",
      headers: { cookie: cookie! },
      payload: { pin: "1234" },
    });
    const kid = await app.inject({ url: "/api/health/upstreams", headers: { cookie: cookie! } });
    expect(kid.json()).toEqual({ error: "admin_only" });

    const admin = await signInAdmin(app, plex);
    const ok = await app.inject({ url: "/api/health/upstreams", headers: { cookie: admin } });
    expect(ok.statusCode).toBe(200);
  });
});
