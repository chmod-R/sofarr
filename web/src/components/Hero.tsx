import type { RowItem } from "../api/types";
import { statusLabel } from "./format";

/**
 * TV-style info panel: shows whatever card is focused, so the row itself can
 * stay compact. (Enter on a card opens the full title page.)
 */
export function Hero({ item }: { item: RowItem | null }) {
  if (!item) return <div className="hero hero-empty" />;
  const meta = [
    item.year,
    item.mediaType === "tv" ? "Series" : "Movie",
    item.rating ? `★ ${item.rating.toFixed(1)}` : null,
  ].filter(Boolean);
  return (
    <div className="hero">
      {item.backdrop && <img key={item.backdrop} className="hero-img" src={item.backdrop} alt="" />}
      <div className="hero-shade" />
      <div className="hero-body">
        <h1 className="hero-title">{item.title}</h1>
        <div className="hero-meta">
          {meta.map((m) => (
            <span key={String(m)}>{m}</span>
          ))}
          <span className={`pill pill-${item.status}`}>
            {item.resume?.label ? `Continue · ${item.resume.label}` : statusLabel(item)}
          </span>
        </div>
        {item.overview && <p className="hero-overview">{item.overview}</p>}
      </div>
    </div>
  );
}
