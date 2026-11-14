import { type FetchFn, requestJson, send, UpstreamError } from "../upstreams/http.js";

/**
 * What the browser says it can decode. Sent by the player; used only to pick
 * how Plex should package the stream.
 */
export interface Capabilities {
  /** Plays HLS natively (Safari, iOS) rather than through MediaSource (hls.js). */
  nativeHls: boolean;
  hevc: boolean;
  /** 10-bit HEVC (Main 10). */
  hevcMain10: boolean;
  eac3: boolean;
  ac3: boolean;
}

export interface StreamProfile {
  /** Plex X-Plex-Platform. */
  platform: string;
  /** Plex built-in profile to use (X-Plex-Client-Profile-Name), if not the platform's default. */
  profileName?: string;
  /** X-Plex-Client-Profile-Extra. */
  extra: string;
  /** Segment container Plex will produce. */
  container: "mp4" | "mpegts";
}

/**
 * Pick how Plex should stream to this browser. Measured on the reference
 * server (2026-11-08): Plex's "Safari" profile transcodes 10-bit HEVC and
 * E-AC3, but its "iOS" profile copies both into fMP4 HLS, which Safari on a
 * Mac plays natively. So a browser that natively plays HLS + Main 10 + E-AC3
 * gets the iOS profile, and nearly the whole library streams without
 * re-encoding. Everything else gets fMP4 HLS for hls.js, with HEVC only if
 * MediaSource says it can decode it.
 */
export function chooseProfile(c: Capabilities): StreamProfile {
  const video = c.hevc ? "h264,hevc" : "h264";
  const audio = ["aac", c.ac3 && "ac3", c.eac3 && "eac3"].filter(Boolean).join(",");
  const extra = `add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mp4&videoCodec=${video}&audioCodec=${audio}&replace=true)`;
  if (c.nativeHls && c.hevcMain10 && c.eac3) {
    return { platform: "Safari", profileName: "iOS", extra, container: "mp4" };
  }
  return { platform: c.nativeHls ? "Safari" : "Chrome", extra, container: "mp4" };
}

export interface PlexItem {
  ratingKey: string;
  type: "movie" | "episode" | "show" | string;
  title: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  parentRatingKey?: string;
  grandparentRatingKey?: string;
  duration?: number;
  viewOffset?: number;
  summary?: string;
  thumb?: string;
  OnDeck?: { Metadata?: PlexItem };
  Media?: Array<{
    container?: string;
    videoCodec?: string;
    audioCodec?: string;
    Part?: Array<{ id: number; key?: string; Stream?: PlexStream[] }>;
  }>;
}

export interface PlexStream {
  id: number;
  streamType: number; // 1 video, 2 audio, 3 subtitle
  /** Position of the stream in the media file (absent for sidecar subtitle files). */
  index?: number;
  /** Set for sidecar subtitle files (served by Plex, not inside the media file). */
  key?: string;
  codec?: string;
  language?: string;
  languageTag?: string;
  title?: string;
  displayTitle?: string;
  extendedDisplayTitle?: string;
  selected?: boolean;
  forced?: boolean;
  channels?: number;
}

export interface Track {
  id: number;
  label: string;
  language: string | null;
  selected: boolean;
  /** Position in the media file, for players that pick tracks themselves (direct play); null if not in it. */
  index: number | null;
}

export interface Tracks {
  partId: number | null;
  audio: Track[];
  /** `image` subtitles (PGS, VobSub, DVB) and text ones are both burned in (HLS). `external`: a sidecar file. */
  subtitles: Array<Track & { forced: boolean; kind: "text" | "image"; codec: string | null; external: boolean }>;
}

const IMAGE_SUBS = new Set(["pgs", "vobsub", "dvd_subtitle", "dvb_subtitle", "hdmv_pgs_subtitle", "xsub"]);

/** Audio and subtitle choices for an item (first media/part, as Plex plays it). */
export function tracksOf(item: PlexItem): Tracks {
  const part = item.Media?.[0]?.Part?.[0];
  const streams = part?.Stream ?? [];
  const base = (s: PlexStream): Track => ({
    id: s.id,
    label: s.extendedDisplayTitle ?? s.displayTitle ?? s.language ?? `Track ${s.id}`,
    language: s.languageTag ?? s.language ?? null,
    selected: Boolean(s.selected),
    index: s.key ? null : (s.index ?? null),
  });
  return {
    partId: part?.id ?? null,
    audio: streams.filter((s) => s.streamType === 2).map(base),
    subtitles: streams
      .filter((s) => s.streamType === 3 && s.codec !== "eia_608") // 608 captions live inside the video; not selectable here
      .map((s) => ({
        ...base(s),
        forced: Boolean(s.forced),
        kind: IMAGE_SUBS.has(s.codec ?? "") ? "image" : "text",
        codec: s.codec ?? null,
        external: Boolean(s.key),
      })),
  };
}

interface Container<T> {
  MediaContainer: { Metadata?: T[] };
}

export interface PlexClientIdentity {
  clientId: string;
  product: string;
  version: string;
}

/** Plex calls made with a profile's server token for playback. */
export class PlexPlayback {
  constructor(
    private readonly fetch: FetchFn,
    private readonly url: string,
    private readonly id: PlexClientIdentity,
    private readonly timeoutMs: number,
  ) {}

  headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      "X-Plex-Token": token,
      "X-Plex-Client-Identifier": this.id.clientId,
      "X-Plex-Product": this.id.product,
      "X-Plex-Version": this.id.version,
      "X-Plex-Device": "Web",
      "X-Plex-Device-Name": "Sofarr",
      ...extra,
    };
  }

  async item(token: string, ratingKey: string, opts: { onDeck?: boolean } = {}): Promise<PlexItem | undefined> {
    const q = opts.onDeck ? "?includeOnDeck=1" : "";
    try {
      const body = await requestJson<Container<PlexItem>>(
        this.fetch,
        `${this.url}/library/metadata/${encodeURIComponent(ratingKey)}${q}`,
        { timeoutMs: this.timeoutMs, headers: this.headers(token) },
      );
      return body.MediaContainer.Metadata?.[0];
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) return undefined; // not in this profile's library
      throw err;
    }
  }

  async children(token: string, ratingKey: string): Promise<PlexItem[]> {
    const body = await requestJson<Container<PlexItem>>(
      this.fetch,
      `${this.url}/library/metadata/${encodeURIComponent(ratingKey)}/children`,
      { timeoutMs: this.timeoutMs, headers: this.headers(token) },
    );
    return body.MediaContainer.Metadata ?? [];
  }

  /** First episode of a show (season 1 if present, else the lowest season). */
  async firstEpisode(token: string, showKey: string): Promise<PlexItem | undefined> {
    const seasons = (await this.children(token, showKey))
      .filter((s) => (s.index ?? 0) > 0)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const s of seasons) {
      const eps = (await this.children(token, s.ratingKey)).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (eps[0]) return eps[0];
    }
    return undefined;
  }

  /** The episode after this one: next in the season, else first of the next season. */
  async nextEpisode(token: string, ep: PlexItem): Promise<PlexItem | undefined> {
    if (ep.type !== "episode" || !ep.parentRatingKey || !ep.grandparentRatingKey) return undefined;
    const inSeason = (await this.children(token, ep.parentRatingKey))
      .filter((e) => (e.index ?? 0) > (ep.index ?? 0))
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (inSeason[0]) return inSeason[0];
    const seasons = (await this.children(token, ep.grandparentRatingKey))
      .filter((s) => (s.index ?? 0) > (ep.parentIndex ?? 0))
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const s of seasons) {
      const eps = (await this.children(token, s.ratingKey)).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (eps[0]) return eps[0];
    }
    return undefined;
  }

  /**
   * Choose audio / subtitle streams for a part. Plex stores this per user
   * (as its own apps do), and the transcoder uses it for the next stream.
   * subtitleStreamId 0 = subtitles off.
   */
  async selectStreams(token: string, partId: number, choice: { audioStreamId?: number; subtitleStreamId?: number }): Promise<void> {
    const u = new URL(`${this.url}/library/parts/${partId}`);
    if (choice.audioStreamId !== undefined) u.searchParams.set("audioStreamID", String(choice.audioStreamId));
    if (choice.subtitleStreamId !== undefined) u.searchParams.set("subtitleStreamID", String(choice.subtitleStreamId));
    u.searchParams.set("allParts", "1");
    await send(this.fetch, u.toString(), { timeoutMs: this.timeoutMs, method: "PUT", headers: this.headers(token) });
  }

  /** Report playback position; Plex updates resume points and marks watched near the end. */
  async timeline(
    token: string,
    sessionId: string,
    ratingKey: string,
    state: "playing" | "paused" | "stopped",
    timeMs: number,
    durationMs: number,
  ): Promise<void> {
    const u = new URL(`${this.url}/:/timeline`);
    u.searchParams.set("ratingKey", ratingKey);
    u.searchParams.set("key", `/library/metadata/${ratingKey}`);
    u.searchParams.set("state", state);
    u.searchParams.set("time", String(Math.max(0, Math.round(timeMs))));
    u.searchParams.set("duration", String(Math.round(durationMs)));
    await send(this.fetch, u.toString(), {
      timeoutMs: this.timeoutMs,
      headers: this.headers(token, { "X-Plex-Session-Identifier": sessionId }),
    });
  }

  async ping(token: string, sessionId: string): Promise<void> {
    await send(this.fetch, `${this.url}/video/:/transcode/universal/ping?session=${encodeURIComponent(sessionId)}`, {
      timeoutMs: this.timeoutMs,
      headers: this.headers(token),
    });
  }

  async stop(token: string, sessionId: string): Promise<void> {
    await send(this.fetch, `${this.url}/video/:/transcode/universal/stop?session=${encodeURIComponent(sessionId)}`, {
      timeoutMs: this.timeoutMs,
      headers: this.headers(token),
    });
  }

  /** Query string for decision/start: the same parameters for both. */
  streamParams(ratingKey: string, sessionId: string, profile: StreamProfile, offsetSec: number): URLSearchParams {
    return new URLSearchParams({
      path: `/library/metadata/${ratingKey}`,
      mediaIndex: "0",
      partIndex: "0",
      protocol: "hls",
      fastSeek: "1",
      directPlay: "0",
      directStream: "1",
      directStreamAudio: "1",
      subtitles: "burn",
      location: "lan",
      maxVideoBitrate: "40000",
      videoQuality: "100",
      session: sessionId,
      offset: String(Math.max(0, Math.floor(offsetSec))),
    });
  }

  profileHeaders(token: string, sessionId: string, profile: StreamProfile): Record<string, string> {
    return this.headers(token, {
      "X-Plex-Session-Identifier": sessionId,
      "X-Plex-Platform": profile.platform,
      "X-Plex-Client-Profile-Extra": profile.extra,
      ...(profile.profileName && { "X-Plex-Client-Profile-Name": profile.profileName }),
    });
  }

  /** Plex's decision for this stream: copy vs transcode per track. */
  async decision(
    token: string,
    ratingKey: string,
    sessionId: string,
    profile: StreamProfile,
    offsetSec: number,
  ): Promise<{ video: string; audio: string; text: string }> {
    const q = this.streamParams(ratingKey, sessionId, profile, offsetSec);
    const body = await requestJson<{
      MediaContainer: {
        generalDecisionText?: string;
        Metadata?: Array<{ Media?: Array<{ Part?: Array<{ Stream?: Array<{ streamType: number; decision?: string }> }> }> }>;
      };
    }>(this.fetch, `${this.url}/video/:/transcode/universal/decision?${q}`, {
      timeoutMs: this.timeoutMs,
      headers: this.profileHeaders(token, sessionId, profile),
    });
    const streams = body.MediaContainer.Metadata?.[0]?.Media?.[0]?.Part?.[0]?.Stream ?? [];
    return {
      video: streams.find((s) => s.streamType === 1)?.decision ?? "unknown",
      audio: streams.find((s) => s.streamType === 2)?.decision ?? "unknown",
      text: body.MediaContainer.generalDecisionText ?? "",
    };
  }

  /**
   * The media file itself, for direct play. `partKey` is the part's
   * `/library/parts/...` key; `range` is forwarded so the player can seek.
   * No timeout: a whole film streams through one request.
   */
  file(token: string, partKey: string, range: string | undefined, signal: AbortSignal): Promise<Response> {
    return this.fetch(`${this.url}${partKey}`, {
      headers: this.headers(token, range ? { Range: range } : {}),
      signal,
    });
  }

  /** Raw request to Plex's transcoder (playlists and segments), for proxying. */
  transcoder(token: string, sessionId: string, profile: StreamProfile, path: string, query?: URLSearchParams): Promise<Response> {
    const qs = query ? `?${query}` : "";
    return this.fetch(`${this.url}/video/:/transcode/universal/${path}${qs}`, {
      headers: this.profileHeaders(token, sessionId, profile),
      // Segments can take a while when Plex has to transcode.
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, 60_000)),
    });
  }
}
