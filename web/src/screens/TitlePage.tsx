import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import type { EpisodeInfo, MediaType, SeasonEpisodes, SeasonInfo, TitleDetail } from "../api/types";
import { downloadLabel, runtime, shortDate, statusLabel } from "../components/format";
import { FocusGroup, Focusable, setFocus, useBackKey } from "../nav/focus";
import { goBack, navigate } from "../router";

const POLL_MS = 10_000;

const SEASON_LABEL: Record<SeasonInfo["status"], string> = {
  owned: "In your library",
  partial: "Partly in your library",
  downloading: "Downloading",
  requested: "Requested",
  upcoming: "Not aired yet",
  available: "",
};

/** Seasons that make sense to ask for. */
const requestable = (s: SeasonInfo) => s.status === "available" || s.status === "partial" || s.status === "upcoming";

function Trailer({ youtubeKey, onClose }: { youtubeKey: string; onClose: () => void }) {
  useBackKey(onClose);
  return (
    <div className="overlay" role="dialog" aria-label="Trailer">
      <iframe
        className="trailer"
        src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeKey)}?autoplay=1&rel=0`}
        title="Trailer"
        allow="autoplay; encrypted-media; fullscreen"
        // YouTube refuses embeds that don't say which site they're on (Error 153).
        // The rest of the app sends no referrer; this frame sends only the origin.
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
      />
      <FocusGroup className="overlay-actions" trap autoFocus>
        <Focusable className="btn" onSelect={onClose} label="Close trailer">
          {() => "Close"}
        </Focusable>
      </FocusGroup>
    </div>
  );
}

const minutesLeft = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
};

const numberingOf = (d: TitleDetail): "sonarr" | "tmdb" => (d.seasonNumbering === "tmdb" ? "tmdb" : "sonarr");

const EPISODE_LABEL: Record<EpisodeInfo["status"], string> = {
  owned: "", // ▶ already says it
  downloading: "Downloading",
  requested: "Requested",
  upcoming: "Not aired yet",
  available: "",
};

/** Episodes you can still ask for (upcoming ones download when they air). */
const episodeRequestable = (e: EpisodeInfo) => e.status === "available" || e.status === "upcoming";

function EpisodeList({
  detail,
  season,
  busy,
  refreshKey,
  onRequest,
}: {
  detail: TitleDetail;
  season: SeasonInfo;
  busy: boolean;
  refreshKey: number;
  onRequest: (season: number, episodes: number[]) => void;
}) {
  const [data, setData] = useState<SeasonEpisodes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());

  useEffect(() => {
    let live = true;
    api.episodes(detail.tmdbId, season.number, numberingOf(detail)).then(
      (d) => live && (setData(d), setError(null)),
      () => live && setError("Couldn't load episodes."),
    );
    return () => {
      live = false;
    };
  }, [detail, season.number, refreshKey]);

  if (error) return <p className="muted small episode-note">{error}</p>;
  if (!data) return <p className="muted small episode-note">Loading episodes…</p>;
  const first = data.episodes.find((e) => e.status === "available") ?? data.episodes.find(episodeRequestable);
  const toggle = (n: number) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  return (
    <div className="episodes">
      <FocusGroup className="episode-list" focusKey={`episodes:${season.number}`}>
        {data.episodes.map((e) => {
          const can = episodeRequestable(e);
          const on = chosen.has(e.number);
          return (
            <Focusable
              key={e.number}
              className={`season episode ${on ? "is-on" : ""} season-${e.status} ${e.watched ? "is-watched" : ""}`}
              label={`Episode ${e.number}, ${e.title}${e.plexKey ? ", play" : on ? ", selected" : ""}`}
              onSelect={() =>
                e.plexKey ? navigate({ name: "watch", plexKey: e.plexKey }) : can && toggle(e.number)
              }
            >
              {() => (
                <>
                  <span className="season-check" aria-hidden>
                    {e.watched ? "✓" : e.plexKey ? "▶" : can ? (on ? "☑" : "☐") : e.status === "owned" ? "✓" : "·"}
                  </span>
                  <span className="season-name">
                    {e.number}. {e.title}
                  </span>
                  <span className="season-meta muted small">
                    {[
                      e.airDate ? shortDate(e.airDate) : null,
                      e.progress ? `${minutesLeft(e.progress.remainingMs)} left` : e.watched ? "Watched" : EPISODE_LABEL[e.status] || null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {e.progress && (
                    <span className="episode-progress" aria-label={`${e.progress.percent}% watched`}>
                      <span style={{ width: `${Math.max(3, e.progress.percent)}%` }} />
                    </span>
                  )}
                </>
              )}
            </Focusable>
          );
        })}
      </FocusGroup>
      {data.episodes.some(episodeRequestable) && (
      <FocusGroup className="actions">
        {first && (
          <Focusable
            className="btn"
            disabled={busy}
            onSelect={() => onRequest(season.number, [first.number])}
            label={`Get episode ${first.number}`}
          >
            {() => `Get episode ${first.number}`}
          </Focusable>
        )}
        <Focusable
          className="btn btn-primary"
          disabled={chosen.size === 0 || busy}
          onSelect={() => onRequest(season.number, [...chosen].sort((a, b) => a - b))}
          label="Get selected episodes"
        >
          {() => (busy ? "Requesting…" : chosen.size ? `Get ${chosen.size === 1 ? "1 episode" : `${chosen.size} episodes`}` : "Pick episodes")}
        </Focusable>
      </FocusGroup>
      )}
    </div>
  );
}

function SeasonPicker({
  detail,
  onRequest,
  busy,
}: {
  detail: TitleDetail;
  onRequest: (seasons: number[], episodes?: number[]) => void;
  busy: boolean;
}) {
  const seasons = detail.seasons ?? [];
  const [open, setOpen] = useState<number | null>(null);
  // Re-fetch the open episode list whenever the title refreshes (progress polling, after a request).
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => setRefreshKey((k) => k + 1), [detail]);
  // Preselect the first season you don't have yet (usually season 1).
  const initial = useMemo(() => {
    const first = seasons.find(requestable);
    return new Set(first ? [first.number] : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id]);
  const [chosen, setChosen] = useState<Set<number>>(initial);
  useEffect(() => setChosen(initial), [initial]);

  const toggle = (n: number) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  if (seasons.length === 0) return null;
  const count = chosen.size;
  return (
    <section className="seasons" aria-label="Seasons">
      <h2>Seasons</h2>
      <FocusGroup className="season-list" focusKey="seasons">
        {seasons.map((s) => {
          const can = requestable(s);
          const on = chosen.has(s.number);
          const expanded = open === s.number;
          return (
            <div key={s.number} className="season-block">
            <FocusGroup className="season-row" focusKey={`season:${s.number}`}>
            <Focusable
              className={`season ${on ? "is-on" : ""} season-${s.status} ${s.inPlex > 0 && s.watched >= s.inPlex ? "is-watched" : ""}`}
              disabled={!can && s.status !== "owned" && s.status !== "partial"}
              label={`${s.name}${on ? ", selected" : ""}`}
              onSelect={() => can && toggle(s.number)}
            >
              {() => (
                <>
                  <span className="season-check" aria-hidden>
                    {can
                      ? on
                        ? "☑"
                        : "☐"
                      : s.status === "owned"
                        ? s.inPlex > 0 && s.watched >= s.inPlex
                          ? "✓"
                          : "▶"
                        : "·"}
                  </span>
                  <span className="season-name">
                    {s.name}
                    {s.tmdbNumber !== null && <span className="muted small"> (TMDb season {s.tmdbNumber})</span>}
                  </span>
                  <span className="season-meta muted small">
                    {[
                      s.episodeCount ? `${s.inPlex ? `${s.inPlex}/` : ""}${s.episodeCount} episodes` : null,
                      s.inPlex ? (s.watched >= s.inPlex ? "All watched" : `${s.watched}/${s.inPlex} watched`) : null,
                      s.airDate ? shortDate(s.airDate) : null,
                      // The watched count already implies it's in the library.
                      s.status === "owned" ? null : SEASON_LABEL[s.status] || null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </>
              )}
            </Focusable>
            <Focusable
              className={`btn btn-quiet season-expand ${expanded ? "is-open" : ""}`}
              label={`${expanded ? "Hide" : "Show"} episodes of ${s.name}`}
              onSelect={() => setOpen(expanded ? null : s.number)}
            >
              {() => (expanded ? "Episodes ▾" : "Episodes ›")}
            </Focusable>
            </FocusGroup>
            {expanded && (
              <EpisodeList
                detail={detail}
                season={s}
                busy={busy}
                refreshKey={refreshKey}
                onRequest={(season, episodes) => onRequest([season], episodes)}
              />
            )}
            </div>
          );
        })}
      </FocusGroup>
      <FocusGroup className="actions">
        <Focusable
          className="btn btn-primary"
          disabled={count === 0 || busy}
          onSelect={() => onRequest([...chosen].sort((a, b) => a - b))}
          label="Get selected seasons"
        >
          {() => (busy ? "Requesting…" : count ? `Get ${count === 1 ? "1 season" : `${count} seasons`}` : "Pick a season")}
        </Focusable>
      </FocusGroup>
    </section>
  );
}

export function TitlePage({ mediaType, tmdbId }: { mediaType: MediaType; tmdbId: number }) {
  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [trailer, setTrailer] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api.title(mediaType, tmdbId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? "We couldn't find that title." : "Couldn't load this title.");
    }
  }, [mediaType, tmdbId]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  // Keep progress moving while something is on its way.
  useEffect(() => {
    const busySeasons = detail?.seasons?.some((s) => s.status === "downloading" || s.status === "requested");
    if (!detail || (detail.status !== "downloading" && detail.status !== "requested" && !busySeasons)) return;
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(t);
  }, [detail, load]);

  useEffect(() => {
    if (detail) requestAnimationFrame(() => setFocus("title-actions"));
  }, [detail?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useBackKey(goBack, !trailer);

  const request = async (seasons?: number[], episodes?: number[]) => {
    if (!detail) return;
    setBusy(true);
    setMessage(null);
    try {
      const r =
        detail.mediaType === "movie"
          ? await api.requestMovie(detail.tmdbId)
          : episodes && seasons?.[0] !== undefined
            ? await api.requestEpisodes(detail.tmdbId, seasons[0], episodes, numberingOf(detail))
            : await api.requestSeasons(detail.tmdbId, seasons ?? [], numberingOf(detail));
      if (r.title) setDetail(r.title);
      setMessage(
        r.result === "already_have"
          ? "You already have this."
          : episodes
            ? `Requested ${episodes.length === 1 ? `episode ${episodes[0]}` : `${episodes.length} episodes`}. Searching now. Each one shows up as soon as it's downloaded.`
            : detail.status === "upcoming"
              ? "Requested. It'll download when it's released."
              : "Requested. Searching now…",
      );
    } catch (e) {
      if (e instanceof ApiError && e.code === "season_numbering_mismatch") {
        await load(); // the server now knows Sonarr's numbering
        setMessage("Season numbers were updated. Please check your choice and try again.");
      } else if (e instanceof ApiError && e.code === "restricted_profile") {
        setMessage("This profile can't request titles.");
      } else {
        setMessage(e instanceof ApiError && e.detail ? `Couldn't request: ${e.detail}` : "Couldn't request it. Try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <main className="center-screen">
        <p>{error}</p>
        <FocusGroup autoFocus>
          <Focusable className="btn" onSelect={goBack} label="Back">
            {() => "Back"}
          </Focusable>
        </FocusGroup>
      </main>
    );
  }
  if (!detail) return <main className="center-screen muted">Loading…</main>;

  const meta = [
    detail.year,
    runtime(detail.runtime),
    detail.genres.slice(0, 3).join(", "),
    detail.rating ? `★ ${detail.rating.toFixed(1)}` : null,
  ].filter(Boolean);

  const isTv = detail.mediaType === "tv";
  const primary = (() => {
    switch (detail.status) {
      case "owned":
        return {
          label: "▶ Play",
          action: () => detail.plexKey && navigate({ name: "watch", plexKey: detail.plexKey }),
          disabled: !detail.plexKey,
        };
      case "available":
        return isTv ? null : { label: busy ? "Requesting…" : "Get it", action: () => void request(), disabled: busy };
      case "upcoming":
        return isTv
          ? null
          : {
              label: busy ? "Requesting…" : detail.availableFrom ? `Get it on ${shortDate(detail.availableFrom)}` : "Get it when it's out",
              action: () => void request(),
              disabled: busy,
            };
      case "requested":
        return isTv ? null : { label: busy ? "Searching…" : "Search again", action: () => void request(), disabled: busy };
      case "downloading":
        return null;
    }
  })();

  return (
    <main className="title-page">
      {detail.backdrop && <img className="title-backdrop" src={detail.backdrop.replace("/w780/", "/w1280/")} alt="" />}
      <div className="title-shade" />
      <div className="title-body">
        <h1 className="title-name">{detail.title}</h1>
        {detail.tagline && <p className="title-tagline">{detail.tagline}</p>}
        <div className="hero-meta">
          {meta.map((m) => (
            <span key={String(m)}>{m}</span>
          ))}
          <span className={`pill pill-${detail.status}`}>{statusLabel(detail)}</span>
        </div>
        {detail.status === "downloading" && detail.download && (
          <div className="title-progress" aria-label={`Download ${downloadLabel(detail.download)}`}>
            <div style={{ width: `${Math.max(2, detail.download.percent)}%` }} />
          </div>
        )}
        <p className="title-overview">{detail.overview}</p>

        <FocusGroup className="actions" focusKey="title-actions">
          {primary && (
            <Focusable className="btn btn-primary" onSelect={primary.action} disabled={primary.disabled} label={primary.label}>
              {() => primary.label}
            </Focusable>
          )}
          {detail.trailerYoutubeKey && (
            <Focusable className="btn" onSelect={() => setTrailer(true)} label="Watch trailer">
              {() => "Trailer"}
            </Focusable>
          )}
          <Focusable className="btn btn-quiet" onSelect={goBack} label="Back">
            {() => "Back"}
          </Focusable>
        </FocusGroup>
        {message && (
          <p className="title-message" role="status">
            {message}
          </p>
        )}
        {isTv && <SeasonPicker detail={detail} busy={busy} onRequest={(s, e) => void request(s, e)} />}
      </div>
      {trailer && detail.trailerYoutubeKey && (
        <Trailer
          youtubeKey={detail.trailerYoutubeKey}
          onClose={() => {
            setTrailer(false);
            requestAnimationFrame(() => setFocus("title-actions"));
          }}
        />
      )}
    </main>
  );
}
