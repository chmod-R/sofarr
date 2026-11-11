import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import type { EpisodeInfo, MediaType, SeasonEpisodes, SeasonInfo, Title, TitleDetail } from "../api/types";
import { Card } from "../components/Card";
import { largeBackdrop } from "../components/art";
import { FadeImg } from "../components/FadeImg";
import { downloadLabel, runtime, shortDate, statusLabel } from "../components/format";
import { EpisodesSkeleton, GridSkeleton, TitleSkeleton } from "../components/Skeleton";
import { FocusGroup, Focusable, setFocus, useBackKey } from "../nav/focus";
import { goBack, navigate } from "../router";

const POLL_MS = 10_000;

/** Seasons that make sense to ask for. */
const requestable = (s: SeasonInfo) => s.status === "available" || s.status === "partial" || s.status === "upcoming";

/** One line about a season: what you have, what you've watched, what's on its way. */
function seasonSummary(s: SeasonInfo): string {
  const status: Record<SeasonInfo["status"], string | null> = {
    owned: null, // the counts already say so
    partial: null,
    downloading: "Downloading",
    requested: "Requested",
    upcoming: "Not aired yet",
    available: null,
  };
  return [
    s.episodeCount ? `${s.inPlex ? `${s.inPlex} of ` : ""}${s.episodeCount} episodes${s.inPlex ? " in your library" : ""}` : null,
    s.inPlex ? (s.watched >= s.inPlex ? "All watched" : s.watched ? `${s.watched} watched` : null) : null,
    !s.inPlex && s.airDate ? shortDate(s.airDate) : null,
    status[s.status],
  ]
    .filter(Boolean)
    .join(" · ");
}

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

/** Episodes you can still ask for (upcoming ones download when they air). */
const episodeRequestable = (e: EpisodeInfo) => e.status === "available" || e.status === "upcoming";

/** What Enter does on an episode row, as shown at its right edge. */
function episodeAction(e: EpisodeInfo, requesting: boolean): { label: string; kind: "play" | "get" | "wait" | "none" } {
  if (e.plexKey) return { label: e.progress ? "▶ Resume" : "▶ Play", kind: "play" };
  if (requesting) return { label: "Requesting…", kind: "wait" };
  switch (e.status) {
    case "available":
      return { label: "Get it", kind: "get" };
    case "upcoming":
      return { label: "Get when aired", kind: "get" };
    case "downloading":
      return { label: "Downloading", kind: "wait" };
    case "requested":
      return { label: "Requested", kind: "wait" };
    default:
      return { label: "", kind: "none" };
  }
}

function EpisodeRow({ e, busy, requesting, onRequest }: { e: EpisodeInfo; busy: boolean; requesting: boolean; onRequest: () => void }) {
  const action = episodeAction(e, requesting);
  const facts = [
    e.progress ? `${minutesLeft(e.progress.remainingMs)} left` : runtime(e.runtime),
    e.airDate ? shortDate(e.airDate) : null,
    e.watched && !e.progress ? "Watched" : null,
  ].filter(Boolean);
  return (
    <Focusable
      className={`episode kind-${action.kind}${e.watched ? " is-watched" : ""}`}
      label={`Episode ${e.number}, ${e.title}${action.label ? `, ${action.label.replace("▶ ", "")}` : ""}`}
      disabled={action.kind === "get" && busy}
      onSelect={() => {
        if (e.plexKey) navigate({ name: "watch", plexKey: e.plexKey });
        else if (action.kind === "get") onRequest();
      }}
    >
      {() => (
        <>
          <div className="episode-thumb">
            {e.still ? <FadeImg className="episode-still" src={e.still} lazy /> : <div className="episode-still episode-still-missing" />}
            {e.plexKey && (
              <span className="episode-play" aria-hidden>
                ▶
              </span>
            )}
            {e.watched && !e.progress && (
              <span className="episode-seen" aria-hidden>
                ✓
              </span>
            )}
            {e.progress && (
              <span className="episode-progress" aria-label={`${e.progress.percent}% watched`}>
                <span style={{ width: `${Math.max(3, e.progress.percent)}%` }} />
              </span>
            )}
          </div>
          <div className="episode-text">
            <div className="episode-head">
              <span className="episode-title">
                {e.number}. {e.title}
              </span>
              <span className="episode-facts muted small">{facts.join(" · ")}</span>
            </div>
            {e.overview && <p className="episode-overview">{e.overview}</p>}
          </div>
          {action.label && <span className={`episode-action episode-action-${action.kind}`}>{action.label}</span>}
        </>
      )}
    </Focusable>
  );
}

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
  /** The episode just asked for, until the request has gone through. */
  const [asked, setAsked] = useState<number | null>(null);

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
  useEffect(() => {
    if (!busy) setAsked(null);
  }, [busy]);

  if (error && !data) return <p className="muted episode-note">{error}</p>;
  if (!data) return <EpisodesSkeleton count={Math.min(season.episodeCount || 4, 6)} />;
  if (data.episodes.length === 0) return <p className="muted episode-note">No episodes listed yet.</p>;

  return (
    <FocusGroup className="episode-list" focusKey={`episodes:${season.number}`}>
      {data.episodes.map((e) => (
        <EpisodeRow
          key={e.number}
          e={e}
          busy={busy}
          requesting={busy && asked === e.number}
          onRequest={() => {
            setAsked(e.number);
            onRequest(season.number, [e.number]);
          }}
        />
      ))}
    </FocusGroup>
  );
}

/** The season to open first: the one you're in the middle of, else the first you have, else the first to get. */
function startSeason(seasons: SeasonInfo[]): number | null {
  const pick =
    seasons.find((s) => s.inPlex > 0 && s.watched < s.inPlex) ??
    seasons.find((s) => s.inPlex > 0) ??
    seasons.find(requestable) ??
    seasons[0];
  return pick?.number ?? null;
}

function Seasons({
  detail,
  onRequest,
  busy,
}: {
  detail: TitleDetail;
  onRequest: (seasons: number[], episodes?: number[]) => void;
  busy: boolean;
}) {
  const seasons = detail.seasons ?? [];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => startSeason(seasons), [detail.id]);
  const [current, setCurrent] = useState<number | null>(initial);
  useEffect(() => setCurrent(initial), [initial]);
  // Re-fetch the episode list whenever the title refreshes (progress polling, after a request).
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => setRefreshKey((k) => k + 1), [detail]);

  const season = seasons.find((s) => s.number === current) ?? seasons[0];
  if (!season) return null;
  const wanted = seasons.filter(requestable);
  const summary = seasonSummary(season);
  const hasActions = requestable(season) || wanted.length > 1;
  const bar = (
    <>
      <p className="muted season-summary">
        {seasons.length === 1 && <strong>{season.name}</strong>}
        {summary}
        {season.tmdbNumber !== null && <span className="small"> (TMDb season {season.tmdbNumber})</span>}
      </p>
      <div className="season-actions">
        {requestable(season) && (
          <Focusable className="btn" disabled={busy} onSelect={() => onRequest([season.number])} label={`Get ${season.name}`}>
            {() => (season.status === "partial" ? `Get the rest of ${season.name}` : `Get ${season.name}`)}
          </Focusable>
        )}
        {wanted.length > 1 && (
          <Focusable
            className="btn btn-quiet"
            disabled={busy}
            onSelect={() => onRequest(wanted.map((s) => s.number))}
            label={`Get all ${wanted.length} seasons you don't have`}
          >
            {() => (wanted.length === seasons.length ? `Get all ${wanted.length} seasons` : `Get all ${wanted.length} missing seasons`)}
          </Focusable>
        )}
      </div>
    </>
  );

  return (
    <section className="seasons" aria-label="Episodes">
      <h2 className="section-title">Episodes</h2>
      {seasons.length > 1 && (
        <FocusGroup className="season-tabs" focusKey="seasons" preferredChildFocusKey={`season:${season.number}`}>
          {seasons.map((s) => (
            <Focusable
              key={s.number}
              focusKey={`season:${s.number}`}
              className={`btn btn-quiet tab${s.number === season.number ? " is-current" : ""}`}
              label={s.name}
              onSelect={() => setCurrent(s.number)}
            >
              {() => s.name}
            </Focusable>
          ))}
        </FocusGroup>
      )}
      {/* The bar itself is the focus group: as wide as the tabs and the list, so Up and Down
          pass through its buttons instead of skipping past them at the far right. */}
      {hasActions ? (
        <FocusGroup className="season-bar" focusKey="season-actions">
          {bar}
        </FocusGroup>
      ) : (
        <div className="season-bar">{bar}</div>
      )}
      <EpisodeList
        key={season.number}
        detail={detail}
        season={season}
        busy={busy}
        refreshKey={refreshKey}
        onRequest={(n, episodes) => onRequest([n], episodes)}
      />
    </section>
  );
}

function MoreLikeThis({ mediaType, tmdbId }: { mediaType: MediaType; tmdbId: number }) {
  const [items, setItems] = useState<Title[] | null>(null);
  useEffect(() => {
    let live = true;
    api.similar(mediaType, tmdbId).then(
      (r) => live && setItems(r.results),
      () => live && setItems([]), // optional: the page is complete without it
    );
    return () => {
      live = false;
    };
  }, [mediaType, tmdbId]);

  if (items && items.length === 0) return null;
  return (
    <section className="similar" aria-label="More Like This">
      <h2 className="section-title">More Like This</h2>
      {items ? (
        <FocusGroup className="similar-grid" focusKey="similar">
          {items.map((t) => (
            <Card key={t.id} item={t} focusKey={`similar:${t.id}`} onFocused={() => undefined} showYear />
          ))}
        </FocusGroup>
      ) : (
        <GridSkeleton className="similar-grid" count={8} />
      )}
    </section>
  );
}

export function TitlePage({ mediaType, tmdbId }: { mediaType: MediaType; tmdbId: number }) {
  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [trailer, setTrailer] = useState(false);
  const [logoFailed, setLogoFailed] = useState<string | null>(null);

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
    window.scrollTo(0, 0);
    void load();
  }, [load]);

  // Requests are answered in a toast: the button that asked may be far down the page.
  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(null), 8000);
    return () => window.clearTimeout(t);
  }, [message]);

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
  if (!detail) return <TitleSkeleton />;

  const isTv = detail.mediaType === "tv";
  const seasonCount = detail.seasons?.length ?? 0;
  const meta = [
    detail.year,
    isTv && seasonCount ? `${seasonCount} ${seasonCount === 1 ? "Season" : "Seasons"}` : runtime(detail.runtime),
    detail.genres.slice(0, 3).join(", "),
    detail.rating ? `★ ${detail.rating.toFixed(1)}` : null,
  ].filter(Boolean);
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
      {detail.backdrop && <FadeImg className="title-backdrop" src={largeBackdrop(detail.backdrop)!} />}
      <div className="title-shade" />
      <div className="title-body">
        <h1 className="title-name" aria-label={detail.title}>
          {detail.logo && logoFailed !== detail.logo ? (
            <FadeImg className="title-logo" src={detail.logo} onError={() => setLogoFailed(detail.logo)} />
          ) : (
            detail.title
          )}
        </h1>
        {detail.tagline && <p className="title-tagline">{detail.tagline}</p>}
        <div className="hero-meta">
          {meta.slice(0, 1).map((m) => (
            <span key={String(m)}>{m}</span>
          ))}
          {detail.certification && (
            <span className="cert" aria-label={`Rated ${detail.certification}`}>
              {detail.certification}
            </span>
          )}
          {meta.slice(1).map((m) => (
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
        {detail.cast.length > 0 && (
          <p className="title-cast">
            <span className="muted">Starring </span>
            {detail.cast.join(", ")}
          </p>
        )}

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
      </div>
      <div className="title-more">
        {isTv && <Seasons detail={detail} busy={busy} onRequest={(s, e) => void request(s, e)} />}
        <MoreLikeThis mediaType={detail.mediaType} tmdbId={detail.tmdbId} />
      </div>
      {message && (
        <p className="toast" role="status">
          {message}
        </p>
      )}
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
