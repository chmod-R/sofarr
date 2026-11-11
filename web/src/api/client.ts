import type { Home, Pin, PinPoll, PlayCapabilities, PlaySession, Profile, RequestResult, SeasonEpisodes, Session, Title, TitleDetail } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Fired on any 401 so the app can drop back to the sign-in screen. */
export const SIGNED_OUT_EVENT = "sofarr:signed-out";

async function call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (res.ok || okStatuses.includes(res.status)) return data as T;
  if (res.status === 401 && path !== "/api/auth/session") window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  throw new ApiError(
    res.status,
    String(data.error ?? data.status ?? `http_${res.status}`),
    typeof data.detail === "string" ? data.detail : typeof data.reason === "string" ? data.reason : undefined,
  );
}

export const api = {
  session: async (): Promise<Session | null> => {
    try {
      return await call<Session>("GET", "/api/auth/session");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  startPin: () => call<Pin>("POST", "/api/auth/pin"),
  // 403 (denied), 404 (no pending), 410 (expired) are answers, not failures.
  pollPin: () => call<PinPoll>("GET", "/api/auth/pin", undefined, [403, 404, 410]),
  logout: () => call<{ signedIn: false }>("POST", "/api/auth/logout"),
  profiles: () => call<{ profiles: Profile[] }>("GET", "/api/profiles"),
  selectProfile: (uuid: string, pin?: string) =>
    call<{ profile: Profile }>("POST", `/api/profiles/${encodeURIComponent(uuid)}/select`, pin ? { pin } : {}),
  deselectProfile: () => call<{ profile: null }>("POST", "/api/profiles/deselect"),
  home: () => call<Home>("GET", "/api/home"),
  library: () => call<Home>("GET", "/api/library"),
  title: (mediaType: string, tmdbId: number) => call<TitleDetail>("GET", `/api/titles/${mediaType}/${tmdbId}`),
  logo: (mediaType: string, tmdbId: number) => call<{ logo: string | null }>("GET", `/api/titles/${mediaType}/${tmdbId}/logo`),
  similar: (mediaType: string, tmdbId: number) => call<{ results: Title[] }>("GET", `/api/titles/${mediaType}/${tmdbId}/similar`),
  episodes: (tmdbId: number, season: number, numbering: "sonarr" | "tmdb") =>
    call<SeasonEpisodes>("GET", `/api/titles/tv/${tmdbId}/seasons/${season}?numbering=${numbering}`),
  requestEpisodes: (tmdbId: number, season: number, episodes: number[], seasonNumbering: "sonarr" | "tmdb") =>
    call<RequestResult>("POST", "/api/requests", { mediaType: "tv", tmdbId, seasons: [season], episodes, seasonNumbering }),
  search: (q: string) => call<{ query: string; results: Title[] }>("GET", `/api/search?q=${encodeURIComponent(q)}`),
  play: (plexKey: string, capabilities: PlayCapabilities, offsetMs?: number) =>
    call<PlaySession>("POST", "/api/play", { plexKey, capabilities, ...(offsetMs !== undefined && { offsetMs }) }),
  tracks: (id: string, choice: { audioStreamId?: number; subtitleStreamId?: number }, timeMs: number) =>
    call<PlaySession>("POST", `/api/play/${encodeURIComponent(id)}/tracks`, { ...choice, timeMs }),
  /** keepalive: still delivered when the page is closing. */
  progress: async (id: string, timeMs: number, state: "playing" | "paused" | "stopped") => {
    await fetch(`/api/play/${encodeURIComponent(id)}/progress`, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeMs, state }),
    });
  },
  requestMovie: (tmdbId: number) =>
    call<RequestResult>("POST", "/api/requests", { mediaType: "movie", tmdbId }),
  requestSeasons: (tmdbId: number, seasons: number[], seasonNumbering: "sonarr" | "tmdb") =>
    call<RequestResult>("POST", "/api/requests", { mediaType: "tv", tmdbId, seasons, seasonNumbering }),
};
