import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { Home as HomeData, Profile, RowItem } from "../api/types";
import { prefetchArt } from "../components/art";
import { Hero } from "../components/Hero";
import { firstLibraryKey, Library } from "../components/Library";
import { Row } from "../components/Row";
import { GridSkeleton, HeroSkeleton, RowsSkeleton } from "../components/Skeleton";
import { FocusGroup, Focusable, setFocus, useBackKey, usingPointer } from "../nav/focus";
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

const SearchIcon = () => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5 21 21" />
  </svg>
);

/** True once the page has scrolled, so the header can turn solid over the content. */
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(() => window.scrollY > 8);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return scrolled;
}

interface ProfileMenuProps {
  profile: Profile;
  onClose: () => void;
  onSwitchProfile: () => void;
  onSignOut: () => void;
}

/** The avatar's menu. Holds focus while open; Back, or a click elsewhere, closes it. */
function ProfileMenu({ profile, onClose, onSwitchProfile, onSignOut }: ProfileMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useBackKey(onClose);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      // The avatar button toggles the menu itself.
      const el = e.target as Element | null;
      if (!ref.current?.contains(el) && !el?.closest(".header-profile")) onClose();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [onClose]);
  return (
    <div className="menu" ref={ref} role="menu" aria-label="Profile">
      <div className="menu-who">
        <Avatar p={profile} size="sm" />
        <span>{profile.title}</span>
      </div>
      <FocusGroup className="menu-items" focusKey="profile-menu" trap autoFocus>
        <Focusable className="btn btn-quiet menu-item" onSelect={onSwitchProfile} label="Switch profile">
          {() => "Switch profile"}
        </Focusable>
        <Focusable className="btn btn-quiet menu-item" onSelect={onSignOut} label="Sign out">
          {() => "Sign out"}
        </Focusable>
      </FocusGroup>
    </div>
  );
}

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
  const [menuOpen, setMenuOpen] = useState(false);
  const scrolled = useScrolled();

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    // Closed with a click elsewhere: leave focus where the pointer is.
    if (!usingPointer()) setFocus("nav:profile");
  }, []);

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
  useBackKey(() => navigate({ name: "home" }, { replace: true }), tab !== "home" && !menuOpen);

  // What the hero shows: the selected card, or the first one until something is selected.
  const hero = useMemo(() => {
    if (tab !== "home" || !data) return null;
    const row = data.rows.find((r) => r.id === selected?.rowId) ?? data.rows[0];
    if (!row) return null;
    const at = Math.max(0, row.items.findIndex((i) => i.id === selected?.itemId));
    const item = row.items[at];
    return item ? { row, at, item, key: `${row.id}:${item.id}` } : null;
  }, [tab, data, selected]);

  // Have the neighbours' artwork ready before the selection gets there.
  const heroKey = hero?.key;
  useEffect(() => {
    if (!hero || !data) return;
    const t = window.setTimeout(() => {
      const n = data.rows.indexOf(hero.row);
      prefetchArt([hero.row.items[hero.at + 1], hero.row.items[hero.at - 1], data.rows[n + 1]?.items[0], data.rows[n - 1]?.items[0]]);
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroKey]);

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
    <div className={`home home-${tab}`}>
      <FocusGroup className={`header${scrolled ? " is-solid" : ""}`} focusKey="header" preferredChildFocusKey={`nav:${tab}`}>
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
          <Focusable className="btn btn-quiet btn-icon" onSelect={() => navigate({ name: "search", q: "" })} label="Search">
            {() => <SearchIcon />}
          </Focusable>
          <Focusable
            focusKey="nav:profile"
            className={`btn btn-quiet btn-icon header-profile${menuOpen ? " is-open" : ""}`}
            onSelect={() => setMenuOpen((open) => !open)}
            label={`${profile.title}: profile menu`}
          >
            {() => <Avatar p={profile} size="sm" />}
          </Focusable>
          {menuOpen && (
            <ProfileMenu profile={profile} onClose={closeMenu} onSwitchProfile={onSwitchProfile} onSignOut={onSignOut} />
          )}
        </div>
      </FocusGroup>

      {tab === "home" && (hero ? <Hero item={hero.item} itemKey={hero.key} /> : !error && <HeroSkeleton />)}

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
        {!data && !error && (tab === "home" ? <RowsSkeleton /> : <GridSkeleton className="library-grid" heading />)}
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
              activeId={hero?.row.id === row.id ? hero.item.id : null}
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
