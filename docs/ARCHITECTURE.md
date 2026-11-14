# Sofarr architecture

How Sofarr works and why it's built this way. For contributors; users want the
[README](../README.md).

## Goal

One app on the TV to **browse → request → watch**. Sofarr plays video itself, using
Plex as the stream source, so you never switch to another app.

Without it, a typical Plex + *arr household picks something to watch somewhere else,
requests it in Radarr/Sonarr (often from a phone), then switches to Plex on the TV to
watch. The existing pieces each cover only part of that:

- **Request apps** (Overseerr, Jellyseerr, Seerr) are good at browsing and requesting,
  but don't play anything: "Play" sends you to Plex.
- **Plex's Watchlist and Discover** can drive automatic downloads, but its suggestions
  are mostly what's on its own rental and streaming partners, not recommendations based
  on your library.

### Principles

- **One app all the way through.** Browsing, requesting and playback happen in Sofarr;
  never hand off to the Plex app.
- **Android TV.** The client is a native Android TV app (Kotlin, Compose for TV, Media3),
  built for and tested on the Google TV Streamer. It needs Android 14 (API 34) or later.
- **Native playback.** The app plays files as Plex has them wherever the device can
  decode them, and only asks Plex to convert what it can't.
- **One server container.** The server is easy to self-host next to an existing stack,
  with state in one SQLite file. The app is a client of its API.
- **Plex is the source of truth** for identity, profiles, library and watch state; the
  *arr apps for what's wanted and downloading. Sofarr stores only what those don't
  (sessions, request history).
- **Secrets stay server-side,** and every upstream is a configurable URL, with no
  assumptions about how the stack is networked.

## Components

```
 Sofarr app (Android TV)
   │  HTTP on the home network: JSON API, artwork, video
   ▼
 Sofarr server (one container: Fastify, SQLite)
   ├─ plex.tv ........ sign-in (PIN), Plex Home users, server access tokens
   ├─ Plex server .... library, watch state, artwork, media files, universal transcoder (HLS)
   ├─ Radarr/Sonarr .. library, queue, add/monitor/search ("Get it")
   ├─ qBittorrent .... live download progress (optional)
   └─ TMDb ........... trending, recommendations, search, details, logos, release dates
```

- **Single server container.** State is one SQLite file. The server is an API only.
- **Every upstream is a URL in config.** No assumptions about how they're networked
  (for example, *arr apps behind a VPN container are reached at whatever host:port works).
- **All upstreams are optional at boot.** `/api/health/upstreams` (admin) shows what's
  reachable; missing sources only remove the features that need them.

| Area | Choice | Why |
|---|---|---|
| App | Kotlin, [Compose for TV](https://developer.android.com/training/tv/playback/compose) (`androidx.tv:tv-material`), Media3/ExoPlayer, OkHttp, Coil, kotlinx.serialization | Google's own TV toolkit, so focus, rows and motion feel native; ExoPlayer plays most files as they are. |
| App build | Gradle (wrapper), Android SDK in a Docker image (`android/Dockerfile`) | No Android tooling on the host; see [The app](#the-app). |
| Server | TypeScript, Node 24 LTS, Fastify 5, zod 4 | Small, fast; typed config and request validation. |
| Database | `node:sqlite` (built into Node), WAL, append-only migrations via `user_version` | No native add-on to compile; npm blocks install scripts by default. |
| Config | `SOFARR_*` environment variables | Container-native. A settings UI may come later. |
| License | MIT | |

## Identity, profiles and sessions

- **Plex is the identity provider.** Sign-in uses Plex's PIN flow: the app shows a code
  (and QR code) for plex.tv/link and polls until it's linked. Sofarr stores no passwords.
- **Who can sign in:** currently only the owner of the configured Plex server
  (`resources` → `owned`). Friends with shared access are a planned extension.
- **Profiles are Plex Home users.** Selecting one switches via plex.tv (Plex enforces
  profile PINs; the owner's own profile has no switch to make, so a PIN on it is checked
  the same way, by switching to it) and stores that profile's server access token. All
  Plex reads use the selected profile's token, so history, Continue Watching and library
  visibility are per profile.
- **Sessions:** a random cookie (`httpOnly`, `SameSite=Lax`), stored only as a SHA-256
  hash, 30-day sliding expiry; the app keeps it in its preferences. The pending-PIN
  cookie binds a sign-in to the client that started it. State-changing requests that
  carry a foreign `Origin` (a web page elsewhere) are rejected; the app sends none.
- **Tokens never reach the app.** Plex tokens and *arr keys stay server-side; artwork
  and video are proxied. Tokens are stored in SQLite (files mode 600); encrypting them
  with a key stored beside the database would add little.
- **Restricted (managed) Plex profiles can't request** titles. Every request is logged
  with its profile; admins see all requests, others see their own.

## Catalog: one status per title

Titles are merged across sources by **TMDb id**: Plex items carry TMDb GUIDs
(`includeGuids`), and Radarr/Sonarr both store `tmdbId`. Each title gets one status:

`owned` (in the profile's Plex library) > `downloading` (in the *arr queue, or imported
but not yet scanned by Plex) > `requested` (tracked by *arr, nothing downloading) >
`upcoming` > `available`. Shows getting new episodes can be `owned` with a `download`.

- **Home rows** (`/api/home`): Continue Watching · Downloading Now · Coming Soon ·
  Because you watched … (×3, seeded by the most recently watched titles) · Top 10 Movies
  This Week · Top 10 Shows This Week · Recently Added. Empty rows are dropped. A failed source drops only its rows and adds a
  `warnings` entry, so the screen still renders.
- **Recommendations** come from TMDb `/recommendations`, filtered to ≥100 votes and
  ≥6.0 rating; unfiltered results are often poor. Still the weakest row: blending seeds,
  `/similar`, or Trakt are candidates.
- **Release status.** Movies without a regional digital or physical release (TMDb
  release types 4/5) are `upcoming`, with `availableFrom` when known, and **not hidden**.
  "Get it" adds them to Radarr, which downloads on release. Hiding them removed the most
  wanted titles. Older movies with no regional data are assumed out after 120 days.
- **Artwork:** TMDb CDN for TMDb items; Plex artwork through `/api/plex/image`, which
  only allows `/library/metadata/<n>/(thumb|art|clearLogo)/<n>` and has Plex resize it.
- **Search** (`/api/search`): TMDb multi-search with people dropped and near-empty
  entries last, then the same status merge. Library titles without TMDb artwork use
  Plex's.
- **Detail responses are trimmed before caching.** TMDb's details with cast, ratings
  and image lists appended are large; only the fields Sofarr uses are kept in memory.
- **Caching** (in memory, with in-flight de-duplication): TMDb 6 h (details and
  release dates 24 h), Plex library 60 s, Continue Watching and *arr 30 s. Plex data is
  dropped when playback pauses or stops, so watch state shows up immediately.
- **Top 10** rows are TMDb's weekly trending list cut to ten and marked `ranked`, which
  the app draws as numbered cards.
- **Coming Soon:** titles Radarr/Sonarr track that have nothing downloaded or
  downloading yet. Ones that aren't out carry the date they're due (a movie's home
  release, a show's premiere) and come first, soonest first; the rest are still being
  searched for.
- **New in the library.** A show's own `addedAt` is when the show first arrived, so the
  library also reads each show section's 100 most recently added episodes to learn when
  each show last got one. Recently Added sorts by that, and library titles carry
  `fresh` for 14 days: `new` (just added) or `new-episodes`. A show whose newest
  episode is older than those 100 falls back to its own date.
- **My Library** (`/api/library`, the header's second tab): the profile's whole Plex
  library as two card grids, TV Shows then Movies, with no limit. The server sends title
  order, like Plex: its sort title when set, else the title without a leading
  "The/A/An", then year. Each item also carries `released` (Plex's
  `originallyAvailableAt`: release or premiere date), so the app can re-sort by
  Release Date ↑ (oldest first) or ↓ (newest first); unknown dates go last. The choice
  is remembered on the device. Like everywhere else, only items Plex has matched to a
  TMDb id appear.

## Requests ("Get it")

- **Defaults** (quality profile, root folder, minimum availability, season folders,
  series type) are **whatever most of the existing *arr library uses**, else the first
  available. *arr has no "default profile" API, and the library majority matches how
  people actually use it. Overridable with `SOFARR_{RADARR,SONARR}_{QUALITY_PROFILE,ROOT_FOLDER}`.
- **Movies:** new → add with `searchForMovie`. Unmonitored → re-monitor and
  `MoviesSearch`. Already on disk → no-op (`already_have`). Never creates duplicates.
- **Seasons:** new show → add with per-season `monitored` flags and *no*
  `addOptions.monitor` (the approach Overseerr/Jellyseerr use), plus
  `searchForMissingEpisodes`. Existing show → monitor the added seasons, then
  `SeriesSearch`. `monitorNewItems` is `all` only if the latest season was chosen:
  following future seasons only makes sense if you asked for the current one.
- **Episodes:** tracked show → `PUT /api/v3/episode/monitor` plus `EpisodeSearch`.
  Untracked → add with nothing monitored, wait (≤90 s) for Sonarr's refresh to create
  the episode list, then monitor and search. Season searches usually grab a season pack,
  so nothing is watchable until the whole pack finishes; episode searches look for
  single-episode releases (often scarcer for older shows).
- **Slow lookups.** *arr metadata lookups go out to the internet (often via a VPN) and
  can take 10+ seconds: 30 s timeout, 24 h cache. Adding a movie or series does the same
  lookup inside *arr before it answers, so adds get 30 s too; if even that runs out, *arr
  usually still finishes, so Sofarr checks for the new item for another 30 s before
  reporting a failure. Title pages wait at most 3 s for
  Sonarr, then answer with TMDb data while the lookup finishes into the cache.

### Season numbering

TMDb and TVDB (Sonarr) don't always number a show's seasons the same way. Example:
*The Great British Bake Off* is one show on TVDB (seasons 1–17) but two entries on TMDb
(2010–2016 as seasons 1–7, 2017 onward as seasons 1–10), so TMDb's "season 10" is
Sonarr's season 17. Requests go to Sonarr, so:

- **Sonarr's numbers are authoritative.** TMDb seasons are aligned by air years: same
  first year → the TMDb entry covers the early seasons; same last year → the latest
  seasons (an offset); identical numbering → identity. Anything else → show Sonarr's
  numbers only (`sonarr-only`) and **never guess**.
- Title pages expose `seasonNumbering` and per-season `tmdbNumber`. Requests declare
  which numbering they use; TMDb numbers are translated server-side, or rejected with
  409 if they can't be aligned.
- Sonarr lookups fall back to the TMDb entry's TVDB id (one of the split entries
  usually isn't linked from TVDB), and existing series are matched by TVDB id too.

## Downloads

- Progress comes from the *arr queue, which *arr refreshes about once a minute. If
  qBittorrent is configured, Sofarr overlays **live** percent, ETA, speed and state from
  it (5 s cache, one reusable session), matched by the queue's `downloadId` (the torrent
  hash; a season pack appears once per episode but counts once). If qBittorrent is
  unreachable, the *arr numbers are used.

## Playback

Sofarr has its own player. It plays the original file wherever it can (direct play)
and falls back to Plex's universal transcoder (HLS); both are proxied by the server.

- `POST /api/play` resolves what to play (a show plays Plex's on-deck episode; resumes
  where Plex says, from the start if within the last 5%) and registers a playback
  session. Its id is an unguessable capability in every media URL, because the player's
  requests carry no cookies. The Plex token only travels in server→Plex headers.
- **Direct play** (`mode: "direct"`): no Plex transcode. `/api/play/<id>/file` streams
  the part's original file with byte ranges, so the player can seek.
- **Fallback** (`mode: "hls"`, with the device's decoders as `capabilities`): ExoPlayer
  quietly skips tracks it can't decode, so the app checks: with no playable video, if
  the audio track selected in Plex can't be decoded, or on a decoder error, it reports
  "stopped" and asks for HLS, resuming at the same position. The stream uses Plex's
  generic "Chrome" client profile plus a transcode target that lets Plex copy HEVC,
  AC3 and E-AC3 when the device decodes them.
- **Proxy details** (each found in end-to-end tests against a real Plex server):
  - Don't forward `Content-Length` when Plex sent `Content-Encoding`. `fetch()`
    decompresses, so the length is wrong and players wait forever for gzipped playlists.
  - Label fMP4 segments `video/mp4`; Plex sends `application/octet-stream`.
  - Retry once when Plex answers a segment with an empty 200 while its transcoder starts.
  - Stop idle playback sessions after 30 minutes.
- **Progress** goes to Plex's `/:/timeline` every 10 s and on pause and stop, so resume
  points, watched status and Continue Watching stay in sync with other Plex apps.
- **Up next:** episodes get a 10 s countdown to the next episode (across seasons), with
  its thumbnail. It appears when the episode ends; showing it over the credits needs
  credit markers ([planned](https://github.com/chmod-R/sofarr/issues/3)).
- **Known limitation:** playback sessions live in memory, so restarting Sofarr ends
  in-progress streams.

### Audio and subtitles

- `/api/play` returns the item's audio and subtitle tracks with each one's position in
  the file (`index`; null for a sidecar subtitle file, which is `external`). EIA-608
  captions are left out; they're carried inside the video stream.
- **Direct play:** the app maps Plex's selection onto ExoPlayer's tracks (by position,
  else by order), so audio and embedded subtitles (SRT, ASS, PGS…) switch instantly.
  `/tracks` on a direct session only saves the choice to Plex.
- **Saved per Plex user,** as Plex's own apps do: `PUT /library/parts/<id>?audioStreamID=&subtitleStreamID=`.
- **Converted streams:** Plex burns subtitles in, so turning them on converts the video,
  and `/tracks` restarts the stream at the current position. Plex offers no separate
  subtitle track for *embedded* subtitles over HLS (`/library/streams/<id>` answers 501),
  and burn-in works for every subtitle type (SRT, ASS, PGS, VobSub, DVB). Sidecar files,
  or formats the device can't draw, use this path in direct play too.

## The app

`android/`: four activities (`MainActivity` for sign-in, profiles, Home and My Library;
`TitleActivity`, `SearchActivity`, `PlayerActivity`), Compose for TV for the UI and
Media3 for playback.

- **Target:** Android TV 14 or later (`minSdk` 34), built for and tested on the Google
  TV Streamer. The manifest requires `android.software.leanback`, so it appears in the
  TV launcher (with a 16:9 banner).
- **Server address:** entered at first launch (`host:port` or a URL), checked against
  `/api/health`, then stored in the app's preferences. Nothing about any particular
  server is built in. Cleartext HTTP is allowed for every host, since Sofarr and Plex are
  plain HTTP on the home network and the host isn't known at build time.
- **Network:** one OkHttp client with a persistent cookie jar; artwork loads through it
  too (Coil), so `/api/plex/image` works unchanged. Requests to Radarr/Sonarr get a long
  read timeout, since the server waits on them.
- **Screens:**
  - *Home:* a hero for the selected card (artwork, title logo, year, rating, status,
    overview), which follows the selection once it rests (180 ms); rows under it. With the
    remote, the selected card stays at its row's left edge and the row at the top of the
    rows area (a `BringIntoViewSpec`). Refreshes every 60 s (15 s while something downloads)
    and when coming back. Continue Watching cards resume straight away; others open the
    title page. The header has Home / My Library tabs, search and the profile menu
    (switch profile, sign out).
  - *My Library:* a sort switch (title, release date ↑/↓; remembered on the device), then
    TV Shows and Movies as card grids.
  - *Title page:* backdrop, logo, tagline, age rating, status, cast; Play / Get it /
    Trailer (opens YouTube); seasons with episode rows and per-season / per-episode
    requests; More Like This. Polls every 10 s while something is on its way.
  - *Search:* an on-screen keyboard and results grid; debounced, cached.
  - *Player:* Enter play/pause, ←/→ 10 s with a running total, fast-forward/rewind 30 s,
    ↓ a button row (Start over, Next episode, Audio & Subtitles), Back exits; a "You're
    watching" screen after 6 s paused; the up-next card. A pill says Direct play, Direct
    stream or Converting.
- **Look:** colours, spacing and components live in `Ui.kt` and `Cards.kt` (focus ring:
  a 2 dp page-coloured gap and 2 dp of accent; cards with the title over 16:9 artwork,
  ribbons, badges, progress; outlined Top 10 numerals). Android TV lays out on a
  960×540 dp screen. Pages scroll only as far as needed to show what has focus
  (Compose's TV default centres things instead).
- **Version:** one version for the whole project. Gradle reads `server/package.json`:
  `versionName` is that version and `versionCode` is `major×10000 + minor×100 + patch`.
- **Build and install** with `android/run.sh`, which runs everything in Docker:

  ```sh
  android/run.sh image                               # build env: JDK 21, Android SDK, adb
  android/run.sh build                               # debug APK
  android/run.sh release                             # signed release APK
  android/run.sh pair HOST:PORT CODE                 # once: Wireless debugging → pair with code
  SOFARR_TV=HOST:PORT android/run.sh install release # Wireless debugging → IP address & port
  SOFARR_TV=HOST:PORT android/run.sh adb logcat
  ```

  Gradle downloads, the signing keys and the adb pairing key are kept in the Docker
  volume `sofarr-android-cache` (the release key is made on first use). If it's lost,
  pair again, and uninstall the app before the next install (the signing key changes).
  Builds use one JVM with the Kotlin compiler in-process, so they fit on a small server.
  Debug builds also let adb open the player on any title, for testing:
  `am start -n io.github.chmodr.sofarr/.PlayerActivity --es plexKey <key> [--el offsetMs <ms>]`.

## Testing

- `scripts/npm test` runs the server suite (Vitest, Fastify `inject`) against fake Plex,
  plex.tv, Radarr, Sonarr, qBittorrent and TMDb servers, with an injectable clock so
  results don't depend on today's date.
- The app is checked on a real device over adb (screenshots, key events, logcat) against
  a real Plex server. Playback reports real progress to Plex, so use a test profile, or
  start test playback at 0:00 and keep it short.

## Not built yet

See [GitHub Issues](https://github.com/chmod-R/sofarr/issues). Larger directions:
friends with shared access signing in, request approvals/quotas, voice search, a Google
TV home-screen row (Continue Watching), and remote access.
