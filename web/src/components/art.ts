import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { MediaType, Title } from "../api/types";

/** Row artwork is card-sized; the hero and the title page want the same image larger. */
export function largeBackdrop(url: string | null): string | null {
  if (!url) return null;
  return url.replace("/w780/", "/w1280/").replace("&w=780&h=439", "&w=1280&h=720");
}

// Title logos, looked up once per title and kept for the life of the page.
const logos = new Map<string, string | null>();
const pending = new Map<string, Promise<void>>();

function loadLogo(mediaType: MediaType, tmdbId: number): Promise<void> {
  const id = `${mediaType}:${tmdbId}`;
  let p = pending.get(id);
  if (!p) {
    p = api.logo(mediaType, tmdbId).then(
      (r) => void logos.set(id, r.logo),
      // No logo source, or it failed: the plain title is shown instead.
      () => void logos.set(id, null),
    );
    pending.set(id, p);
  }
  return p;
}

/** A title's logo URL; `null` when it has none, `undefined` while still looking. */
export function useLogo(mediaType: MediaType, tmdbId: number): string | null | undefined {
  const id = `${mediaType}:${tmdbId}`;
  const [, redraw] = useState(0);
  useEffect(() => {
    if (logos.has(id)) return;
    let live = true;
    void loadLogo(mediaType, tmdbId).then(() => live && redraw((n) => n + 1));
    return () => {
      live = false;
    };
  }, [id, mediaType, tmdbId]);
  return logos.get(id);
}

/** Fetch the hero artwork of titles the selection is likely to reach next. */
export function prefetchArt(items: Array<Pick<Title, "mediaType" | "tmdbId" | "backdrop"> | undefined>): void {
  for (const item of items) {
    if (!item) continue;
    void loadLogo(item.mediaType, item.tmdbId).then(() => {
      const logo = logos.get(`${item.mediaType}:${item.tmdbId}`);
      if (logo) new Image().src = logo;
    });
    const backdrop = largeBackdrop(item.backdrop);
    if (backdrop) new Image().src = backdrop;
  }
}
