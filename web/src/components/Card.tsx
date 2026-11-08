import type { RowItem } from "../api/types";
import { Focusable } from "../nav/focus";
import { navigate } from "../router";
import { shortDate } from "./format";

/** Small corner badge: only for titles you can't just play. */
function Badge({ item }: { item: RowItem }) {
  switch (item.status) {
    case "available":
      return <span className="badge badge-get" aria-label="Available to get">+</span>;
    case "requested":
      return <span className="badge badge-wait">Requested</span>;
    case "upcoming":
      return <span className="badge badge-wait">{item.availableFrom ? shortDate(item.availableFrom) : "Soon"}</span>;
    case "downloading":
      return <span className="badge badge-dl">↓</span>;
    default:
      return null;
  }
}

function progressOf(item: RowItem): number | null {
  if (item.resume) return item.resume.percent;
  if (item.status === "downloading" && item.download) return item.download.percent;
  return null;
}

interface CardProps {
  item: RowItem;
  focusKey: string;
  onFocused: (item: RowItem, focusKey: string) => void;
  /** Show year and type under the title (search results mix eras). */
  showYear?: boolean;
}

export function Card({ item, focusKey, onFocused, showYear }: CardProps) {
  const image = item.backdrop ?? item.poster;
  const progress = progressOf(item);
  return (
    <Focusable
      focusKey={focusKey}
      className={`card status-${item.status}`}
      label={item.title}
      onFocused={() => onFocused(item, focusKey)}
      onSelect={() =>
        item.resume
          ? navigate({ name: "watch", plexKey: item.resume.plexKey })
          : navigate({ name: "title", mediaType: item.mediaType, tmdbId: item.tmdbId })
      }
    >
      {() => (
        <>
          {image ? (
            <img className="card-img" src={image} alt="" loading="lazy" decoding="async" />
          ) : (
            <div className="card-img card-img-missing" />
          )}
          <div className="card-shade" />
          <div className="card-title">
            {item.title}
            {item.resume?.label && <span className="card-sub">{item.resume.label}</span>}
            {showYear && !item.resume && (
              <span className="card-sub">{[item.year, item.mediaType === "tv" ? "Series" : "Movie"].filter(Boolean).join(" · ")}</span>
            )}
          </div>
          <Badge item={item} />
          {progress !== null && (
            <div className={`card-progress ${item.resume ? "is-resume" : "is-download"}`}>
              <div style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} />
            </div>
          )}
        </>
      )}
    </Focusable>
  );
}
