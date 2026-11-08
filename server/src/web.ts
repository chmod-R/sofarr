import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/** Built web UI: <repo>/web/dist (same relative path from server/src and server/dist). */
export const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));

/**
 * Content-Security-Policy: everything from this origin, artwork from TMDb/Plex
 * (https), trailers from YouTube's privacy-enhanced domain only.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "frame-src https://www.youtube-nocookie.com",
  // hls.js (non-Safari playback) feeds <video> through MediaSource blob: URLs and may run a blob: worker.
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function registerWeb(app: FastifyInstance, webDir: string): void {
  app.addHook("onSend", async (_req, reply) => {
    // The app shell must always be revalidated so updates show up; its assets are hashed.
    if (String(reply.getHeader("content-type") ?? "").startsWith("text/html")) {
      reply.header("Cache-Control", "no-cache");
    }
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("Content-Security-Policy", CSP);
  });

  const index = join(webDir, "index.html");
  if (!existsSync(index)) {
    app.log.warn({ webDir }, "web UI not built; serving the API only");
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: "not_found", path: req.url }));
    return;
  }

  app.register(fastifyStatic, {
    root: webDir,
    wildcard: false,
    index: false,
    setHeaders(res, path) {
      // Vite emits content-hashed files under /assets: cache forever. Everything else: revalidate.
      res.header(
        "Cache-Control",
        path.includes(`${join(webDir, "assets")}`) ? "public, max-age=31536000, immutable" : "no-cache",
      );
    },
  });

  // Client-side routes (e.g. /title/movie/603) get the app; unknown /api paths stay JSON 404s.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || (req.method !== "GET" && req.method !== "HEAD")) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.sendFile("index.html");
  });
}
