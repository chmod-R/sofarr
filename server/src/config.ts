import { z } from "zod";

/**
 * All configuration comes from environment variables (prefix SOFARR_).
 * Every upstream is optional at boot: an unconfigured upstream is reported as
 * "not_configured" by the health check rather than crashing the server, so a
 * fresh install can start and tell the admin what's missing.
 */

/** An http(s) URL, trailing slashes removed; blank counts as unset. */
const url = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z
    .url({ protocol: /^https?$/ })
    .transform((u) => u.replace(/\/+$/, ""))
    .optional(),
);

const optionalString = z
  .string()
  .trim()
  .transform((s) => (s === "" ? undefined : s))
  .optional();

const envSchema = z.object({
  SOFARR_HOST: z.string().default("0.0.0.0"),
  SOFARR_PORT: z.coerce.number().int().min(1).max(65535).default(5656),
  SOFARR_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  SOFARR_DATA_DIR: z.string().default("/data"),
  /** Set when behind a reverse proxy that terminates TLS (affects Secure cookies, client IP). */
  SOFARR_TRUST_PROXY: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /** ISO 3166-1 country for release dates (e.g. US, GB, DE). */
  SOFARR_REGION: z.string().regex(/^[A-Z]{2}$/).default("US"),
  /** TMDb language for titles and overviews (e.g. en-US, de-DE). */
  SOFARR_LANGUAGE: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default("en-US"),
  SOFARR_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),

  SOFARR_PLEX_URL: url,

  SOFARR_RADARR_URL: url,
  SOFARR_RADARR_API_KEY: optionalString,
  /** Override "Get it" defaults (otherwise: what most of the existing library uses). */
  SOFARR_RADARR_QUALITY_PROFILE: optionalString,
  SOFARR_RADARR_ROOT_FOLDER: optionalString,

  SOFARR_SONARR_URL: url,
  SOFARR_SONARR_API_KEY: optionalString,
  SOFARR_SONARR_QUALITY_PROFILE: optionalString,
  SOFARR_SONARR_ROOT_FOLDER: optionalString,

  SOFARR_QBITTORRENT_URL: url,
  SOFARR_QBITTORRENT_USERNAME: optionalString,
  SOFARR_QBITTORRENT_PASSWORD: optionalString,

  /** TMDb v3 API key or v4 read access token (JWT); either works. */
  SOFARR_TMDB_API_KEY: optionalString,
});

export interface ArrConfig {
  url: string;
  apiKey: string;
  qualityProfile?: string;
  rootFolder?: string;
}

export interface Config {
  host: string;
  port: number;
  logLevel: z.infer<typeof envSchema>["SOFARR_LOG_LEVEL"];
  dataDir: string;
  upstreamTimeoutMs: number;
  trustProxy: boolean;
  region: string;
  language: string;
  plex?: { url: string };
  radarr?: ArrConfig;
  sonarr?: ArrConfig;
  qbittorrent?: { url: string; username?: string; password?: string };
  tmdb?: { apiKey: string };
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;

  const arr = (name: string, u?: string, key?: string): ArrConfig | undefined => {
    if (!u && !key) return undefined;
    if (!u || !key) {
      throw new ConfigError(
        `Invalid configuration:\n  SOFARR_${name}_URL and SOFARR_${name}_API_KEY must be set together`,
      );
    }
    return { url: u, apiKey: key };
  };

  const config: Config = {
    host: e.SOFARR_HOST,
    port: e.SOFARR_PORT,
    logLevel: e.SOFARR_LOG_LEVEL,
    dataDir: e.SOFARR_DATA_DIR,
    upstreamTimeoutMs: e.SOFARR_UPSTREAM_TIMEOUT_MS,
    trustProxy: e.SOFARR_TRUST_PROXY,
    region: e.SOFARR_REGION,
    language: e.SOFARR_LANGUAGE,
  };
  if (e.SOFARR_PLEX_URL) config.plex = { url: e.SOFARR_PLEX_URL };
  const radarr = arr("RADARR", e.SOFARR_RADARR_URL, e.SOFARR_RADARR_API_KEY);
  if (radarr) {
    if (e.SOFARR_RADARR_QUALITY_PROFILE) radarr.qualityProfile = e.SOFARR_RADARR_QUALITY_PROFILE;
    if (e.SOFARR_RADARR_ROOT_FOLDER) radarr.rootFolder = e.SOFARR_RADARR_ROOT_FOLDER;
    config.radarr = radarr;
  }
  const sonarr = arr("SONARR", e.SOFARR_SONARR_URL, e.SOFARR_SONARR_API_KEY);
  if (sonarr) {
    if (e.SOFARR_SONARR_QUALITY_PROFILE) sonarr.qualityProfile = e.SOFARR_SONARR_QUALITY_PROFILE;
    if (e.SOFARR_SONARR_ROOT_FOLDER) sonarr.rootFolder = e.SOFARR_SONARR_ROOT_FOLDER;
    config.sonarr = sonarr;
  }
  if (e.SOFARR_QBITTORRENT_URL) {
    const q: NonNullable<Config["qbittorrent"]> = { url: e.SOFARR_QBITTORRENT_URL };
    if (e.SOFARR_QBITTORRENT_USERNAME) q.username = e.SOFARR_QBITTORRENT_USERNAME;
    if (e.SOFARR_QBITTORRENT_PASSWORD) q.password = e.SOFARR_QBITTORRENT_PASSWORD;
    config.qbittorrent = q;
  }
  if (e.SOFARR_TMDB_API_KEY) config.tmdb = { apiKey: e.SOFARR_TMDB_API_KEY };
  return config;
}
