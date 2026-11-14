import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes, requireAuth } from "./auth/routes.js";
import { Arr } from "./catalog/arr.js";
import { TtlCache } from "./catalog/cache.js";
import { QBittorrent } from "./catalog/qbit.js";
import { PlexServer } from "./catalog/plex.js";
import { ArrClient, RadarrWriter, SonarrWriter } from "./catalog/arrWrite.js";
import { registerRequestRoutes } from "./catalog/requestRoutes.js";
import { registerCatalogRoutes } from "./catalog/routes.js";
import { Tmdb } from "./catalog/tmdb.js";
import { pruneExpired } from "./auth/sessions.js";
import type { Config } from "./config.js";
import { type Db, getSetting, openDb, setSetting } from "./db.js";
import { PlexTv } from "./plex/plextv.js";
import { PlexPlayback } from "./playback/plexPlayback.js";
import { registerPlaybackRoutes } from "./playback/routes.js";
import { checkUpstreams } from "./upstreams/checks.js";
import type { FetchFn } from "./upstreams/http.js";
import { VERSION } from "./version.js";

export interface AppDeps {
  fetch?: FetchFn;
  db?: Db;
  /** Clock override (tests). */
  now?: () => Date;
  /** Title-page wait for Sonarr numbering (tests). */
  sonarrBudgetMs?: number;
}

/** Stable per-install identifier Plex uses to recognise this Sofarr as one device. */
function plexClientId(db: Db): string {
  let id = getSetting(db, "plex_client_id");
  if (!id) {
    id = `sofarr-${randomUUID()}`;
    setSetting(db, "plex_client_id", id);
  }
  return id;
}

export function buildApp(config: Config, deps: AppDeps = {}): FastifyInstance {
  const fetchFn = deps.fetch ?? fetch;
  const db = deps.db ?? openDb(config.dataDir);

  const app = Fastify({
    trustProxy: config.trustProxy,
    logger: {
      level: config.logLevel,
      // Never log credentials that may appear in headers.
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-plex-token"]',
        'res.headers["set-cookie"]',
      ],
    },
  });

  app.register(cookie);

  /**
   * CSRF guard for state-changing requests: a request that carries an Origin
   * (as a web page's would) must come from this host. The app sends none.
   */
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
      return;
    }
    const origin = request.headers.origin;
    if (origin === undefined) return;
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = undefined;
    }
    if (originHost !== request.host) {
      return reply.code(403).send({ error: "cross_origin_request_rejected" });
    }
  });

  /** Liveness: the process is up. Used by the container HEALTHCHECK. */
  app.get("/api/health", async () => ({ status: "ok", version: VERSION }));

  /** Reachability of every configured upstream. No secrets; admin profile only. */
  app.get("/api/health/upstreams", { preHandler: requireAuth(db, "admin") }, async () => ({
    upstreams: await checkUpstreams(config, fetchFn),
  }));

  const clientId = plexClientId(db);
  const plexTv = new PlexTv(fetchFn, clientId, config.upstreamTimeoutMs);
  registerAuthRoutes(app, { config, db, plexTv, fetch: fetchFn });

  if (config.plex) {
    const cache = new TtlCache();
    const t = config.upstreamTimeoutMs;
    const overrides = (c: { qualityProfile?: string; rootFolder?: string }) => ({
      ...(c.qualityProfile && { qualityProfile: c.qualityProfile }),
      ...(c.rootFolder && { rootFolder: c.rootFolder }),
    });
    const catalog = {
      db,
      ...(deps.now && { now: deps.now }),
      plex: new PlexServer(fetchFn, config.plex.url, clientId, cache, t),
      arr: new Arr(
        fetchFn,
        cache,
        t,
        config.radarr,
        config.sonarr,
        config.qbittorrent && new QBittorrent(fetchFn, config.qbittorrent, cache, t),
      ),
      ...(config.tmdb && {
        tmdb: new Tmdb(fetchFn, config.tmdb.apiKey, cache, {
          timeoutMs: t,
          language: config.language,
          region: config.region,
        }),
      }),
    };
    registerCatalogRoutes(app, catalog);
    registerPlaybackRoutes(app, {
      db,
      plex: new PlexPlayback(fetchFn, config.plex.url, { clientId, product: "Sofarr", version: VERSION }, t),
      onWatchStateChanged: () => catalog.plex.invalidate(),
    });
    registerRequestRoutes(app, {
      ...catalog,
      ...(deps.sonarrBudgetMs !== undefined && { sonarrBudgetMs: deps.sonarrBudgetMs }),
      ...(config.radarr && {
        radarr: new RadarrWriter(new ArrClient(fetchFn, config.radarr, cache, t), overrides(config.radarr)),
      }),
      ...(config.sonarr && {
        sonarr: new SonarrWriter(new ArrClient(fetchFn, config.sonarr, cache, t), overrides(config.sonarr)),
      }),
    });
  }

  // Housekeeping: drop expired sessions / pending sign-ins hourly.
  pruneExpired(db);
  const pruner = setInterval(() => pruneExpired(db), 60 * 60 * 1000);
  pruner.unref();
  app.addHook("onClose", async () => {
    clearInterval(pruner);
    if (!deps.db) db.close();
  });

  return app;
}
