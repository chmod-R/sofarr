import { type FetchFn, requestJson, send, UpstreamError } from "../upstreams/http.js";
import { VERSION } from "../version.js";

const PLEX_TV = "https://plex.tv";

export interface PlexPin {
  id: number;
  code: string;
  qr?: string;
  expiresAt: string;
  authToken: string | null;
}

export interface PlexUser {
  id: number;
  uuid: string;
  username: string;
  title?: string;
  thumb?: string;
}

export interface PlexHomeUser {
  id: number;
  uuid: string;
  title: string;
  thumb?: string;
  admin: boolean;
  protected: boolean;
  restricted: boolean;
}

export interface PlexResource {
  name: string;
  clientIdentifier: string;
  provides: string;
  owned: boolean;
  accessToken?: string | null;
}

/** Thin client for the plex.tv account API (v2, JSON). */
export class PlexTv {
  constructor(
    private readonly fetch: FetchFn,
    private readonly clientId: string,
    private readonly timeoutMs: number,
  ) {}

  private headers(token?: string): Record<string, string> {
    const h: Record<string, string> = {
      "X-Plex-Product": "Sofarr",
      "X-Plex-Version": VERSION,
      "X-Plex-Client-Identifier": this.clientId,
      "X-Plex-Device-Name": "Sofarr",
      "X-Plex-Platform": "Web",
    };
    if (token) h["X-Plex-Token"] = token;
    return h;
  }

  /** A short (4-character) PIN, usable at plex.tv/link. */
  createPin(): Promise<PlexPin> {
    return requestJson(this.fetch, `${PLEX_TV}/api/v2/pins?strong=false`, {
      timeoutMs: this.timeoutMs,
      method: "POST",
      headers: this.headers(),
    });
  }

  /** Returns null once the PIN has expired or been discarded (Plex answers 404). */
  async checkPin(id: number): Promise<PlexPin | null> {
    try {
      return await requestJson(this.fetch, `${PLEX_TV}/api/v2/pins/${id}`, {
        timeoutMs: this.timeoutMs,
        headers: this.headers(),
      });
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) return null;
      throw err;
    }
  }

  getUser(token: string): Promise<PlexUser> {
    return requestJson(this.fetch, `${PLEX_TV}/api/v2/user`, {
      timeoutMs: this.timeoutMs,
      headers: this.headers(token),
    });
  }

  async getHomeUsers(token: string): Promise<PlexHomeUser[]> {
    const body = await requestJson<{ users?: PlexHomeUser[] }>(
      this.fetch,
      `${PLEX_TV}/api/v2/home/users`,
      { timeoutMs: this.timeoutMs, headers: this.headers(token) },
    );
    return body.users ?? [];
  }

  /**
   * Switch to another Plex Home user. Plex validates the PIN for protected
   * profiles. Resolves to the profile's plex.tv token, or null for a wrong PIN.
   */
  async switchHomeUser(token: string, uuid: string, pin?: string): Promise<string | null> {
    const u = new URL(`${PLEX_TV}/api/v2/home/users/${encodeURIComponent(uuid)}/switch`);
    if (pin) u.searchParams.set("pin", pin);
    try {
      const res = await send(this.fetch, u.toString(), {
        timeoutMs: this.timeoutMs,
        method: "POST",
        headers: this.headers(token),
      });
      const body = (await res.json()) as { authToken?: string; authenticationToken?: string };
      const t = body.authToken ?? body.authenticationToken;
      if (!t) throw new UpstreamError("switch response had no token");
      return t;
    } catch (err) {
      if (err instanceof UpstreamError && (err.status === 401 || err.status === 403)) return null;
      throw err;
    }
  }

  getResources(token: string): Promise<PlexResource[]> {
    return requestJson(this.fetch, `${PLEX_TV}/api/v2/resources?includeHttps=1`, {
      timeoutMs: this.timeoutMs,
      headers: this.headers(token),
    });
  }
}

/** The configured Plex server's machine identifier (unauthenticated /identity). */
export async function getServerId(fetchFn: FetchFn, plexUrl: string, timeoutMs: number) {
  const body = await requestJson<{ MediaContainer?: { machineIdentifier?: string } }>(
    fetchFn,
    `${plexUrl}/identity`,
    { timeoutMs },
  );
  const id = body.MediaContainer?.machineIdentifier;
  if (!id) throw new UpstreamError("Plex /identity returned no machineIdentifier");
  return id;
}

export function findServer(resources: PlexResource[], serverId: string) {
  return resources.find(
    (r) => r.clientIdentifier === serverId && r.provides.split(",").includes("server"),
  );
}
