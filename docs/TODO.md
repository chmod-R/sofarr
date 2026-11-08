# To-do

Open work, to be moved into GitHub Issues. How things work today:
[ARCHITECTURE.md](ARCHITECTURE.md).

## Features
- [ ] **Skip intro / credits** using Plex's intro and credits markers.
- [ ] **Instant text subtitles.** Read the media files (read-only mount) and extract
      SRT/ASS tracks with ffmpeg, served as WebVTT, so text subtitles switch instantly
      without Plex converting the video. Image subtitles (PGS, VobSub, DVB) would still
      be burned in.
- [ ] **Survive restarts mid-playback.** Persist playback sessions (SQLite), or have the
      player start a fresh stream at its current position when its stream disappears.
- [ ] **Friends sign-in.** Let Plex users the server is shared with sign in (today: the
      owner and their Plex Home only).
- [ ] **Request approvals / quotas** for non-admin profiles.
- [ ] **Better recommendations:** blend several watched titles, add TMDb `/similar`, or
      use Trakt.
- [ ] **Recently Added** should sort shows by their newest episode, not when the show
      was first added.
- [ ] **Native TV app:** React Native tvOS, or wrap the web UI for Google TV.
- [ ] **Remote access** guidance (Tailscale / reverse proxy with auth).
- [ ] **Settings UI** instead of environment variables only.

## Verification gaps
- [ ] Episode requests for a show Sonarr doesn't have yet: tested against a fake Sonarr
      only.
- [ ] Switching to a second Plex Home user: tested against a fake plex.tv only.

## Project
- [ ] CI: typecheck, tests and image build on every push/PR; publish to GHCR on main
      (`:edge`) and on version tags (`:latest`, `:x.y.z`).
- [ ] Web UI tests (component tests or a headless-browser suite against the fakes).
