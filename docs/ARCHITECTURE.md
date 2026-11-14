# Sofarr architecture

How Sofarr works and why it's built this way. For contributors; users want the
[README](../README.md).

## Goal

One app on the **Google TV Streamer** to **browse → request → watch**. Sofarr plays
video itself, using Plex as the stream source, so you never switch to another app.

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
- **Google TV only.** The client is a native Android TV app for the Google TV Streamer
  (Kotlin, Compose for TV, Media3). No other devices are targeted. The web UI predates
  this decision and is kept only until the app replaces it; it gets no new work.
- **Native playback.** The app's player plays files as Plex has them wherever the
  Streamer can decode them, and only asks Plex to transcode what it can't.
- **One server container.** The backend is easy to self-host next to an existing stack,
  with state in one SQLite file. The app is a client of its API.
- **Plex is the source of truth** for identity, profiles, library and watch state; the
  *arr apps for what's wanted and downloading. Sofarr stores only what those don't
  (sessions, request history).
- **Secrets stay server-side,** and every upstream is a configurable URL, with no
  assumptions about how the stack is networked.

## Components

```
 Sofarr Android TV app (Google TV Streamer)
   │  HTTP on the home network: JSON API, video
   ▼
 Sofarr server (one container: Fastify backend, SQLite; still serves the legacy web UI)
   ├─ plex.tv ........ sign-in (PIN), Plex Home users, server access tokens
   ├─ Plex server .... library, watch state, artwork, universal transcoder (HLS)
   ├─ Radarr/Sonarr .. library, queue, add/monitor/search ("Get it")
   ├─ qBittorrent .... live download progress (optional)
   └─ TMDb ........... trending, recommendations, search, details, logos, release dates
```

- **Single server container.** State is one SQLite file. It also serves the legacy web UI
  until the app replaces it.
- **Every upstream is a URL in config.** No assumptions about how they're networked
  (for example, *arr apps behind a VPN container are reached at whatever host:port works).
- **All upstreams are optional at boot.** `/api/health/upstreams` (admin) shows what's
  reachable; missing sources only remove the features that need them.

| Area | Choice | Why |
|---|---|---|
| App | Kotlin, [Compose for TV](https://developer.android.com/training/tv/playback/compose) (`androidx.tv:tv-material`), Media3/ExoPlayer, OkHttp, kotlinx.serialization | Google's own TV toolkit, so focus, rows and motion feel like the rest of Google TV; ExoPlayer plays far more formats than a browser. |
| App build | Gradle (wrapper), Android SDK in a Docker image (`android/Dockerfile`) | No Android tooling on the host; see [Android TV app](#android-tv-app). |
| Language | TypeScript, backend (and legacy web UI) | |
| Backend | Node 24 LTS, Fastify 5, zod 4 | Small, fast; typed config and request validation. |
| Database | `node:sqlite` (built into Node), WAL, append-only migrations via `user_version` | No native add-on to compile; npm blocks install scripts by default. |
| Legacy web UI | React 19, Vite, plain CSS, [Norigin Spatial Navigation](https://github.com/NoriginMedia/Norigin-Spatial-Navigation), [hls.js](https://github.com/video-dev/hls.js) | Being replaced by the app. |
| Config | `SOFARR_*` environment variables | Container-native. A settings UI may come later. |
| License | MIT | |

## Identity, profiles and sessions

- **Plex is the identity provider.** Sign-in uses Plex's PIN flow: Sofarr shows a code
  (and QR) for plex.tv/link and polls until it's linked. Sofarr stores no passwords.
- **Who can sign in:** currently only the owner of the configured Plex server
  (`resources` → `owned`). Friends with shared access are a planned extension.
- **Profiles are Plex Home users.** Selecting one switches via plex.tv (Plex enforces
  profile PINs; the owner's own profile has no switch to make, so a PIN on it is checked
  the same way, by switching to it) and stores that profile's server access token. All Plex reads use the
  selected profile's token, so history, Continue Watching and library visibility are
  per profile.
- **Sessions:** a random cookie (`httpOnly`, `SameSite=Lax`), stored only as a SHA-256
  hash, 30-day sliding expiry. State-changing requests with a foreign `Origin` are
  rejected. The pending-PIN cookie binds a sign-in to the browser that started it.
- **Tokens never reach the browser.** Plex tokens and *arr keys stay server-side;
  artwork and video are proxied. Tokens are stored in SQLite (files mode 600);
  encrypting them with a key stored beside the database would add little.
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
  the UI draws as numbered cards.
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
  `originallyAvailableAt`: release or premiere date), so the UI can re-sort by
  Release Date ↑ (oldest first) or ↓ (newest first); unknown dates go last. The choice
  is remembered per browser. Like everywhere else, only items Plex has matched to a
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

Sofarr has its own player. Plex's universal transcoder produces HLS, and Sofarr proxies
it:

- `POST /api/play` (default `mode: "hls"`; the app's `direct` mode is under
  [Android TV app](#android-tv-app)) resolves what to play (a show plays Plex's on-deck episode; resumes
  where Plex says, from the start if within the last 5%), asks Plex for a decision, and
  returns `/api/play/<id>/start.m3u8`. The id is an unguessable capability, because
  `<video>` requests may not carry cookies. The Plex token only travels in server→Plex
  headers.
- **Stream profile from browser capabilities.** Plex picks its built-in client profile
  from the client's identity. Its *Safari* profile transcodes 10-bit HEVC and E-AC3, but
  its *iOS* profile copies both into fMP4 HLS, which Safari on a Mac plays natively. So a
  browser reporting native HLS + HEVC Main 10 + E-AC3 gets the iOS profile (selected with
  `X-Plex-Client-Profile-Name`, keeping the product name "Sofarr"), and most libraries
  stream without re-encoding. Other browsers get fMP4 HLS for hls.js, with HEVC only if
  MediaSource can decode it.
- **Proxy details** (each found in end-to-end tests against a real Plex server):
  - Don't forward `Content-Length` when Plex sent `Content-Encoding`. `fetch()`
    decompresses, so the length is wrong and browsers wait forever for gzipped playlists.
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

- `/api/play` returns the item's audio and subtitle tracks. EIA-608 captions are left
  out; they're carried inside the video stream.
- Switching saves the choice to Plex with `PUT /library/parts/<id>?audioStreamID=&subtitleStreamID=`
  (per Plex user, as Plex's own apps do), then starts a fresh stream at the current
  position.
- **Subtitles are burned in** by Plex, so turning them on converts the video. Plex offers
  no separate subtitle track for *embedded* subtitles over HLS: `/library/streams/<id>`
  answers 501, "sidecar" delivery is reported unavailable for the iOS profile, and the
  Web profile muxes subtitles into the segments for Plex's own player. Burn-in works for
  every subtitle type (SRT, ASS, PGS, VobSub, DVB). Instant text subtitles via local
  extraction are [planned](https://github.com/chmod-R/sofarr/issues/4).

## Android TV app

The client, in `android/`: server address, Plex sign-in and profiles, Home, title pages
with requests, search, My Library (the web's second tab: sort switch remembered on the
device, then TV Shows and Movies grids), and the player (tracks, up next).

- **Look:** the web UI's design, carried over (`Ui.kt` holds its tokens). The web sizes in
  rem with the root at ~1.05vw, so on a 1080p TV 1 rem is about 10 dp of Android TV's
  960×540 dp screen: cards 182 dp, gutter 38 dp, hero 56% of the height, and so on. Same
  colours, focus ring (2 dp page-coloured gap, 2 dp accent), buttons, pills, cards
  (ribbons, badges, progress, outlined Top 10 numerals), hero with title logos, title
  pages, search keyboard, PIN pad and player overlay. Home pins the selected card to its
  row's left edge and the row to the top (a `BringIntoViewSpec`); other screens scroll
  only as far as needed, like a web page (Compose's TV default centres things instead).

- **Target:** the Google TV Streamer only (`minSdk` 34, Android TV 14). The manifest
  requires `android.software.leanback`, so it appears in the TV launcher (with a 16:9
  banner) and nowhere else.
- **Server address:** entered at first launch (`host:port` or a URL), checked against
  `/api/health`, then stored in the app's preferences. Nothing about any particular
  server is built in. Cleartext HTTP is allowed for every host, since Sofarr and Plex are
  plain HTTP on the home network and the host isn't known at build time.
- **Version:** one version for the whole project. Gradle reads `server/package.json`:
  `versionName` is that version and `versionCode` is `major×10000 + minor×100 + patch`.
- **Build and install** with `android/run.sh`, which runs everything in Docker:

  ```sh
  android/run.sh image                       # build env: JDK 21, Android SDK, adb
  android/run.sh build                       # debug APK
  android/run.sh pair HOST:PORT CODE         # once: Wireless debugging → pair with code
  SOFARR_TV=HOST:PORT android/run.sh install # Wireless debugging → IP address & port
  SOFARR_TV=HOST:PORT android/run.sh adb logcat
  ```

  Gradle downloads, the debug signing key and the adb pairing key are kept in the Docker
  volume `sofarr-android-cache`. If it's lost, pair again, and uninstall the app before
  the next install (the signing key changes). Builds use one JVM with the Kotlin compiler
  in-process, so they fit on a small server.
- **Session:** the same cookie session as the web UI, kept in the app's preferences
  (OkHttp cookie jar). Artwork loads through the same client (Coil), so
  `/api/plex/image` works unchanged. The app sends no `Origin`, which the CSRF guard allows.
- **Playback:** Media3/ExoPlayer, direct play first. `POST /api/play` with
  `mode: "direct"` starts no Plex transcode; `/api/play/<id>/file` streams the part's
  original file through Sofarr with byte ranges (the token stays server-side, as for HLS).
  ExoPlayer quietly skips tracks it can't decode, so the app checks the tracks: with no
  playable video, if the audio track selected in Plex can't be decoded, or on a decoder
  error, it reports "stopped" and asks for `mode: "hls"` with its decoders as
  capabilities (`nativeHls: false`, so fMP4), resuming at the same position.
- **Tracks:** `/api/play` lists each track's position in the file (`index`, null for a
  sidecar subtitle file, which is `external`). In direct play the app maps Plex's
  selection onto ExoPlayer's tracks (by position, else by order), so audio and embedded
  subtitles (SRT, ASS, PGS…) switch instantly with no conversion; `/tracks` on a direct
  session only saves the choice to Plex. Sidecar files, or formats the player can't
  draw, fall back to Plex burning them in (HLS), as on the web. Progress reports work
  the same in both modes.
- **Player:** the web player's overlay and keys: Enter play/pause, ←/→ 10 s with a
  running total, fast-forward/rewind 30 s, ↓ the button row (Start over, Next episode,
  Audio & Subtitles), Back exits; "You're watching" after 6 s paused; up-next card with a
  10 s countdown. The pill says Direct play, Direct stream or Converting.

## Legacy web UI

Kept only until the Android TV app replaces it; no new work goes into it.

- **Header tabs:** Home and My Library share one screen component. Switching tabs
  keeps focus on the tab; Back from My Library returns to Home.
- **TV-style layout:** the top of Home is a hero that follows the selected card: its
  artwork, title logo, year, type, rating, status and overview. The rows scroll in their
  own area underneath, so rows above the selected one slide out of sight. With keys or a
  remote, the selected card stays at the row's left edge and its row at the top of that
  area, so the selection doesn't move around; a mouse just scrolls what it points at
  into view. Each row remembers its position. The hero waits for the selection to rest
  (180 ms) before changing, cross-fades artwork only once it has loaded, and prefetches
  the neighbouring cards' artwork. It has nothing to focus.
- **Cards:** artwork with tighter corners than buttons, a "New" / "New episodes" ribbon
  from `fresh`, and a corner badge for anything you can't just play (a date when one is
  known). Top 10 cards have a large outlined numeral beside them. With a mouse, arrows
  at a row's edges page it sideways; the hero following the pointer is the hover
  preview.
- **Opening a title** from a card uses a view transition where the browser has them:
  the artwork on screen (the hero's on Home, else the card's) grows into the title
  page's backdrop while the rest cross-fades. The page shows that artwork at once, from
  what the card already had, with placeholders until the details arrive.
- **Title logos** replace the plain-text title in the hero and on title pages when TMDb
  has one (`/api/titles/:type/:id/logo` for the hero, looked up per focused title rather
  than for every card on Home; title pages get it with their details). Preference: the
  configured language, then language-neutral, then English; best rated first.
- **Header:** overlays the artwork with a shade and turns solid once the page scrolls
  (My Library). Search is an icon; the avatar opens a menu (Switch profile, Sign out)
  that holds focus until closed.
- **Title pages:** logo, year, age rating (the configured region's certification),
  runtime or season count, genres, rating, status, overview and the first billed cast.
  Shows list one season at a time: season tabs, a line about what you have and have
  watched, then a row per episode with a still, runtime, air date, synopsis and watch
  progress. Enter on a row plays the episode or requests it; "Get Season N" and "Get
  all missing seasons" cover bulk requests. The page opens on the season you're in the
  middle of. Stills and runtimes come from TMDb's matching season (Sonarr's list has no
  artwork), falling back to Plex's own for episodes in the library. Request results
  show in a toast.
- **More Like This** (`/api/titles/:type/:id/similar`): up to 12 TMDb recommendations
  with the home rows' quality bar and status merge, loaded after the page so it never
  delays it.
- **Loading:** screens show placeholders in the shape of their content, and images fade
  in when loaded. All motion is off under `prefers-reduced-motion`. Enter opens the title page; Continue Watching
  cards resume directly (their details show the episode's synopsis). Back = Escape,
  Backspace, or the TV's back key (Tizen 10009, webOS 461).
- Mouse hover only takes focus after a real mouse move, so content scrolling under a
  resting pointer can't steal focus from the D-pad.
- **Player:** it handles keys itself. On the video: Enter play/pause, ←/→ skip 10 s
  (repeated presses show the running total), Back exits. ↓ moves to a button row (Start
  over, Next episode, Audio & Subtitles, Full screen): ←/→ choose, Enter selects, ↑ or
  Back returns to the video, as does leaving it alone for 8 s. For a mouse or touch
  there are centre buttons (back 10, play/pause, forward 10) and a scrub bar that shows
  the time under the pointer and can be dragged. Paused and untouched for 6 s, the
  controls give way to a "what's playing" screen with the synopsis. At the end of an
  episode a card with the next episode's thumbnail counts down 10 s.
- The root font size scales with the viewport, so one layout works on a TV, a laptop
  and a phone.
- Home refreshes every 60 s (15 s while something downloads); title pages every 10 s
  while downloading.
- **Serving:** hashed assets are cached immutably; the HTML shell is always revalidated.
  Non-`/api` GETs fall back to the app. The CSP allows only self, https images,
  youtube-nocookie frames, and `blob:` media and workers (hls.js). The trailer iframe
  sends an origin-only referrer, because YouTube refuses embeds without one (Error 153).
- **Look:** a dark, row-based streaming layout, written from scratch. It uses no
  third-party UI code and no streaming-service names, logos or colours.

## Testing

- `scripts/npm test` runs the backend suite (Vitest, Fastify `inject`) against fake Plex,
  plex.tv, Radarr, Sonarr, qBittorrent and TMDb servers, with an injectable clock so
  results don't depend on today's date.
- End-to-end checks against a real Plex server (headless Chrome over the DevTools
  protocol) caught bugs the fakes couldn't. They report real progress to Plex, so start
  test playback at 0:00 and keep it short.

## Not built yet

See [GitHub Issues](https://github.com/chmod-R/sofarr/issues). Larger directions: the Android TV app (sign-in, Home, native
playback, then the rest of the web UI's features, then retiring the web UI), friends
with shared access signing in, request approvals/quotas, and remote access.
