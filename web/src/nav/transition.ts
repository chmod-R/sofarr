import { flushSync } from "react-dom";
import type { Title } from "../api/types";
import { navigate } from "../router";

/**
 * What a card already knows about a title, so its page can show the artwork
 * at once instead of waiting for the details.
 */
const previews = new Map<string, { backdrop: string | null }>();

export function titlePreview(mediaType: string, tmdbId: number): { backdrop: string | null } | undefined {
  return previews.get(`${mediaType}:${tmdbId}`);
}

type Transitions = { startViewTransition?: (update: () => void) => { finished: Promise<unknown> } };

/**
 * Open a title page from a card. Where the browser supports view transitions,
 * the artwork on screen (the home hero's, else the card's own) grows into the
 * title page's backdrop while the rest cross-fades.
 */
export function openTitle(item: Pick<Title, "id" | "mediaType" | "tmdbId" | "backdrop">): void {
  previews.set(item.id, { backdrop: item.backdrop });
  const go = () => navigate({ name: "title", mediaType: item.mediaType, tmdbId: item.tmdbId });
  const doc = document as Document & Transitions;
  if (!doc.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return go();

  // Only one element may carry the shared name; a title page already has its own backdrop under it.
  const art = document.querySelector(".title-backdrop")
    ? null
    : (document.querySelector<HTMLElement>(".hero-backdrop:last-child") ?? document.querySelector<HTMLElement>(".card.is-focused .card-img"));
  if (art && item.backdrop) art.style.viewTransitionName = "title-art";
  try {
    // flushSync: the new page must be in the DOM when the browser takes its "after" picture.
    doc.startViewTransition(() => flushSync(go));
  } catch {
    go();
  }
}
