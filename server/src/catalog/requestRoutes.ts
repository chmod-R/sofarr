import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/routes.js";
import type { Db } from "../db.js";
import { UpstreamError } from "../upstreams/http.js";
import type { Arr } from "./arr.js";
import type { RadarrWriter, SonarrWriter } from "./arrWrite.js";
import { mapSeasons } from "./seasonMap.js";
import { buildDetail } from "./detail.js";
import { buildEpisodes } from "./episodes.js";
import type { PlexServer } from "./plex.js";
import type { Tmdb } from "./tmdb.js";

interface RequestDeps {
  db: Db;
  plex: PlexServer;
  arr: Arr;
  tmdb?: Tmdb;
  radarr?: RadarrWriter;
  sonarr?: SonarrWriter;
  now?: () => Date;
  sonarrBudgetMs?: number;
}

const titleParams = z.object({
  mediaType: z.enum(["movie", "tv"]),
  tmdbId: z.coerce.number().int().positive(),
});

const requestBody = z.discriminatedUnion("mediaType", [
  z.object({ mediaType: z.literal("movie"), tmdbId: z.number().int().positive() }).strict(),
  z
    .object({
      mediaType: z.literal("tv"),
      tmdbId: z.number().int().positive(),
      seasons: z.array(z.number().int().min(1).max(500)).min(1).max(100),
      /** Which numbering `seasons` uses: the title page's `seasonNumbering` ("tmdb" or Sonarr's). */
      seasonNumbering: z.enum(["sonarr", "tmdb"]),
      /** Specific episodes of the (single) season instead of the whole season. */
      episodes: z.array(z.number().int().min(1).max(5000)).min(1).max(500).optional(),
    })
    .strict()
    .refine((b) => !b.episodes || b.seasons.length === 1, { message: "episodes need exactly one season" }),
]);

const episodesQuery = z.object({ numbering: z.enum(["sonarr", "tmdb"]).default("sonarr") });
const episodesParams = z.object({
  tmdbId: z.coerce.number().int().positive(),
  season: z.coerce.number().int().min(1).max(500),
});

const seasonsField = (v: number[] | { season: number; episodes: number[] }) =>
  Array.isArray(v) ? { seasons: v } : { seasons: [v.season], episodes: v.episodes };

/** Translate TMDb season numbers to Sonarr's; null if the two can't be aligned. */
async function toSonarrNumbers(tmdb: Tmdb, sonarr: SonarrWriter, tmdbId: number, seasons: number[]) {
  const full = await tmdb.fullDetails("tv", tmdbId);
  const series = await sonarr.seriesInfo(tmdbId, full.tvdbId);
  if (!series) throw new UpstreamError("Sonarr couldn't find that series");
  const m = mapSeasons(
    { seasons: full.seasons.map((s) => s.number), firstAirDate: full.date, lastAirDate: full.lastAirDate },
    {
      seasons: series.seasons.map((s) => s.seasonNumber),
      firstAired: series.firstAired,
      lastAired: series.lastAired,
    },
  );
  if (m.kind === "sonarr-only") return null;
  const offset = m.kind === "offset" ? m.offset : 0;
  return seasons.map((n) => n + offset);
}

export function registerRequestRoutes(app: FastifyInstance, deps: RequestDeps): void {
  const needProfile = requireAuth(deps.db, "profile");

  const upstream = (reply: FastifyReply, err: unknown, source: string) => {
    if (!(err instanceof UpstreamError)) throw err;
    app.log.warn({ source, err: err.message }, "upstream error");
    return reply.code(502).send({ error: "upstream_failed", source, detail: err.message });
  };

  /** Title page: details, trailer, status, and per-season status for shows. */
  app.get("/api/titles/:mediaType/:tmdbId", { preHandler: needProfile }, async (request, reply) => {
    const p = titleParams.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_title" });
    if (!deps.tmdb) return reply.code(503).send({ error: "tmdb_not_configured" });
    const token = request.auth!.profile!.server_token;
    if (!token) return reply.code(409).send({ error: "profile_not_ready" });
    try {
      return await buildDetail({ ...deps, tmdb: deps.tmdb }, token, p.data.mediaType, p.data.tmdbId);
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) {
        return reply.code(404).send({ error: "unknown_title" });
      }
      return upstream(reply, err, "catalog");
    }
  });

  /** One season's episodes, with per-episode status. */
  app.get("/api/titles/tv/:tmdbId/seasons/:season", { preHandler: needProfile }, async (request, reply) => {
    const p = episodesParams.safeParse(request.params);
    const q = episodesQuery.safeParse(request.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: "invalid_season" });
    if (!deps.tmdb) return reply.code(503).send({ error: "tmdb_not_configured" });
    const token = request.auth!.profile!.server_token;
    if (!token) return reply.code(409).send({ error: "profile_not_ready" });
    try {
      const lib = await deps.plex.library(token);
      return await buildEpisodes(
        { ...deps, tmdb: deps.tmdb },
        token,
        lib.byTmdb.get(`tv:${p.data.tmdbId}`)?.ratingKey,
        p.data.tmdbId,
        p.data.season,
        q.data.numbering,
      );
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) return reply.code(404).send({ error: "unknown_season" });
      return upstream(reply, err, "catalog");
    }
  });

  /** "Get it": add/monitor in Radarr or Sonarr and start searching. */
  app.post("/api/requests", { preHandler: needProfile }, async (request, reply) => {
    const profile = request.auth!.profile!;
    if (profile.is_restricted === 1) return reply.code(403).send({ error: "restricted_profile" });

    const body = requestBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const r = body.data;

    let outcome: { result: "added" | "searching" | "already_have"; arrId: number; seasons?: number[] };
    try {
      if (r.mediaType === "movie") {
        if (!deps.radarr) return reply.code(503).send({ error: "radarr_not_configured" });
        outcome = await deps.radarr.request(r.tmdbId);
      } else {
        if (!deps.sonarr) return reply.code(503).send({ error: "sonarr_not_configured" });
        const tvdbId = deps.tmdb ? await deps.tmdb.tvdbId(r.tmdbId).catch(() => null) : null;
        let seasons = [...new Set(r.seasons)];
        if (r.seasonNumbering === "tmdb") {
          if (!deps.tmdb) return reply.code(503).send({ error: "tmdb_not_configured" });
          const mapped = await toSonarrNumbers(deps.tmdb, deps.sonarr, r.tmdbId, seasons);
          if (!mapped) {
            // Can't align safely. Re-fetching the title page now returns Sonarr's numbering.
            return reply.code(409).send({ error: "season_numbering_mismatch" });
          }
          seasons = mapped;
        }
        outcome = r.episodes
          ? await (async () => {
              const o = await deps.sonarr!.requestEpisodes(r.tmdbId, seasons[0]!, [...new Set(r.episodes!)], tvdbId);
              return { ...o, seasons: [seasons[0]!] };
            })()
          : await deps.sonarr.request(r.tmdbId, seasons, tvdbId);
      }
    } catch (err) {
      return upstream(reply, err, r.mediaType === "movie" ? "radarr" : "sonarr");
    }
    deps.arr.invalidate();

    // Best-effort name for the log; the request already succeeded.
    let name = `TMDb ${r.mediaType} ${r.tmdbId}`;
    if (deps.tmdb) {
      name = (await deps.tmdb.details(r.mediaType, r.tmdbId).catch(() => undefined))?.title || name;
    }
    deps.db
      .prepare(
        `INSERT INTO requests (profile_uuid, profile_title, media_type, tmdb_id, title, seasons, result, arr_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.uuid,
        profile.title,
        r.mediaType,
        r.tmdbId,
        name,
        r.mediaType === "tv"
          ? JSON.stringify(
              r.episodes
                ? { season: outcome.seasons?.[0], episodes: (outcome as { episodes?: number[] }).episodes ?? r.episodes }
                : (outcome.seasons ?? r.seasons),
            )
          : null,
        outcome.result,
        outcome.arrId,
        Date.now(),
      );
    request.log.info(
      { profile: profile.title, mediaType: r.mediaType, tmdbId: r.tmdbId, result: outcome.result },
      "title requested",
    );

    const res: { result: string; title?: unknown } = { result: outcome.result };
    const token = profile.server_token;
    if (deps.tmdb && token) {
      // Fresh status so the UI can flip the button straight away.
      res.title = await buildDetail({ ...deps, tmdb: deps.tmdb }, token, r.mediaType, r.tmdbId).catch(
        () => undefined,
      );
    }
    return reply.code(outcome.result === "added" ? 201 : 200).send(res);
  });

  /** Recent requests (admin sees everyone's; others see their own). */
  app.get("/api/requests", { preHandler: needProfile }, async (request) => {
    const profile = request.auth!.profile!;
    const rows =
      profile.is_admin === 1
        ? deps.db.prepare("SELECT * FROM requests ORDER BY id DESC LIMIT 100").all()
        : deps.db
            .prepare("SELECT * FROM requests WHERE profile_uuid = ? ORDER BY id DESC LIMIT 100")
            .all(profile.uuid);
    return {
      requests: (rows as Array<Record<string, unknown>>).map((x) => ({
        id: x.id,
        profile: x.profile_title,
        mediaType: x.media_type,
        tmdbId: x.tmdb_id,
        title: x.title,
        ...(x.seasons ? seasonsField(JSON.parse(String(x.seasons)) as number[] | { season: number; episodes: number[] }) : {}),
        result: x.result,
        createdAt: new Date(Number(x.created_at)).toISOString(),
      })),
    };
  });
}
