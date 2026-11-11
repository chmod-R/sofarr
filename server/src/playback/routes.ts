import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/routes.js";
import type { Db } from "../db.js";
import { plexImageUrl } from "../catalog/titles.js";
import { UpstreamError } from "../upstreams/http.js";
import { type Capabilities, chooseProfile, type PlexItem, type PlexPlayback, type StreamProfile, tracksOf } from "./plexPlayback.js";

/** One playback in progress. The id is an unguessable capability: media requests from <video> may not carry cookies. */
interface PlaySession {
  id: string;
  plexSession: string;
  token: string;
  profileUuid: string;
  ratingKey: string;
  durationMs: number;
  profile: StreamProfile;
  capabilities: Capabilities;
  offsetSec: number;
  lastSeen: number;
}

const IDLE_MS = 30 * 60 * 1000; // a paused player pings; silence this long means it's gone
const MAX_SESSIONS = 50;

const playBody = z
  .object({
    plexKey: z.string().regex(/^\d+$/),
    /** Override the resume point (ms). Omit to resume where Plex says; 0 = from the start. */
    offsetMs: z.number().int().min(0).optional(),
    capabilities: z.object({
      nativeHls: z.boolean(),
      hevc: z.boolean(),
      hevcMain10: z.boolean(),
      eac3: z.boolean(),
      ac3: z.boolean(),
    }),
  })
  .strict();

const progressBody = z
  .object({
    timeMs: z.number().min(0),
    state: z.enum(["playing", "paused", "stopped"]),
  })
  .strict();

const tracksBody = z
  .object({
    audioStreamId: z.number().int().positive().optional(),
    /** 0 = subtitles off. */
    subtitleStreamId: z.number().int().min(0).optional(),
    /** Where playback is now (ms); the new stream starts here. */
    timeMs: z.number().min(0),
  })
  .strict()
  .refine((b) => b.audioStreamId !== undefined || b.subtitleStreamId !== undefined);

const FILE = /^[A-Za-z0-9_.-]{1,64}$/;

function label(item: PlexItem): { title: string; subtitle: string | null } {
  if (item.type === "episode") {
    const se = [item.parentIndex != null && `S${item.parentIndex}`, item.index != null && `E${item.index}`].filter(Boolean).join(" · ");
    return { title: item.grandparentTitle ?? item.title, subtitle: [se, item.title].filter(Boolean).join(" · ") };
  }
  return { title: item.title, subtitle: null };
}

export function registerPlaybackRoutes(
  app: FastifyInstance,
  deps: { db: Db; plex: PlexPlayback; onWatchStateChanged?: () => void },
): void {
  const sessions = new Map<string, PlaySession>();
  const needProfile = requireAuth(deps.db, "profile");

  const end = async (s: PlaySession) => {
    sessions.delete(s.id);
    await deps.plex.stop(s.token, s.plexSession).catch(() => undefined);
  };

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) if (now - s.lastSeen > IDLE_MS) void end(s);
  }, 60_000);
  sweeper.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweeper);
    await Promise.all([...sessions.values()].map(end));
  });

  const fail = (reply: FastifyReply, err: unknown) => {
    if (!(err instanceof UpstreamError)) throw err;
    app.log.warn({ err: err.message }, "playback upstream error");
    return reply.code(502).send({ error: "plex_unavailable", detail: err.message });
  };

  /** Open a Plex stream for `item` and register it; returns what the player needs. */
  const start = async (
    token: string,
    profileUuid: string,
    item: PlexItem,
    offsetMs: number,
    capabilities: Capabilities,
    log: { info: (o: object, m: string) => void },
  ) => {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) await end(oldest);
    }
    const streamProfile = chooseProfile(capabilities);
    const s: PlaySession = {
      id: randomBytes(24).toString("base64url"),
      plexSession: `sofarr-${randomBytes(9).toString("base64url")}`,
      token,
      profileUuid,
      ratingKey: item.ratingKey,
      durationMs: item.duration ?? 0,
      profile: streamProfile,
      capabilities,
      offsetSec: offsetMs / 1000,
      lastSeen: Date.now(),
    };
    const [decision, next] = await Promise.all([
      deps.plex.decision(token, s.ratingKey, s.plexSession, streamProfile, s.offsetSec),
      deps.plex.nextEpisode(token, item).catch(() => undefined),
    ]);
    sessions.set(s.id, s);
    log.info(
      { ratingKey: s.ratingKey, profile: streamProfile.profileName ?? streamProfile.platform, video: decision.video, audio: decision.audio },
      "playback started",
    );
    return {
      id: s.id,
      src: `/api/play/${s.id}/start.m3u8`,
      ratingKey: s.ratingKey,
      ...label(item),
      summary: item.summary || null,
      durationMs: s.durationMs,
      startMs: offsetMs,
      decision: { video: decision.video, audio: decision.audio },
      tracks: tracksOf(item),
      next: next ? { plexKey: next.ratingKey, ...label(next), thumb: plexImageUrl(next.thumb ?? null, "backdrop") } : null,
    };
  };

  /** Start playing a movie or episode (or a show: its next-up episode). */
  app.post("/api/play", { preHandler: needProfile }, async (request, reply) => {
    const body = playBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_play_request" });
    const profile = request.auth!.profile!;
    const token = profile.server_token;
    if (!token) return reply.code(409).send({ error: "profile_not_ready" });

    try {
      let item = await deps.plex.item(token, body.data.plexKey, { onDeck: true });
      if (!item) return reply.code(404).send({ error: "not_in_library" });
      if (item.type === "show") {
        const next = item.OnDeck?.Metadata ?? (await deps.plex.firstEpisode(token, item.ratingKey));
        if (!next) return reply.code(404).send({ error: "no_episodes" });
        item = (await deps.plex.item(token, next.ratingKey)) ?? next;
      }
      if (item.type !== "movie" && item.type !== "episode") return reply.code(400).send({ error: "not_playable" });

      // Resume where Plex says unless told otherwise; restart if within the last 5%.
      const durationMs = item.duration ?? 0;
      let offsetMs = body.data.offsetMs ?? item.viewOffset ?? 0;
      if (durationMs && offsetMs > durationMs * 0.95) offsetMs = 0;

      return await start(token, profile.uuid, item, offsetMs, body.data.capabilities, request.log);
    } catch (err) {
      return fail(reply, err);
    }
  });

  const getSession = (id: string) => {
    const s = sessions.get(id);
    if (s) s.lastSeen = Date.now();
    return s;
  };

  /** Stream a Plex response through, with a correct Content-Type. */
  const pipe = async (reply: FastifyReply, res: Response, contentType: string) => {
    if (!res.ok || !res.body) return reply.code(res.status === 404 ? 404 : 502).send();
    reply.header("Content-Type", contentType).header("Cache-Control", "no-store");
    // fetch() transparently decompresses (Plex gzips playlists), so Plex's
    // Content-Length is the *compressed* size: only forward it for unencoded bodies.
    const len = res.headers.get("content-length");
    if (len && !res.headers.get("content-encoding")) reply.header("Content-Length", len);
    return reply.send(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream));
  };

  app.get<{ Params: { id: string } }>("/api/play/:id/start.m3u8", async (request, reply) => {
    const s = getSession(request.params.id);
    if (!s) return reply.code(404).send();
    try {
      const q = deps.plex.streamParams(s.ratingKey, s.plexSession, s.profile, s.offsetSec);
      const res = await deps.plex.transcoder(s.token, s.plexSession, s.profile, "start.m3u8", q);
      return pipe(reply, res, "application/vnd.apple.mpegurl");
    } catch {
      return reply.code(502).send();
    }
  });

  // The master playlist points at "session/<plexSession>/base/index.m3u8" (relative), which lands here.
  app.get<{ Params: { id: string; plexSession: string; file: string } }>(
    "/api/play/:id/session/:plexSession/base/:file",
    async (request, reply) => {
      const s = getSession(request.params.id);
      const { plexSession, file } = request.params;
      if (!s || plexSession !== s.plexSession || !FILE.test(file)) return reply.code(404).send();
      const type = file.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : s.profile.container === "mp4"
          ? "video/mp4"
          : "video/mp2t";
      const path = `session/${encodeURIComponent(plexSession)}/base/${file}`;
      try {
        let res = await deps.plex.transcoder(s.token, s.plexSession, s.profile, path);
        // Plex sometimes answers a segment with an empty 200 while the transcoder (re)starts.
        if (res.ok && !file.endsWith(".m3u8") && res.headers.get("content-length") === "0") {
          await new Promise((r) => setTimeout(r, 750));
          res = await deps.plex.transcoder(s.token, s.plexSession, s.profile, path);
        }
        return pipe(reply, res, type);
      } catch {
        return reply.code(502).send();
      }
    },
  );

  /**
   * Switch audio or subtitles: save the choice to Plex (per user, like Plex's
   * own apps) and restart the stream at the current position. Subtitles are
   * burned in by Plex, so turning them on converts the video.
   */
  app.post<{ Params: { id: string } }>("/api/play/:id/tracks", async (request, reply) => {
    const s = getSession(request.params.id);
    if (!s) return reply.code(404).send({ error: "no_such_playback" });
    const body = tracksBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_tracks" });
    try {
      const item = await deps.plex.item(s.token, s.ratingKey);
      if (!item) return reply.code(404).send({ error: "not_in_library" });
      const t = tracksOf(item);
      const { audioStreamId, subtitleStreamId, timeMs } = body.data;
      if (t.partId === null) return reply.code(409).send({ error: "no_media_part" });
      if (audioStreamId !== undefined && !t.audio.some((a) => a.id === audioStreamId)) {
        return reply.code(400).send({ error: "unknown_audio_track" });
      }
      if (subtitleStreamId && !t.subtitles.some((x) => x.id === subtitleStreamId)) {
        return reply.code(400).send({ error: "unknown_subtitle_track" });
      }
      await deps.plex.selectStreams(s.token, t.partId, {
        ...(audioStreamId !== undefined && { audioStreamId }),
        ...(subtitleStreamId !== undefined && { subtitleStreamId }),
      });
      // Report where we are, then replace the stream with one using the new tracks.
      await deps.plex.timeline(s.token, s.plexSession, s.ratingKey, "paused", timeMs, s.durationMs).catch(() => undefined);
      await end(s);
      const updated = (await deps.plex.item(s.token, s.ratingKey)) ?? item;
      return await start(s.token, s.profileUuid, updated, timeMs, s.capabilities, request.log);
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Player heartbeat: position to Plex (resume/watched) and keep the transcoder alive. */
  app.post<{ Params: { id: string } }>("/api/play/:id/progress", async (request, reply) => {
    const s = getSession(request.params.id);
    if (!s) return reply.code(404).send({ error: "no_such_playback" });
    const body = progressBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_progress" });
    const { timeMs, state } = body.data;
    try {
      await deps.plex.timeline(s.token, s.plexSession, s.ratingKey, state, timeMs, s.durationMs);
      // Resume points / watched flags changed: don't serve cached library data.
      if (state !== "playing") deps.onWatchStateChanged?.();
      if (state === "stopped") await end(s);
      else await deps.plex.ping(s.token, s.plexSession).catch(() => undefined);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
