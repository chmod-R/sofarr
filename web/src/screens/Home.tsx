import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Home as HomeData, Profile, RowItem } from "../api/types";
import { firstLibraryKey, Library } from "../components/Library";
import { Row } from "../components/Row";
import { FocusGroup, Focusable, setFocus, useBackKey } from "../nav/focus";
import { navigate } from "../router";
import { Avatar } from "./ProfilePicker";

const REFRESH_MS = 60_000;
/** Faster while something is downloading, so progress bars move. */
const REFRESH_ACTIVE_MS = 15_000;

export type HomeTab = "home" | "library";

const TABS: Array<{ tab: HomeTab; label: string }> = [
  { tab: "home", label: "Home" },
  { tab: "library", label: "My Library" },
];

const fetchTab = (tab: HomeTab) => (tab === "home" ? api.home() : api.library());

// Per tab, survives the trip to a title page and back.
const lastFocusKey: Record<HomeTab, string | null> = { home: null, library: null };
const cached: Record<HomeTab, HomeData | null> = { home: null, library: null };
/** Set when switching tabs from the header, so focus stays on the tab just chosen. */
let focusNavOnMount: string | null = null;

interface HomeProps {
  tab: HomeTab;
  profile: Profile;
  onSwitchProfile: () => void;
  onSignOut: () => void;
}

/** The browse screens: Home (discover rows) and My Library (grids of what's in Plex). */
export function Home({ tab, profile, onSwitchProfile, onSignOut }: HomeProps) {
  const [data, setData] = useState<HomeData | null>(cached[tab]);
  const [error, setError] = useState<string | null>(null);
  // The row and card that last had focus. Stays when focus moves up to the header.
  const [selected, setSelected] = useState<{ rowId: string; itemId: string } | null>(null);
  const restored = useRef(false);

  const load = useCallback(async () => {
    try {
      const d = await fetchTab(tab);
      cached[tab] = d;
      setData(d);
      setError(null);
    } catch {
      setError(tab === "home" ? "Couldn't load your home screen." : "Couldn't load your library.");
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = Boolean(data?.rows.some((r) => r.items.some((i) => i.status === "downloading")));
  useEffect(() => {
    const t = window.setInterval(() => void load(), active ? REFRESH_ACTIVE_MS : REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load, active]);

  // Arrived from the header's tabs: keep focus there.
  useEffect(() => {
    if (!focusNavOnMount) return;
    const key = focusNavOnMount;
    focusNavOnMount = null;
    restored.current = true;
    requestAnimationFrame(() => setFocus(key));
  }, []);

  // First render with data: restore the previous focus, else the first card.
  useEffect(() => {
    if (!data || restored.current) return;
    restored.current = true;
    const first = data.rows[0];
    const fallback =
      tab === "library" ? firstLibraryKey(data.rows) : first?.items[0] ? `card:${first.id}:${first.items[0].id}` : null;
    requestAnimationFrame(() => {
      try {
        setFocus(lastFocusKey[tab] ?? fallback ?? `nav:${tab}`);
      } catch {
        setFocus(fallback ?? `nav:${tab}`);
      }
    });
  }, [data, tab]);

  // Back from My Library goes to Home.
  useBackKey(() => navigate({ name: "home" }, { replace: true }), tab !== "home");

  const onFocused = useCallback(
    (rowId: string, item: RowItem, key: string) => {
      lastFocusKey[tab] = key;
      setSelected({ rowId, itemId: item.id });
    },
    [tab],
  );

  const switchTab = (to: HomeTab) => {
    if (to === tab) return;
    focusNavOnMount = `nav:${to}`;
    navigate({ name: to }, { replace: true });
  };

  return (
    <div className="home">
      <FocusGroup className="header" focusKey="header" preferredChildFocusKey={`nav:${tab}`}>
        <div className="header-left">
          <div className="brand">Sofarr</div>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <Focusable
                key={t.tab}
                focusKey={`nav:${t.tab}`}
                className={`btn btn-quiet tab${t.tab === tab ? " is-current" : ""}`}
                onSelect={() => switchTab(t.tab)}
                label={t.label}
              >
                {() => t.label}
              </Focusable>
            ))}
          </nav>
        </div>
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
        {data && data.rows.length === 0 && tab === "library" && (
          <p className="muted notice">Nothing in your library yet. Find something on Home or with Search.</p>
        )}
        {data && tab === "library" && data.rows.length > 0 && (
          <Library
            sections={data.rows}
            onFocused={(key) => {
              lastFocusKey.library = key;
            }}
          />
        )}
        {tab === "home" &&
          data?.rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              activeId={selected?.rowId === row.id ? selected.itemId : null}
              onFocused={onFocused}
            />
          ))}
        {data && data.warnings.length > 0 && (
          <p className="muted small warnings">Some rows are missing: {data.warnings.join("; ")}</p>
        )}
      </div>
    </div>
  );
}

/** Forget cached rows (e.g. after switching profile). */
export function resetHome(): void {
  for (const t of TABS) {
    cached[t.tab] = null;
    lastFocusKey[t.tab] = null;
  }
}
