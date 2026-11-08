import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Home as HomeData, Profile, RowItem } from "../api/types";
import { Hero } from "../components/Hero";
import { Row } from "../components/Row";
import { FocusGroup, Focusable, setFocus } from "../nav/focus";
import { navigate } from "../router";
import { Avatar } from "./ProfilePicker";

const REFRESH_MS = 60_000;
/** Faster while something is downloading, so progress bars move. */
const REFRESH_ACTIVE_MS = 15_000;

// Survives the trip to a title page and back.
let lastFocusKey: string | null = null;
let cached: HomeData | null = null;

interface HomeProps {
  profile: Profile;
  onSwitchProfile: () => void;
  onSignOut: () => void;
}

export function Home({ profile, onSwitchProfile, onSignOut }: HomeProps) {
  const [data, setData] = useState<HomeData | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const [featured, setFeatured] = useState<RowItem | null>(cached?.rows[0]?.items[0] ?? null);
  const restored = useRef(false);

  const load = useCallback(async () => {
    try {
      const d = await api.home();
      cached = d;
      setData(d);
      setError(null);
    } catch {
      setError("Couldn't load your home screen.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = Boolean(data?.rows.some((r) => r.items.some((i) => i.status === "downloading")));
  useEffect(() => {
    const t = window.setInterval(() => void load(), active ? REFRESH_ACTIVE_MS : REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load, active]);

  // First render with data: restore the previous focus, else the first card.
  useEffect(() => {
    if (!data || restored.current) return;
    restored.current = true;
    const first = data.rows[0];
    const fallback = first?.items[0] ? `card:${first.id}:${first.items[0].id}` : null;
    requestAnimationFrame(() => {
      try {
        setFocus(lastFocusKey ?? fallback ?? "header");
      } catch {
        if (fallback) setFocus(fallback);
      }
    });
  }, [data]);

  const onFocused = useCallback((item: RowItem, key: string) => {
    lastFocusKey = key;
    setFeatured(item);
  }, []);

  return (
    <div className="home">
      <FocusGroup className="header" focusKey="header">
        <div className="brand">Sofarr</div>
        <div className="header-actions">
          <Focusable className="btn btn-quiet" onSelect={() => navigate({ name: "search", q: "" })} label="Search">
            {() => "⌕ Search"}
          </Focusable>
          <Focusable className="btn btn-quiet header-profile" onSelect={onSwitchProfile} label="Switch profile">
            {() => (
              <>
                <Avatar p={profile} size="sm" />
                <span>{profile.title}</span>
              </>
            )}
          </Focusable>
          <Focusable className="btn btn-quiet" onSelect={onSignOut} label="Sign out">
            {() => "Sign out"}
          </Focusable>
        </div>
      </FocusGroup>

      <Hero item={featured} />

      <div className="rows">
        {error && !data && (
          <div className="notice">
            <p>{error}</p>
            <FocusGroup autoFocus>
              <Focusable className="btn btn-primary" onSelect={() => void load()} label="Try again">
                {() => "Try again"}
              </Focusable>
            </FocusGroup>
          </div>
        )}
        {!data && !error && <p className="muted rows-loading">Loading…</p>}
        {data?.rows.map((row) => <Row key={row.id} row={row} onFocused={onFocused} />)}
        {data && data.warnings.length > 0 && (
          <p className="muted small warnings">Some rows are missing: {data.warnings.join("; ")}</p>
        )}
      </div>
    </div>
  );
}

/** Forget cached rows (e.g. after switching profile). */
export function resetHome(): void {
  cached = null;
  lastFocusKey = null;
}
