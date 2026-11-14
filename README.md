# Sofarr

A sofa-friendly, Netflix-like Android TV app for a self-hosted **Plex + Radarr + Sonarr**
setup. Browse what to watch, get anything you don't have yet, and play it, all with the
TV remote. Built for and tested on the Google TV Streamer.

Sofarr has two parts: the **app** on your TV, and a small **server** that runs next to
your Plex and *arr apps (one Docker container). The app talks only to the server.

## What it does

- **Browse.** Rows like Continue Watching, Because you watched…, Top 10 Movies and Shows,
  Coming Soon, Downloading Now and Recently Added, under a header that shows the selected
  title. Every title shows whether it's in your library, downloading, requested, coming
  soon (with its digital release date), or available to get. **My Library** lists
  everything you have, by title or release date.
- **Search** any movie or show with an on-screen keyboard.
- **Get it.** One button adds a movie to Radarr, or chosen seasons (or single episodes)
  to Sonarr, and starts the search. Unreleased movies download when they come out.
  Download progress shows live.
- **Watch** in Sofarr's own player, streamed from your Plex server:
  - plays most files as they are (direct play: HEVC, Dolby Digital and more, with no
    work for the server); Plex converts only what the TV can't decode
  - audio and subtitle tracks in the file switch instantly
  - resumes where you left off; watched status syncs back to Plex
  - up-next countdown for episodes
- **Plex sign-in and profiles.** Sign in with a code at plex.tv/link (or a QR code).
  Profiles are your Plex Home users, with their own history and PINs.

## Requirements

- An **Android TV** device with Android 14 or later (Google TV Streamer, or similar).
- **Plex Media Server.** Sign-in is limited to the server's owner for now.
- **Radarr** and/or **Sonarr** (v3 API; Sonarr v4 recommended).
- A free **TMDb API key** ([themoviedb.org → Settings → API](https://www.themoviedb.org/settings/api))
  for trending, recommendations, search and details.
- *Optional:* **qBittorrent** Web UI access, for live download progress.
- Docker, for the server (and for building the app).

## Server: quick start (Docker Compose)

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

Copy [`.env.example`](.env.example) to `.env`, fill in your URLs and keys, and run
`docker compose up -d`. `http://<your-server>:5656/api/health` answers when it's up.

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

## The app: build and install

The app isn't in the Play Store; you build it and install it over the network. Nothing
but Docker is needed: `android/run.sh` runs the Android toolchain in a container.

1. **Build:** `android/run.sh image` (once), then `android/run.sh release`. The release
   signing key is made on first use and kept in a Docker volume.
2. **On the TV:** Settings → System → About → click *Android TV OS build* 7 times to
   enable Developer options; then Developer options → **Wireless debugging** on.
3. **Pair once:** Wireless debugging → *Pair device with pairing code*, then
   `android/run.sh pair HOST:PORT CODE` with what the TV shows.
4. **Install:** `SOFARR_TV=HOST:PORT android/run.sh install release`, with the *IP address
   & Port* from the Wireless debugging screen (the port changes when it's turned off and on).

Sofarr then appears in the TV's apps.

## Using it

1. **Server:** on first launch, enter your server's address (for example
   `192.168.1.10:5656`).
2. **Sign in:** enter the code shown at [plex.tv/link](https://plex.tv/link), or scan the
   QR code. Plex will list "Sofarr" under your authorized devices.
3. **Pick a profile** (your Plex Home users; PIN-protected ones ask for the PIN).
4. **Browse, search, Get it, watch.** In the player: Enter = play/pause, ←/→ = 10 s,
   ↓ = more (Start over, Next episode, Audio & Subtitles), Back = exit.

## Security notes

- Sofarr stores Plex tokens in its database. Protect the data volume like you would
  Plex's own config.
- It's designed for your home network, and the app talks to it over plain HTTP. Don't
  expose it to the internet directly; use a VPN (e.g. Tailscale) for access from outside.
- Plex tokens and *arr keys never reach the app: artwork and video are proxied through
  the server.

## Known limitations

- Subtitles that aren't in the file (sidecar files), or that the TV can't draw, are
  burned into the picture by Plex, which converts the video.
- Restarting the server ends streams that are playing (press Play again to resume).
- Only the Plex server owner can sign in (friends with shared access: planned).

More, and what's planned: [GitHub Issues](https://github.com/chmod-R/sofarr/issues).

## Development

No Node.js or Android tooling needed on the host: `scripts/npm` runs npm inside a
throwaway `node:24-alpine` container, and `android/run.sh` builds the app in Docker.

```sh
scripts/npm install                # install server dependencies
scripts/npm test                   # server tests (fake Plex/*arr/TMDb)
scripts/npm run typecheck
docker build -t sofarr:dev .
docker run --rm -p 5656:5656 --env-file .env -v ./data:/data sofarr:dev
android/run.sh build               # debug APK; `install` without `release` installs it
```

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
| `GET /api/library` | The profile's library: TV Shows and Movies |
| `GET /api/search?q=` | Movies and shows matching a query, with status |
| `GET /api/titles/:mediaType/:tmdbId` | Title page: details, trailer, status, seasons |
| `GET /api/titles/tv/:tmdbId/seasons/:n` | One season's episodes with status and watch state |
| `POST /api/requests`, `GET /api/requests` | "Get it", and request history |
| `POST /api/play` | Start playback: the original file (`mode: "direct"`) or an HLS stream, with audio/subtitle tracks |
| `POST /api/play/:id/tracks` | Switch audio/subtitles |
| `POST /api/play/:id/progress` | Report position/state to Plex |
| `GET /api/plex/image` | Resized Plex artwork |

## Not affiliated

Sofarr is an independent project. It isn't affiliated with or endorsed by Plex, TMDb,
Google, the Radarr/Sonarr projects, or any streaming service. This product uses the
TMDb API but is not endorsed or certified by TMDb.

## License

[MIT](LICENSE)
