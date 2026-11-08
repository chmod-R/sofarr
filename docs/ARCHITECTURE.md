# Sofarr architecture

How Sofarr works and why it's built this way. For contributors; users want the
[README](../README.md).

## Goal

One TV-friendly app to **browse → request → watch**. Sofarr plays video itself, using
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
- **Web first.** A browser UI that works on a TV, laptop or phone, built so its logic
  can carry over to a native TV app later.
- **One container.** Easy to self-host next to an existing stack; state in one SQLite file.
- **Plex is the source of truth** for identity, profiles, library and watch state; the
  *arr apps for what's wanted and downloading. Sofarr stores only what those don't
  (sessions, request history).
- **Secrets stay server-side,** and every upstream is a configurable URL, with no
  assumptions about how the stack is networked.

## Components

```
 Browser (TV / laptop / phone)
   │  same-origin HTTP: JSON API, HLS playlists and segments, static UI
   ▼
 Sofarr (one container: Fastify backend + built React UI, SQLite)
   ├─ plex.tv ........ sign-in (PIN), Plex Home users, server access tokens
   ├─ Plex server .... library, watch state, artwork, universal transcoder (HLS)
   ├─ Radarr/Sonarr .. library, queue, add/monitor/search ("Get it")
   ├─ qBittorrent .... live download progress (optional)
   └─ TMDb ........... trending, recommendations, search, details, release dates
```

- **Single container.** The backend serves the built web UI. State is one SQLite file.
- **Every upstream is a URL in config.** No assumptions about how they're networked
  (for example, *arr apps behind a VPN container are reached at whatever host:port works).
- **All upstreams are optional at boot.** `/api/health/upstreams` (admin) shows what's
  reachable; missing sources only remove the features that need them.

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript, backend and UI | Shared types; UI logic can carry over to a future React Native TV app. |
| Backend | Node 24 LTS, Fastify 5, zod 4 | Small, fast; typed config and request validation. |
| Database | `node:sqlite` (built into Node), WAL, append-only migrations via `user_version` | No native add-on to compile; npm blocks install scripts by default. |
| UI | React 19, Vite, plain CSS, [Norigin Spatial Navigation](https://github.com/NoriginMedia/Norigin-Spatial-Navigation) | D-pad/arrow-key navigation for TVs; mouse and touch work too. Plain CSS keeps TV browsers fast and focus styling fully controllable. |
| Non-Safari playback | [hls.js](https://github.com/video-dev/hls.js) (Apache-2.0), lazy-loaded | Safari plays HLS natively and never downloads it. |
| Config | `SOFARR_*` environment variables | Container-native. A settings UI may come later. |
| License | MIT | |

## Identity, profiles and sessions

- **Plex is the identity provider.** Sign-in uses Plex's PIN flow: Sofarr shows a code
  (and QR) for plex.tv/link and polls until it's linked. Sofarr stores no passwords.
- **Who can sign in:** currently only the owner of the configured Plex server
  (`resources` → `owned`). Friends with shared access are a planned extension.
- **Profiles are Plex Home users.** Selecting one switches via plex.tv (Plex enforces
  profile PINs) and stores that profile's server access token. All Plex reads use the
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

- **Home rows** (`/api/home`): Continue Watching · Downloading Now · Because you watched
  … (×3, seeded by the most recently watched titles) · Trending Movies · Trending TV ·
  Recently Added. Empty rows are dropped. A failed source drops only its rows and adds a
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
- **Caching** (in memory, with in-flight de-duplication): TMDb 6 h (details and
  release dates 24 h), Plex library 60 s, Continue Watching and *arr 30 s. Plex data is
  dropped when playback pauses or stops, so watch state shows up immediately.
- **Known gap:** Recently Added sorts shows by when the show was added, not by its
  newest episode.

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
  can take 10+ seconds: 30 s timeout, 24 h cache. Title pages wait at most 3 s for
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

- `POST /api/play` resolves what to play (a show plays Plex's on-deck episode; resumes
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
- **Up next:** episodes get a 10 s countdown to the next episode (across seasons).
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

## Web UI

- **TV-style layout:** the hero panel shows the *focused* card; Enter opens its title
  page; Continue Watching cards resume directly. Back = Escape, Backspace, or the TV's
  back key (Tizen 10009, webOS 461).
- The player handles keys itself: Enter play/pause, ←/→ 10 s, ↓ audio & subtitles.
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

See [GitHub Issues](https://github.com/chmod-R/sofarr/issues). Larger directions: a native TV app (React Native tvOS or a
Google TV wrapper), friends with shared access signing in, request approvals/quotas,
and remote access.
