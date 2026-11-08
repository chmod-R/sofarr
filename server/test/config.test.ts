import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("boots with nothing configured", () => {
    const c = loadConfig({});
    expect(c.port).toBe(5656);
    expect(c.host).toBe("0.0.0.0");
    expect(c.plex).toBeUndefined();
    expect(c.radarr).toBeUndefined();
  });

  it("strips trailing slashes from URLs", () => {
    const c = loadConfig({ SOFARR_PLEX_URL: "http://192.168.1.10:32400///" });
    expect(c.plex?.url).toBe("http://192.168.1.10:32400");
  });

  it("requires *arr URL and API key together", () => {
    expect(() => loadConfig({ SOFARR_RADARR_URL: "http://localhost:7878" })).toThrow(ConfigError);
    expect(() => loadConfig({ SOFARR_SONARR_API_KEY: "abc" })).toThrow(/SONARR_URL/);
  });

  it("treats empty strings as unset", () => {
    const c = loadConfig({
      SOFARR_TMDB_API_KEY: "  ",
      SOFARR_QBITTORRENT_URL: "http://q:8080",
      SOFARR_PLEX_URL: "",
      SOFARR_RADARR_URL: " ",
      SOFARR_RADARR_API_KEY: "",
    });
    expect(c.tmdb).toBeUndefined();
    expect(c.plex).toBeUndefined();
    expect(c.radarr).toBeUndefined();
    expect(c.qbittorrent).toEqual({ url: "http://q:8080" });
  });

  it("rejects bad values with a readable message", () => {
    expect(() => loadConfig({ SOFARR_PORT: "99999" })).toThrow(/SOFARR_PORT/);
    expect(() => loadConfig({ SOFARR_PLEX_URL: "ftp://x" })).toThrow(/SOFARR_PLEX_URL/);
  });
});
