# Sofarr

A sofa-friendly, Netflix-like front end for a self-hosted
**Plex + Radarr + Sonarr** setup. Browse what to watch, get anything you don't have
yet, and play it, all in one app you can drive with a TV remote.

> **Direction:** Sofarr is becoming a native app for the **Google TV Streamer**
> (`android/`, early days), backed by the Sofarr server below. The web UI described here
> is being replaced and gets no new work.

## What it does

- **Browse.** Rows like Continue Watching, Because you watched…, Trending Movies and
  Trending TV, Downloading Now and Recently Added. Every title shows whether it's in
  your library, downloading, requested, coming soon (with its digital release date),
  or available to get.
- **Search** any movie or show: an on-screen keyboard for remotes, or type.
- **Get it.** One button adds a movie to Radarr, or chosen seasons (or single episodes)
  to Sonarr, and starts the search. Unreleased movies download when they come out.
  Download progress shows live.
- **Watch** in Sofarr's own player, streamed from your Plex server:
  - resumes where you left off; watched status syncs back to Plex
  - up-next countdown for episodes
  - audio and subtitle selection
  - in Safari, most files play without re-encoding, including 10-bit HEVC and
    Dolby Digital Plus
- **Plex sign-in and profiles.** Sign in with a code at plex.tv/link (or a QR code).
  Profiles are your Plex Home users, with their own history and PINs.
- **Built for TVs:** arrow keys/D-pad and Back everywhere; also works with a mouse, and on
  phones.

## Requirements

- **Plex Media Server.** Sign-in is limited to the server's owner for now.
- **Radarr** and/or **Sonarr** (v3 API; Sonarr v4 recommended).
- A free **TMDb API key** ([themoviedb.org → Settings → API](https://www.themoviedb.org/settings/api))
  for trending, recommendations, search and details.
- *Optional:* **qBittorrent** Web UI access, for live download progress.
- Docker.

Browsers: Safari (macOS/iOS) is the best-tested. Chrome and other Chromium-based browsers
work; Plex converts video they can't decode (such as HEVC), so expect more server load.

## Quick start (Docker Compose)

```yaml
services:
  sofarr:
    image: ghcr.io/chmod-r/sofarr:latest
    container_name: sofarr
    restart: unless-stopped
    ports:
      - "5656:5656"
    volumes:
      - ./sofarr:/data            # SQLite database (sign-ins, request history)
    env_file: .env                # see below
```

Copy [`.env.example`](.env.example) to `.env`, fill in your URLs and keys, run
`docker compose up -d`, and open `http://<your-server>:5656`.

**Networking.** Sofarr has to reach each service's URL from inside its container:

- If Plex uses host networking, a firewall on the host may block containers from
  reaching it. Allow Docker's subnet to reach port 32400, or use an address that works.
- If your *arr apps run behind a VPN container (sharing its network), use the VPN
  container's name and port, for example `http://gluetun:8989`.
- `/api/health/upstreams` (signed in as the admin profile) shows which services Sofarr
  can reach.

## Configuration

All settings are environment variables. Every service is optional at startup; anything
missing just turns off the features that need it.

| Variable | Default | Purpose |
|---|---|---|
| `SOFARR_PLEX_URL` | | Plex server, e.g. `http://192.168.1.10:32400` |
| `SOFARR_RADARR_URL`, `SOFARR_RADARR_API_KEY` | | Radarr (both or neither) |
| `SOFARR_SONARR_URL`, `SOFARR_SONARR_API_KEY` | | Sonarr (both or neither) |
| `SOFARR_QBITTORRENT_URL` | | qBittorrent Web UI, for live progress |
| `SOFARR_QBITTORRENT_USERNAME`, `…_PASSWORD` | | Leave unset if qBittorrent skips auth for Sofarr |
| `SOFARR_TMDB_API_KEY` | | TMDb v3 API key or v4 read access token |
| `SOFARR_RADARR_QUALITY_PROFILE`, `SOFARR_RADARR_ROOT_FOLDER` | most-used | What "Get it" uses for movies (profile name or id) |
| `SOFARR_SONARR_QUALITY_PROFILE`, `SOFARR_SONARR_ROOT_FOLDER` | most-used | What "Get it" uses for shows |
| `SOFARR_REGION` | `US` | Country for release dates (ISO 3166-1) |
| `SOFARR_LANGUAGE` | `en-US` | Language for titles and descriptions |
| `SOFARR_PORT` | `5656` | Listening port |
| `SOFARR_LOG_LEVEL` | `info` | `fatal` … `trace`, or `silent` |
| `SOFARR_TRUST_PROXY` | `false` | Set behind a reverse proxy that terminates TLS |
| `SOFARR_UPSTREAM_TIMEOUT_MS` | `5000` | Timeout for calls to the services above |
| `SOFARR_DATA_DIR` | `/data` | Where the database lives |

"Most-used" means: if unset, Sofarr uses the quality profile and root folder that most
of your existing Radarr/Sonarr library already uses.

## Using it

1. **Sign in:** open Sofarr, then enter the code at [plex.tv/link](https://plex.tv/link)
   or scan the QR code. Plex will list "Sofarr" under your authorized devices.
2. **Pick a profile** (your Plex Home users; PIN-protected ones ask for the PIN).
3. **Browse, search, Get it, watch.** In the player: Enter = play/pause, ←/→ = 10 s,
   ↓ = audio & subtitles, Back = exit.

## Security notes

- Sofarr stores Plex tokens in its database. Protect the data volume like you would
  Plex's own config.
- It's designed for your home network. Don't expose it to the internet directly. Put
  it behind a VPN (e.g. Tailscale) or a reverse proxy with authentication.
- Plex tokens and *arr keys never reach the browser: artwork and video are proxied
  through Sofarr.

## Known limitations

- Subtitles are burned into the picture by Plex, so turning them on makes Plex convert
  the video.
- Restarting Sofarr ends streams that are playing (press Play again to resume).
- Only the Plex server owner can sign in (friends with shared access: planned).

More, and what's planned: [GitHub Issues](https://github.com/chmod-R/sofarr/issues).

## Development

No Node.js needed on the host: `scripts/npm` runs npm inside a throwaway
`node:24-alpine` container.

```sh
scripts/npm install                # install dependencies
scripts/npm test                   # backend tests (fake Plex/*arr/TMDb)
scripts/npm run typecheck
scripts/npm run build -w web       # web UI → web/dist (served by the backend)
docker build -t sofarr:dev .
docker run --rm -p 5656:5656 --env-file .env -v ./data:/data sofarr:dev
```

The Android TV app builds in Docker too: see `android/run.sh` and
[Android TV app](docs/ARCHITECTURE.md#android-tv-app).

How it works and why: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness + version |
| `GET /api/health/upstreams` | Reachability of each service (admin profile) |
| `POST/GET /api/auth/pin` | Plex sign-in: get a code, then poll |
| `GET /api/auth/session`, `POST /api/auth/logout` | Current session / sign out |
| `GET /api/profiles`, `POST /api/profiles/:uuid/select` | Plex Home profiles |
| `GET /api/home` | Home-screen rows with status |
| `GET /api/search?q=` | Movies and shows matching a query, with status |
| `GET /api/titles/:mediaType/:tmdbId` | Title page: details, trailer, status, seasons |
| `GET /api/titles/tv/:tmdbId/seasons/:n` | One season's episodes with status and watch state |
| `POST /api/requests`, `GET /api/requests` | "Get it", and request history |
| `POST /api/play` | Start playback; returns an HLS URL (or, with `mode: "direct"`, the original file's URL) and audio/subtitle tracks |
| `POST /api/play/:id/tracks` | Switch audio/subtitles |
| `POST /api/play/:id/progress` | Report position/state to Plex |
| `GET /api/plex/image` | Resized Plex artwork |

## Not affiliated

Sofarr is an independent project. It isn't affiliated with or endorsed by Plex, TMDb,
the Radarr/Sonarr projects, or any streaming service. This product uses the TMDb API
but is not endorsed or certified by TMDb.

## License

[MIT](LICENSE)
