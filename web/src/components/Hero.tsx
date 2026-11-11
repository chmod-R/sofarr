import { useEffect, useState } from "react";
import type { RowItem } from "../api/types";
import { largeBackdrop, useLogo } from "./art";
import { FadeImg } from "./FadeImg";
import { statusLabel } from "./format";

/** How long the selection must rest on a card before the hero changes to it. */
const SETTLE_MS = 180;

interface Shown {
  key: string;
  item: RowItem;
}

/** Follows `next`, but only once it has stopped changing: holding an arrow key doesn't load every title passed. */
function useSettled(next: Shown): Shown {
  const [settled, setSettled] = useState(next);
  useEffect(() => {
    if (next.key === settled.key) return;
    const t = window.setTimeout(() => setSettled(next), SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [next, settled.key]);
  // Same title, newer data (a refresh): no need to wait.
  return next.key === settled.key ? next : settled;
}

/** Full-size artwork that cross-fades: the next image is shown only once it has loaded. */
function Backdrop({ src }: { src: string | null }) {
  const [layers, setLayers] = useState<string[]>([]);
  useEffect(() => {
    if (!src) {
      setLayers([]);
      return;
    }
    let live = true;
    const img = new Image();
    img.onload = () => live && setLayers((l) => (l[l.length - 1] === src ? l : [...l.slice(-1), src]));
    img.onerror = () => live && setLayers([]);
    img.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  return (
    <div className="hero-art" aria-hidden>
      {layers.map((s) => (
        <img key={s} className="hero-backdrop" src={s} alt="" />
      ))}
    </div>
  );
}

function HeroTitle({ item }: { item: RowItem }) {
  const logo = useLogo(item.mediaType, item.tmdbId);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <h1 className="hero-title" aria-label={item.title}>
      {logo === undefined ? null : logo && failed !== logo ? (
        <FadeImg className="hero-logo" src={logo} onError={() => setFailed(logo)} />
      ) : (
        <span className="hero-title-text">{item.title}</span>
      )}
    </h1>
  );
}

/**
 * The top of the home screen: artwork, logo and details of the selected card.
 * It has nothing to focus; Enter on the card opens the title.
 */
export function Hero({ item, itemKey }: { item: RowItem; itemKey: string }) {
  const shown = useSettled({ key: itemKey, item });
  const t = shown.item;
  const meta = [t.year, t.mediaType === "tv" ? "Series" : "Movie", t.rating ? `★ ${t.rating.toFixed(1)}` : null].filter(Boolean);
  return (
    <section className="hero" aria-label="Selected title">
      <Backdrop src={largeBackdrop(t.backdrop)} />
      <div className="hero-body" key={shown.key}>
        <HeroTitle item={t} />
        <div className="hero-meta">
          {meta.map((m) => (
            <span key={String(m)}>{m}</span>
          ))}
          <span className={`pill pill-${t.status}`}>{t.resume?.label ? `Continue · ${t.resume.label}` : statusLabel(t)}</span>
        </div>
        <p className="hero-overview">{t.overview}</p>
      </div>
    </section>
  );
}
