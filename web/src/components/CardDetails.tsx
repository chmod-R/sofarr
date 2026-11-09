import type { RowItem } from "../api/types";
import { statusLabel } from "./format";

/** Info shown under a home row's selected card. Enter opens the full title page. */
export function CardDetails({ item }: { item: RowItem }) {
  const meta = [
    item.year,
    item.mediaType === "tv" ? "Series" : "Movie",
    item.rating ? `★ ${item.rating.toFixed(1)}` : null,
  ].filter(Boolean);
  return (
    <div className="card-details" key={item.id}>
      <div className="hero-meta">
        {meta.map((m) => (
          <span key={String(m)}>{m}</span>
        ))}
        <span className={`pill pill-${item.status}`}>
          {item.resume?.label ? `Continue · ${item.resume.label}` : statusLabel(item)}
        </span>
      </div>
      {item.overview && <p className="card-details-overview">{item.overview}</p>}
    </div>
  );
}
