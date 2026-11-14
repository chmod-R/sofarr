import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { findServer, getServerId, type PlexHomeUser, type PlexTv } from "../plex/plextv.js";
import { UpstreamError } from "../upstreams/http.js";
import {
  createSession,
  deleteSession,
  getSession,
  hashSecret,
  newSecret,
  PENDING_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type SessionRow,
  setSessionProfile,
} from "./sessions.js";

interface AccountRow {
  id: number;
  uuid: string;
  username: string;
  thumb: string | null;
  plex_token: string;
}

export interface ProfileRow {
  uuid: string;
  account_id: number;
  plex_id: number;
  title: string;
  thumb: string | null;
  is_admin: number;
  is_protected: number;
  is_restricted: number;
  plex_token: string | null;
  server_token: string | null;
}

export interface AuthContext {
  session: SessionRow;
  account: AccountRow;
  /** Set once a profile has been selected for this session. */
  profile?: ProfileRow;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

interface AuthDeps {
  config: Config;
  db: Db;
  plexTv: PlexTv;
  fetch: typeof fetch;
}

const publicProfile = (p: ProfileRow) => ({
  uuid: p.uuid,
  title: p.title,
  thumb: p.thumb,
  isAdmin: p.is_admin === 1,
  isProtected: p.is_protected === 1,
});

function cookieOpts(request: FastifyRequest, maxAgeSec: number, path = "/") {
  return {
    path,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: request.protocol === "https",
    maxAge: maxAgeSec,
  };
}

/** Resolve the session cookie (if any) into request.auth. */
export function loadAuth(db: Db, request: FastifyRequest): AuthContext | undefined {
  const cookie = request.cookies[SESSION_COOKIE];
  if (!cookie) return undefined;
  const session = getSession(db, cookie);
  if (!session) return undefined;
  const account = db
    .prepare("SELECT id, uuid, username, thumb, plex_token FROM accounts WHERE id = ?")
    .get(session.account_id) as AccountRow | undefined;
  if (!account) return undefined;
  const ctx: AuthContext = { session, account };
  if (session.profile_uuid) {
    const profile = db
      .prepare("SELECT * FROM profiles WHERE uuid = ? AND account_id = ?")
      .get(session.profile_uuid, account.id) as ProfileRow | undefined;
    if (profile) ctx.profile = profile;
  }
  return ctx;
}

type Need = "session" | "profile" | "admin";

/** preHandler that rejects requests lacking a session / selected profile / admin profile. */
export function requireAuth(db: Db, need: Need): preHandlerHookHandler {
  return async (request, reply) => {
    const auth = loadAuth(db, request);
    if (!auth) return reply.code(401).send({ error: "not_signed_in" });
    if (need !== "session" && !auth.profile) {
      return reply.code(403).send({ error: "no_profile_selected" });
    }
    if (need === "admin" && auth.profile?.is_admin !== 1) {
      return reply.code(403).send({ error: "admin_only" });
    }
    request.auth = auth;
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { config, db, plexTv } = deps;
  const timeoutMs = config.upstreamTimeoutMs;

  let serverIdCache: string | undefined;
  const serverId = async () => {
    if (!config.plex) throw new UpstreamError("Plex is not configured");
    serverIdCache ??= await getServerId(deps.fetch, config.plex.url, timeoutMs);
    return serverIdCache;
  };

  const upstreamFailure = (reply: FastifyReply, err: unknown) => {
    if (!(err instanceof UpstreamError)) throw err;
    app.log.warn({ err: err.message }, "plex upstream error during auth");
    return reply.code(502).send({ error: "plex_unavailable", detail: err.message });
  };

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/auth") || request.url.startsWith("/api/profiles")) {
      if (!config.plex) return reply.code(503).send({ error: "plex_not_configured" });
    }
  });

  // ---- Step 1: get a code to enter at plex.tv/link ----
  app.post("/api/auth/pin", async (request, reply) => {
    try {
      const pin = await plexTv.createPin();
      const { value, hash } = newSecret();
      const expiresAt = Date.parse(pin.expiresAt) || Date.now() + 15 * 60 * 1000;
      db.prepare("INSERT INTO pending_logins (id, pin_id, expires_at) VALUES (?, ?, ?)").run(
        hash,
        pin.id,
        expiresAt,
      );
      const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
      reply.setCookie(PENDING_COOKIE, value, cookieOpts(request, maxAge, "/api/auth"));
      return {
        code: pin.code,
        linkUrl: "https://plex.tv/link",
        qrUrl: pin.qr ?? null,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (err) {
      return upstreamFailure(reply, err);
    }
  });

  // ---- Step 2: poll until the code has been linked ----
  app.get("/api/auth/pin", async (request, reply) => {
    const pendingCookie = request.cookies[PENDING_COOKIE];
    const pending = pendingCookie
      ? (db
          .prepare("SELECT id, pin_id, expires_at FROM pending_logins WHERE id = ?")
          .get(hashSecret(pendingCookie)) as
          | { id: string; pin_id: number; expires_at: number }
          | undefined)
      : undefined;
    if (!pending) return reply.code(404).send({ status: "no_pending_login" });

    const finish = () => {
      db.prepare("DELETE FROM pending_logins WHERE id = ?").run(pending.id);
      reply.clearCookie(PENDING_COOKIE, { path: "/api/auth" });
    };

    try {
      const pin = pending.expires_at > Date.now() ? await plexTv.checkPin(pending.pin_id) : null;
      if (!pin) {
        finish();
        return reply.code(410).send({ status: "expired" });
      }
      if (!pin.authToken) return { status: "waiting" };

      const token = pin.authToken;
      const [user, resources, id] = await Promise.all([
        plexTv.getUser(token),
        plexTv.getResources(token),
        serverId(),
      ]);
      const server = findServer(resources, id);
      if (!server?.owned) {
        finish();
        app.log.warn({ plexUser: user.username }, "sign-in denied: not the server owner");
        return reply.code(403).send({
          status: "denied",
          reason: "Only the owner of this Plex server can sign in to this version of Sofarr.",
        });
      }

      const now = Date.now();
      db.prepare(
        `INSERT INTO accounts (id, uuid, username, thumb, plex_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET uuid = excluded.uuid, username = excluded.username,
           thumb = excluded.thumb, plex_token = excluded.plex_token, updated_at = excluded.updated_at`,
      ).run(user.id, user.uuid, user.username, user.thumb ?? null, token, now, now);

      finish();
      const session = createSession(db, user.id, now);
      reply.setCookie(SESSION_COOKIE, session, cookieOpts(request, SESSION_TTL_MS / 1000));
      app.log.info({ plexUser: user.username }, "signed in");
      return { status: "signed_in" };
    } catch (err) {
      return upstreamFailure(reply, err);
    }
  });

  app.get("/api/auth/session", async (request, reply) => {
    const auth = loadAuth(db, request);
    if (!auth) return reply.code(401).send({ signedIn: false });
    return {
      signedIn: true,
      account: { username: auth.account.username, thumb: auth.account.thumb },
      profile: auth.profile ? publicProfile(auth.profile) : null,
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const auth = loadAuth(db, request);
    if (auth) deleteSession(db, auth.session.id);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { signedIn: false };
  });

  // ---- Profiles (Plex Home users) ----
  const syncProfiles = (accountId: number, users: PlexHomeUser[]) => {
    const now = Date.now();
    const upsert = db.prepare(
      `INSERT INTO profiles (uuid, account_id, plex_id, title, thumb, is_admin, is_protected,
                             is_restricted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET account_id = excluded.account_id, plex_id = excluded.plex_id,
         title = excluded.title, thumb = excluded.thumb, is_admin = excluded.is_admin,
         is_protected = excluded.is_protected, is_restricted = excluded.is_restricted,
         updated_at = excluded.updated_at`,
    );
    db.exec("BEGIN");
    try {
      for (const u of users) {
        upsert.run(
          u.uuid,
          accountId,
          u.id,
          u.title,
          u.thumb ?? null,
          u.admin ? 1 : 0,
          u.protected ? 1 : 0,
          u.restricted ? 1 : 0,
          now,
        );
      }
      // Drop profiles that left the Plex Home.
      const keep = users.map((u) => u.uuid);
      db.prepare(
        `DELETE FROM profiles WHERE account_id = ? AND uuid NOT IN (${keep.map(() => "?").join(",") || "''"})`,
      ).run(accountId, ...keep);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };

  app.get("/api/profiles", { preHandler: requireAuth(db, "session") }, async (request, reply) => {
    const { account } = request.auth!;
    try {
      const users = await plexTv.getHomeUsers(account.plex_token);
      syncProfiles(account.id, users);
      const rows = db
        .prepare("SELECT * FROM profiles WHERE account_id = ? ORDER BY is_admin DESC, title")
        .all(account.id) as unknown as ProfileRow[];
      return { profiles: rows.map(publicProfile) };
    } catch (err) {
      return upstreamFailure(reply, err);
    }
  });

  const selectBody = z.object({ pin: z.string().regex(/^\d{4}$/).optional() }).strict();

  app.post<{ Params: { uuid: string } }>(
    "/api/profiles/:uuid/select",
    { preHandler: requireAuth(db, "session") },
    async (request, reply) => {
      const { account, session } = request.auth!;
      const body = selectBody.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid_pin_format" });

      const profile = db
        .prepare("SELECT * FROM profiles WHERE uuid = ? AND account_id = ?")
        .get(request.params.uuid, account.id) as ProfileRow | undefined;
      if (!profile) return reply.code(404).send({ error: "unknown_profile" });

      try {
        // The account's own profile uses the account token; others are switched via
        // Plex, which also enforces the profile PIN.
        let token: string | null = account.plex_token;
        if (profile.is_protected && !body.data.pin) {
          return reply.code(401).send({ error: "pin_required" });
        }
        if (profile.plex_id !== account.id) {
          token = await plexTv.switchHomeUser(account.plex_token, profile.uuid, body.data.pin);
          if (!token) return reply.code(403).send({ error: "wrong_pin" });
        } else if (profile.is_protected) {
          // The owner's own profile has a PIN too: have Plex check it the same way (switching
          // to that profile), but keep using the account's token.
          const checked = await plexTv.switchHomeUser(account.plex_token, profile.uuid, body.data.pin);
          if (!checked) return reply.code(403).send({ error: "wrong_pin" });
        }

        const server = findServer(await plexTv.getResources(token), await serverId());
        if (!server?.accessToken) {
          return reply.code(403).send({ error: "profile_has_no_server_access" });
        }
        db.prepare(
          "UPDATE profiles SET plex_token = ?, server_token = ?, updated_at = ? WHERE uuid = ?",
        ).run(token, server.accessToken, Date.now(), profile.uuid);
        setSessionProfile(db, session.id, profile.uuid);
        return { profile: publicProfile(profile) };
      } catch (err) {
        return upstreamFailure(reply, err);
      }
    },
  );

  /** Go back to the profile picker without signing out. */
  app.post("/api/profiles/deselect", { preHandler: requireAuth(db, "session") }, async (request) => {
    setSessionProfile(db, request.auth!.session.id, null);
    return { profile: null };
  });
}
