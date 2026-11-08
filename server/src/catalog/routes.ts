import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/routes.js";
import type { Db } from "../db.js";
import { UpstreamError } from "../upstreams/http.js";
import type { Arr } from "./arr.js";
import { buildHome } from "./home.js";
import { search } from "./search.js";
import { PLEX_IMAGE_PATH, type PlexServer } from "./plex.js";
import type { Tmdb } from "./tmdb.js";

interface CatalogDeps {
  db: Db;
  plex: PlexServer;
  arr: Arr;
  tmdb?: Tmdb;
  now?: () => Date;
}

const searchQuery = z.object({ q: z.string().trim().min(1).max(100) });

const imageQuery = z.object({
  path: z.string().regex(PLEX_IMAGE_PATH),
  w: z.coerce.number().int().min(32).max(1920).default(342),
  h: z.coerce.number().int().min(32).max(1920).default(513),
});

export function registerCatalogRoutes(app: FastifyInstance, deps: CatalogDeps): void {
  const needProfile = requireAuth(deps.db, "profile");

  app.get("/api/home", { preHandler: needProfile }, async (request, reply) => {
    const token = request.auth!.profile!.server_token;
    if (!token) return reply.code(409).send({ error: "profile_not_ready" });
    const result = await buildHome(deps, token);
    for (const w of result.warnings) request.log.warn({ source: w }, "home row source failed");
    return result;
  });

  app.get("/api/search", { preHandler: needProfile }, async (request, reply) => {
    const q = searchQuery.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    if (!deps.tmdb) return reply.code(503).send({ error: "tmdb_not_configured" });
    const token = request.auth!.profile!.server_token;
    if (!token) return reply.code(409).send({ error: "profile_not_ready" });
    try {
      return { query: q.data.q, ...(await search({ ...deps, tmdb: deps.tmdb }, token, q.data.q)) };
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      return reply.code(502).send({ error: "search_unavailable", detail: err.message });
    }
  });

  app.get("/api/plex/image", { preHandler: needProfile }, async (request, reply) => {
    const q = imageQuery.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_image_request" });
    const token = request.auth!.profile!.server_token;
    if (!token) return reply.code(409).send({ error: "profile_not_ready" });
    try {
      const res = await deps.plex.image(token, q.data.path, q.data.w, q.data.h);
      if (!res.ok) return reply.code(res.status === 404 ? 404 : 502).send();
      return reply
        .header("content-type", res.headers.get("content-type") ?? "image/jpeg")
        .header("cache-control", "private, max-age=86400")
        .send(Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      if (err instanceof UpstreamError || (err as Error)?.name === "TimeoutError") {
        return reply.code(504).send();
      }
      return reply.code(502).send();
    }
  });
}
