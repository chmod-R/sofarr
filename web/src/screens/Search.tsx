import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Title } from "../api/types";
import { Card } from "../components/Card";
import { GridSkeleton } from "../components/Skeleton";
import { FocusGroup, Focusable, setFocus } from "../nav/focus";
import { goBack, navigate } from "../router";

const DEBOUNCE_MS = 350;
const KEYS = "abcdefghijklmnopqrstuvwxyz1234567890".split("");

// Survive a trip to a title page and back.
let lastFocusKey: string | null = null;
const resultsCache = new Map<string, Title[]>();

// Back keys that aren't also text editing: Escape, Samsung Tizen, LG webOS, Android TV.
const BACK_KEYS = new Set(["Escape", "GoBack", "BrowserBack"]);
const BACK_CODES = new Set([10009, 461]);

export function Search({ initialQuery }: { initialQuery: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<Title[] | null>(resultsCache.get(initialQuery.trim()) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search; the URL keeps the query so Back from a title returns here.
  useEffect(() => {
    const q = query.trim();
    navigate({ name: "search", q: query }, { replace: true });
    if (q.length < 2) {
      setResults(null);
      setError(null);
      return;
    }
    const cached = resultsCache.get(q);
    if (cached) {
      setResults(cached);
      return;
    }
    let live = true;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await api.search(q);
        if (!live) return;
        resultsCache.set(q, r.results);
        setResults(r.results);
        setError(null);
      } catch {
        if (live) setError("Search isn't available right now.");
      } finally {
        if (live) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query]);

  // Start on the keyboard, or back on the result you opened.
  useEffect(() => {
    requestAnimationFrame(() => {
      try {
        setFocus(lastFocusKey && results?.length ? lastFocusKey : "kbd:a");
      } catch {
        setFocus("kbd:a");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const type = useCallback((s: string) => setQuery((q) => (q + s).slice(0, 100)), []);
  const backspace = useCallback(() => setQuery((q) => q.slice(0, -1)), []);

  // Typing on a real keyboard while focus is on the on-screen keys (not in the text box).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
      if (BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode)) {
        e.preventDefault();
        goBack();
      } else if (e.key === "Backspace") {
        e.preventDefault();
        if (query) backspace();
        else goBack();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
        e.preventDefault();
        type(e.key.toLowerCase());
      } else if (e.key === " " && document.activeElement === document.body && query) {
        // Space types a space unless it's activating something.
        e.preventDefault();
        type(" ");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [query, type, backspace]);

  const q = query.trim();
  return (
    <main className="search">
      <FocusGroup className="search-side" focusKey="search-side">
        <div className="brand">Sofarr</div>
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          placeholder="Search movies and shows"
          aria-label="Search"
          value={query}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value.slice(0, 100))}
          onKeyDown={(e) => {
            // Keep typing (and arrow keys inside the text) out of TV navigation.
            if (e.key === "Escape") {
              e.currentTarget.blur();
              setFocus("kbd:a");
            }
            e.stopPropagation();
          }}
        />
        <FocusGroup className="kbd" focusKey="kbd">
          {KEYS.map((k) => (
            <Focusable key={k} focusKey={`kbd:${k}`} className="btn kbd-key" onSelect={() => type(k)} label={k}>
              {() => k}
            </Focusable>
          ))}
          <Focusable focusKey="kbd:space" className="btn kbd-key kbd-wide" onSelect={() => type(" ")} label="Space">
            {() => "Space"}
          </Focusable>
          <Focusable focusKey="kbd:del" className="btn kbd-key kbd-wide" onSelect={backspace} label="Delete">
            {() => "Delete"}
          </Focusable>
          <Focusable focusKey="kbd:clear" className="btn kbd-key kbd-wide" onSelect={() => setQuery("")} label="Clear">
            {() => "Clear"}
          </Focusable>
        </FocusGroup>
        <Focusable className="btn btn-quiet search-back" onSelect={goBack} label="Back">
          {() => "← Back"}
        </Focusable>
      </FocusGroup>

      <section className="search-results" aria-live="polite">
        {q.length < 2 && <p className="muted search-hint">Type at least two letters.</p>}
        {q.length >= 2 && loading && !results && <GridSkeleton className="results-grid" count={9} />}
        {error && <p className="error search-hint">{error}</p>}
        {q.length >= 2 && results && results.length === 0 && !loading && (
          <p className="muted search-hint">Nothing found for “{q}”.</p>
        )}
        {q.length >= 2 && results && results.length > 0 && (
          <FocusGroup className="results-grid" focusKey="results">
            {results.map((t) => (
              <Card
                key={t.id}
                item={t}
                focusKey={`result:${t.id}`}
                onFocused={(_i, key) => {
                  lastFocusKey = key;
                }}
                showYear
              />
            ))}
          </FocusGroup>
        )}
      </section>
    </main>
  );
}
