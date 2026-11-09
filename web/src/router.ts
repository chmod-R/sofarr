import { useEffect, useState } from "react";

/** Two routes don't justify a router library. */
export type Route =
  | { name: "home" }
  | { name: "library" }
  | { name: "title"; mediaType: "movie" | "tv"; tmdbId: number }
  | { name: "watch"; plexKey: string; offsetMs?: number }
  | { name: "search"; q: string };

export function parse(path: string, search = ""): Route {
  const m = /^\/title\/(movie|tv)\/(\d+)\/?$/.exec(path);
  if (m) return { name: "title", mediaType: m[1] as "movie" | "tv", tmdbId: Number(m[2]) };
  const w = /^\/watch\/(\d+)\/?$/.exec(path);
  if (w) {
    const t = new URLSearchParams(search).get("t");
    return { name: "watch", plexKey: w[1]!, ...(t !== null && /^\d+$/.test(t) && { offsetMs: Number(t) }) };
  }
  if (/^\/library\/?$/.test(path)) return { name: "library" };
  if (/^\/search\/?$/.test(path)) return { name: "search", q: new URLSearchParams(search).get("q") ?? "" };
  return { name: "home" };
}

export function href(r: Route): string {
  switch (r.name) {
    case "title":
      return `/title/${r.mediaType}/${r.tmdbId}`;
    case "search":
      return r.q ? `/search?q=${encodeURIComponent(r.q)}` : "/search";
    case "library":
      return "/library";
    case "watch":
      return `/watch/${r.plexKey}${r.offsetMs !== undefined ? `?t=${r.offsetMs}` : ""}`;
    default:
      return "/";
  }
}

const CHANGE = "sofarr:navigate";

/** In-app history depth, so Back never leaves Sofarr for whatever page came before it. */
let depth = 0;
window.addEventListener("popstate", () => {
  depth = Math.max(0, depth - 1);
});

export function navigate(r: Route, opts: { replace?: boolean } = {}): void {
  const next = href(r);
  if (next !== location.pathname + location.search) {
    if (opts.replace) {
      history.replaceState(null, "", next);
    } else {
      history.pushState(null, "", next);
      depth++;
    }
  }
  window.dispatchEvent(new Event(CHANGE));
}

/** Back within the app; from a deep link with no history, go home instead. */
export function goBack(): void {
  if (depth > 0) history.back();
  else if (location.pathname !== "/") navigate({ name: "home" }, { replace: true });
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname, location.search));
  useEffect(() => {
    const update = () => setRoute(parse(location.pathname, location.search));
    window.addEventListener("popstate", update);
    window.addEventListener(CHANGE, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(CHANGE, update);
    };
  }, []);
  return route;
}
