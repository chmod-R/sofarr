import { pause as pauseNav, resume as resumeNav } from "@noriginmedia/norigin-spatial-navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { PlayCapabilities, PlaySession } from "../api/types";
import { goBack, navigate } from "../router";

const PROGRESS_MS = 10_000;
const CONTROLS_HIDE_MS = 3500;
const SEEK_S = 10;
const UP_NEXT_S = 10;
/** Paused and untouched this long: show what's playing instead of the controls. */
const PAUSED_IDLE_MS = 6000;
/** The button row gives focus back to the video when left alone. */
const ROW_IDLE_MS = 8000;

const PlayIcon = () => (
  <svg className="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M7 4.5v15a.8.8 0 0 0 1.2.7l12.5-7.5a.8.8 0 0 0 0-1.4L8.200 3.800A.8.8 0 0 0 7 4.500z" />
  </svg>
);
const PauseIcon = () => (
  <svg className="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <rect x="5.500" y="4" width="4.500" height="16" rx="1" />
    <rect x="14" y="4" width="4.500" height="16" rx="1" />
  </svg>
);
/** A circular arrow around "10": back (dir -1) or forward (dir 1). */
const SkipIcon = ({ dir }: { dir: -1 | 1 }) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.800" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <g transform={dir === 1 ? "translate(24 0) scale(-1 1)" : undefined}>
      <path d="M5.200 8.500A8 8 0 1 1 4 13" />
      <path d="M5.600 3.800v4.900h4.900" />
    </g>
    <text x="12" y="16.200" textAnchor="middle" fontSize="7.500" fontWeight="700" fill="currentColor" stroke="none">
      10
    </text>
  </svg>
);

type RowButton = "restart" | "next" | "tracks" | "fullscreen";

/** What this browser can decode; decides whether Plex can stream files unconverted. */
export function detectCapabilities(): PlayCapabilities {
  const v = document.createElement("video");
  const can = (type: string) =>
    v.canPlayType(type) !== "" || (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(type));
  return {
    nativeHls: v.canPlayType("application/vnd.apple.mpegurl") !== "",
    hevc: can('video/mp4; codecs="hvc1.1.6.L120.90"'),
    hevcMain10: can('video/mp4; codecs="hvc1.2.4.L120.90"'),
    eac3: can('audio/mp4; codecs="ec-3"'),
    ac3: can('audio/mp4; codecs="ac-3"'),
  };
}

function clock(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

const BACK_KEYS = new Set(["Escape", "Backspace", "GoBack", "BrowserBack"]);
const BACK_CODES = new Set([10009, 461]);

/** One entry in the Audio & Subtitles panel. */
interface Choice {
  kind: "audio" | "subtitle";
  id: number; // subtitle 0 = off
  label: string;
  note?: string;
  selected: boolean;
}

function choicesOf(s: PlaySession): [Choice[], Choice[]] {
  const audio: Choice[] = s.tracks.audio.map((a) => ({ kind: "audio", id: a.id, label: a.label, selected: a.selected }));
  const anySub = s.tracks.subtitles.some((x) => x.selected);
  const subs: Choice[] = [
    { kind: "subtitle", id: 0, label: "Off", selected: !anySub },
    ...s.tracks.subtitles.map(
      (x): Choice => ({ kind: "subtitle", id: x.id, label: x.label, selected: x.selected, ...(x.forced && { note: "forced" }) }),
    ),
  ];
  return [audio, subs];
}

export function Player({ plexKey, offsetMs }: { plexKey: string; offsetMs?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<{ destroy(): void } | null>(null);
  const capsRef = useRef<PlayCapabilities | null>(null);
  const [session, setSession] = useState<PlaySession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [buffering, setBuffering] = useState(true);
  const [controls, setControls] = useState(true);
  const [upNext, setUpNext] = useState<number | null>(null);
  /** Highlighted "Up next" button: 0 = Play now, 1 = Cancel. */
  const [upNextChoice, setUpNextChoice] = useState<0 | 1>(0);
  /** Audio & Subtitles panel: which column (0 audio, 1 subtitles) and row is highlighted. */
  const [panel, setPanel] = useState<{ col: 0 | 1; row: number } | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  /** The highlighted button of the bottom row, when the remote is on it (else keys drive the video). */
  const [row, setRow] = useState<RowButton | null>(null);
  /** The last ←/→ skips, added up, for the on-screen "+30 s". */
  const [skipped, setSkipped] = useState<{ dir: -1 | 1; total: number; n: number } | null>(null);
  /** Where the pointer is on the scrub bar (seconds), and whether it's dragging. */
  const [scrub, setScrub] = useState<{ t: number; x: number; dragging: boolean } | null>(null);
  const [pausedIdle, setPausedIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const lastActivity = useRef(Date.now());
  const skipTimer = useRef<number>(0);
  const rootRef = useRef<HTMLElement>(null);
  const hideTimer = useRef<number>(0);
  const stopped = useRef(false);
  // The reporter reads the session from a ref so it never changes identity:
  // effects that depend on it must not re-run (and "clean up") when playback starts.
  const sessionRef = useRef<PlaySession | null>(null);

  const report = useCallback((state: "playing" | "paused" | "stopped") => {
    const s = sessionRef.current;
    const v = videoRef.current;
    if (!s || !v) return;
    void api.progress(s.id, Math.round(v.currentTime * 1000), state).catch(() => undefined);
  }, []);

  const exit = useCallback(() => {
    if (!stopped.current) {
      stopped.current = true;
      report("stopped");
    }
    goBack();
  }, [report]);

  const showControls = useCallback(() => {
    lastActivity.current = Date.now();
    setPausedIdle(false);
    setControls(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!videoRef.current?.paused) setControls(false);
    }, CONTROLS_HIDE_MS);
  }, []);

  // The player handles every key itself while it's open.
  useEffect(() => {
    pauseNav();
    return () => resumeNav();
  }, []);

  /** Point the <video> at a stream (natively in Safari, hls.js elsewhere) and start at `startSec`. */
  const attach = useCallback(async (s: PlaySession, startSec: number) => {
    const v = videoRef.current!;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    if (capsRef.current?.nativeHls) {
      v.src = s.src;
    } else {
      const { default: Hls } = await import("hls.js");
      if (!Hls.isSupported()) throw new Error("unsupported");
      const h = new Hls({ startPosition: startSec });
      h.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) setError("Playback failed. The stream couldn't be loaded.");
      });
      h.loadSource(s.src);
      h.attachMedia(v);
      hlsRef.current = h;
    }
    v.addEventListener(
      "loadedmetadata",
      () => {
        // The playlist covers the whole title; make sure we begin at the right point.
        if (startSec > 0 && Math.abs(v.currentTime - startSec) > 5) v.currentTime = startSec;
        void v.play().catch(() => setPaused(true)); // autoplay may need a key press
      },
      { once: true },
    );
  }, []);

  // Start: ask the server for a stream, then attach it.
  useEffect(() => {
    let cancelled = false;
    stopped.current = false;
    sessionRef.current = null;
    setSession(null);
    setError(null);
    setUpNext(null);
    setPanel(null);
    setRow(null);
    (async () => {
      try {
        capsRef.current = detectCapabilities();
        const s = await api.play(plexKey, capsRef.current, offsetMs);
        if (cancelled) return;
        sessionRef.current = s;
        setSession(s);
        await attach(s, s.startMs / 1000);
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof ApiError && e.code === "not_in_library"
            ? "This isn't in your library yet."
            : e instanceof Error && e.message === "unsupported"
              ? "This browser can't play this stream."
              : "Couldn't start playback.",
        );
      }
    })();
    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      const v = videoRef.current;
      if (v) {
        v.removeAttribute("src");
        v.load();
      }
    };
  }, [plexKey, offsetMs, attach]);

  // Heartbeat to Plex while playing (resume point, watched status, keeps the stream alive).
  useEffect(() => {
    if (!session) return;
    // (Depends on `session` only to start once it exists; `report` is stable.)
    const t = window.setInterval(() => report(videoRef.current?.paused ? "paused" : "playing"), PROGRESS_MS);
    const onHide = () => !stopped.current && report("paused");
    window.addEventListener("pagehide", onHide);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("pagehide", onHide);
    };
  }, [session, report]);

  // Leaving the player some other way (e.g. browser back) still tells Plex we stopped.
  // `report` is stable, so this cleanup runs only when the player unmounts.
  useEffect(
    () => () => {
      if (!stopped.current && sessionRef.current) {
        stopped.current = true;
        report("stopped");
      }
    },
    [report],
  );

  /** Switch audio/subtitles: Plex restarts the stream at the current position. */
  const choose = useCallback(
    async (c: Choice) => {
      const s = sessionRef.current;
      const v = videoRef.current;
      if (!s || !v || c.selected) return setPanel(null);
      setPanel(null);
      setSwitching(c.kind === "audio" ? "Switching audio…" : c.id ? "Turning on subtitles…" : "Turning off subtitles…");
      const at = Math.round(v.currentTime * 1000);
      try {
        const n = await api.tracks(s.id, c.kind === "audio" ? { audioStreamId: c.id } : { subtitleStreamId: c.id }, at);
        sessionRef.current = n;
        setSession(n);
        await attach(n, at / 1000);
      } catch {
        setError("Couldn't switch tracks.");
      } finally {
        setSwitching(null);
      }
    },
    [attach],
  );

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
    showControls();
  }, [showControls]);

  const seek = useCallback(
    (delta: number) => {
      const v = videoRef.current;
      if (!v || !session) return;
      const max = session.durationMs / 1000 || v.duration || 0;
      v.currentTime = Math.max(0, Math.min(max - 1, v.currentTime + delta));
      setTime(v.currentTime);
      showControls();
    },
    [session, showControls],
  );

  /** A ←/→ (or on-screen) skip: seeks, and shows the running total while presses keep coming. */
  const skip = useCallback(
    (dir: -1 | 1, seconds = SEEK_S) => {
      seek(dir * seconds);
      setSkipped((k) => ({ dir, total: (k?.dir === dir ? k.total : 0) + seconds, n: (k?.n ?? 0) + 1 }));
      window.clearTimeout(skipTimer.current);
      skipTimer.current = window.setTimeout(() => setSkipped(null), 900);
    },
    [seek],
  );

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.().catch(() => undefined);
  }, []);
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Paused and left alone: swap the controls for a "what's playing" screen.
  useEffect(() => {
    if (!paused || !session || error || buffering) return;
    const t = window.setInterval(() => {
      if (Date.now() - lastActivity.current >= PAUSED_IDLE_MS) setPausedIdle(true);
    }, 1000);
    return () => {
      window.clearInterval(t);
      setPausedIdle(false);
    };
  }, [paused, session, error, buffering]);

  // The button row hands the keys back to the video when left alone.
  useEffect(() => {
    if (!row) return;
    const t = window.setTimeout(() => setRow(null), ROW_IDLE_MS);
    return () => window.clearTimeout(t);
  }, [row]);

  const playNext = useCallback(() => {
    const next = sessionRef.current?.next;
    if (!next) return;
    stopped.current = true;
    report("stopped");
    navigate({ name: "watch", plexKey: next.plexKey }, { replace: true });
  }, [report]);

  // Up-next countdown at the end of an episode.
  useEffect(() => {
    if (upNext === null) return;
    if (upNext <= 0) return playNext();
    const t = window.setTimeout(() => setUpNext((n) => (n === null ? null : n - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [upNext, playNext]);

  /** The bottom row's buttons, left to right. */
  const rowButtons: RowButton[] = [
    "restart",
    ...(session?.next ? (["next"] as const) : []),
    "tracks",
    ...(document.fullscreenEnabled ? (["fullscreen"] as const) : []),
  ];

  const columns = session ? choicesOf(session) : ([[], []] as [Choice[], Choice[]]);
  // Always offered, so it's discoverable; the panel says when there's nothing to switch to.
  const hasTracks = Boolean(session);

  const openPanel = useCallback(() => {
    if (!sessionRef.current) return;
    const [audio, subs] = choicesOf(sessionRef.current);
    // Start where there's a real choice: subtitles if there are any, else audio.
    const col: 0 | 1 = subs.length > 1 || audio.length <= 1 ? 1 : 0;
    const list = col === 0 ? audio : subs;
    setPanel({ col, row: Math.max(0, list.findIndex((c) => c.selected)) });
    setRow(null);
    setControls(true);
  }, []);

  const press = useCallback(
    (b: RowButton) => {
      showControls();
      if (b === "restart") seek(-(videoRef.current?.currentTime ?? 0));
      else if (b === "next") playNext();
      else if (b === "tracks") openPanel();
      else toggleFullscreen();
    },
    [showControls, seek, playNext, openPanel, toggleFullscreen],
  );

  // Long track lists scroll: keep the highlighted row visible as the remote moves it.
  useEffect(() => {
    if (panel) document.querySelector(".tracks-item.is-focused")?.scrollIntoView({ block: "nearest" });
  }, [panel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isBack = BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode);
      if (panel) {
        e.preventDefault();
        const list = columns[panel.col];
        if (isBack) setPanel(null);
        else if (e.key === "ArrowUp") setPanel({ ...panel, row: Math.max(0, panel.row - 1) });
        else if (e.key === "ArrowDown") setPanel({ ...panel, row: Math.min(list.length - 1, panel.row + 1) });
        else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          const col: 0 | 1 = panel.col === 0 ? 1 : 0;
          if (columns[col].length) setPanel({ col, row: Math.max(0, columns[col].findIndex((c) => c.selected)) });
        } else if (e.key === "Enter" || e.key === " ") {
          const c = list[panel.row];
          if (c) void choose(c);
        }
        return;
      }
      if (row && upNext === null) {
        // On the button row: ←/→ pick a button, Enter presses it, Up or Back returns to the video.
        e.preventDefault();
        const at = rowButtons.indexOf(row);
        if (isBack || e.key === "ArrowUp") setRow(null);
        else if (e.key === "ArrowLeft") setRow(rowButtons[Math.max(0, at - 1)] ?? row);
        else if (e.key === "ArrowRight") setRow(rowButtons[Math.min(rowButtons.length - 1, at + 1)] ?? row);
        else if (e.key === "Enter" || e.key === " ") press(row);
        showControls();
        return;
      }
      if (isBack) {
        e.preventDefault();
        exit(); // also during "Up next": the episode is over, so leave
        return;
      }
      if (upNext !== null) {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          setUpNextChoice((c) => (c === 0 ? 1 : 0));
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (upNextChoice === 0) playNext();
          else exit();
        }
        return;
      }
      switch (e.key) {
        case "Enter":
        case " ":
        case "MediaPlayPause":
          e.preventDefault();
          toggle();
          break;
        case "MediaPlay":
          void videoRef.current?.play();
          break;
        case "MediaPause":
          videoRef.current?.pause();
          break;
        case "ArrowRight":
          e.preventDefault();
          skip(1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          skip(-1);
          break;
        case "MediaFastForward":
          skip(1, 30);
          break;
        case "MediaRewind":
          skip(-1, 30);
          break;
        case "MediaTrackNext":
          playNext();
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "ArrowDown":
          e.preventDefault();
          if (hasTracks) setRow("tracks");
          showControls();
          break;
        case "ArrowUp":
          e.preventDefault();
          showControls();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggle, skip, exit, showControls, upNext, upNextChoice, playNext, panel, columns, choose, hasTracks, row, press, toggleFullscreen, rowButtons.join()]);

  const duration = session ? session.durationMs / 1000 : 0;
  // While dragging the scrub bar, it shows where you'd land rather than where playback is.
  const shown = scrub?.dragging ? scrub.t : time;
  const pct = duration ? Math.min(100, (shown / duration) * 100) : 0;
  const scrubAt = (e: { clientX: number; currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    return { x, t: r.width ? (x / r.width) * duration : 0 };
  };
  const rowLabel: Record<RowButton, string> = {
    restart: "Start over",
    next: "Next episode",
    tracks: "Audio & Subtitles",
    fullscreen: fullscreen ? "Exit full screen" : "Full screen",
  };
  // "Up next" has the screen to itself.
  const visible = (controls || paused || Boolean(panel) || Boolean(row)) && !pausedIdle && upNext === null;
  const converting = session && (session.decision.video === "transcode" || session.decision.audio === "transcode");

  return (
    <main
      ref={rootRef}
      className={`player${visible ? " show-controls" : ""}${pausedIdle ? " is-paused-idle" : ""}`}
      onMouseMove={showControls}
    >
      <video
        ref={videoRef}
        className="player-video"
        playsInline
        onClick={toggle}
        onPlay={() => {
          setPaused(false);
          report("playing");
          showControls();
        }}
        onPause={() => {
          setPaused(true);
          setControls(true);
          if (!stopped.current && !switching) report("paused");
        }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onEnded={() => {
          if (session?.next) {
            setUpNextChoice(0);
            setUpNext(UP_NEXT_S);
          } else exit();
        }}
        onError={() => !switching && setError("Playback failed. The stream couldn't be decoded.")}
      />

      {(buffering || switching) && !error && <div className="player-spinner" aria-label="Loading" />}
      {switching && <div className="player-toast">{switching}</div>}

      <div className="player-top">
        <button className="btn btn-quiet" onClick={exit} aria-label="Back">
          ←
        </button>
        <div>
          <div className="player-title">{session?.title ?? "Loading…"}</div>
          {session?.subtitle && <div className="player-subtitle">{session.subtitle}</div>}
        </div>
      </div>

      {session && !error && upNext === null && (
        <div className="player-center">
          <button className={`player-skip${skipped?.dir === -1 ? " is-hit" : ""}`} onClick={() => skip(-1)} aria-label="Back 10 seconds">
            <SkipIcon dir={-1} />
            {skipped?.dir === -1 && <span key={skipped.n} className="player-skip-total">−{skipped.total} s</span>}
          </button>
          <button className="player-big" onClick={toggle} aria-label={paused ? "Play" : "Pause"}>
            {!(buffering || switching) && (paused ? <PlayIcon /> : <PauseIcon />)}
          </button>
          <button className={`player-skip${skipped?.dir === 1 ? " is-hit" : ""}`} onClick={() => skip(1)} aria-label="Forward 10 seconds">
            <SkipIcon dir={1} />
            {skipped?.dir === 1 && <span key={skipped.n} className="player-skip-total">+{skipped.total} s</span>}
          </button>
        </div>
      )}

      {pausedIdle && session && (
        <div className="player-idle" aria-hidden>
          <div className="muted">You're watching</div>
          <div className="player-idle-title">{session.title}</div>
          {session.subtitle && <div className="player-idle-sub">{session.subtitle}</div>}
          {session.summary && <p className="player-idle-summary">{session.summary}</p>}
          <div className="muted small">Paused</div>
        </div>
      )}

      <div className="player-bottom">
        <div className="player-scrub">
          <span className="player-time">{clock(shown)}</span>
          <div
            className={`player-bar${scrub ? " is-hover" : ""}`}
            role="slider"
            aria-label="Position"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(time)}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              setScrub({ ...scrubAt(e), dragging: true });
            }}
            onPointerMove={(e) => setScrub((s) => ({ ...scrubAt(e), dragging: s?.dragging ?? false }))}
            onPointerUp={(e) => {
              if (scrub?.dragging) seek(scrubAt(e).t - time);
              setScrub(e.pointerType === "mouse" ? { ...scrubAt(e), dragging: false } : null);
            }}
            onPointerCancel={() => setScrub(null)}
            onPointerLeave={() => setScrub((s) => (s?.dragging ? s : null))}
          >
            <div className="player-bar-track">
              <div className="player-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="player-bar-knob" style={{ left: `${pct}%` }} />
            {scrub && duration > 0 && (
              <div className="player-bar-tip" style={{ left: `${scrub.x}px` }}>
                {clock(scrub.t)}
              </div>
            )}
          </div>
          <span className="player-time">−{clock(Math.max(0, duration - shown))}</span>
        </div>
        <div className="player-row">
          <span className="player-hint muted small">
            {row ? "← → choose · Enter select · ↑ back to video" : `← → 10 s · Enter ${paused ? "play" : "pause"} · ↓ more · Back exit`}
          </span>
          <div className="player-buttons">
            {session &&
              rowButtons.map((b) => (
                <button
                  key={b}
                  className={`btn btn-quiet${row === b ? " is-focused" : ""}${b === "tracks" && panel ? " is-open" : ""}`}
                  onClick={() => (b === "tracks" && panel ? setPanel(null) : press(b))}
                >
                  {rowLabel[b]}
                </button>
              ))}
          </div>
          {session && (
            <span
              className={`pill ${converting ? "pill-requested" : "pill-owned"}`}
              title={`video ${session.decision.video}, audio ${session.decision.audio}`}
            >
              {converting ? "Converting" : "Direct stream"}
            </span>
          )}
        </div>
      </div>

      {panel && session && (
        <div className="tracks-panel" role="dialog" aria-label="Audio and subtitles">
          {(["Audio", "Subtitles"] as const).map((heading, col) => (
            <div key={heading} className="tracks-col">
              <h3>{heading}</h3>
              {columns[col]!.length === 0 && <p className="muted small">None</p>}
              {col === 1 && columns[1].length === 1 && <p className="muted small tracks-empty">No subtitles available for this title.</p>}
              {col === 0 && columns[0].length === 1 && <p className="muted small tracks-empty">This is the only audio track.</p>}
              {columns[col]!.map((c, row) => (
                <button
                  key={`${c.kind}:${c.id}`}
                  className={`tracks-item ${panel.col === col && panel.row === row ? "is-focused" : ""} ${c.selected ? "is-selected" : ""}`}
                  onMouseEnter={() => setPanel({ col: col as 0 | 1, row })}
                  onClick={() => void choose(c)}
                >
                  <span className="tracks-check" aria-hidden>
                    {c.selected ? "✓" : ""}
                  </span>
                  {c.label}
                  {c.note && <span className="muted small"> · {c.note}</span>}
                </button>
              ))}
            </div>
          ))}
          <p className="tracks-note muted small">
            Subtitles are drawn into the picture by your Plex server, so turning them on converts the video.
          </p>
        </div>
      )}

      {upNext !== null && session?.next && (
        <div className="up-next" role="dialog" aria-label="Up next">
          <div className="up-next-art">
            {session.next.thumb && <img src={session.next.thumb} alt="" />}
            <div className="up-next-count" aria-hidden>
              <div style={{ width: `${((UP_NEXT_S - upNext) / UP_NEXT_S) * 100}%` }} />
            </div>
          </div>
          <div className="up-next-body">
            <div className="muted small">Next episode in {upNext}</div>
            <div className="up-next-title">{session.next.subtitle ?? session.next.title}</div>
            <div className="actions">
              <button className={`btn btn-primary ${upNextChoice === 0 ? "is-focused" : ""}`} onClick={playNext}>
                ▶ Play now
              </button>
              <button className={`btn ${upNextChoice === 1 ? "is-focused" : ""}`} onClick={exit}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="overlay">
          <p>{error}</p>
          <div className="actions">
            <button className="btn btn-primary is-focused" onClick={exit}>
              Back
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
