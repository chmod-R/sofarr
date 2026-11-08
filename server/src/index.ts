import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

// The database holds Plex tokens: make every file we create (db, -wal, -shm)
// readable by this user only.
process.umask(0o077);

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const app = buildApp(config);

const configured = (["plex", "radarr", "sonarr", "qbittorrent", "tmdb"] as const).filter(
  (k) => config[k] !== undefined,
);
app.log.info({ configured }, "upstreams configured");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

await app.listen({ host: config.host, port: config.port });
