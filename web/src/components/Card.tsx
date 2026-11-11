import type { RowItem } from "../api/types";
import { Focusable } from "../nav/focus";
import { openTitle } from "../nav/transition";
import { navigate } from "../router";
import { FadeImg } from "./FadeImg";
import { shortDate } from "./format";

/** Small corner badge: only for titles you can't just play. */
function Badge({ item }: { item: RowItem }) {
  switch (item.status) {
    case "available":
      return <span className="badge badge-get" aria-label="Available to get">+</span>;
    case "requested":
      return <span className="badge badge-wait">{item.availableFrom ? shortDate(item.availableFrom) : "Requested"}</span>;
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
  /** Home rows: this is the row's selected card (the one the hero shows). */
  selected?: boolean;
  /** Scroll into view on focus (default). Home rows position cards themselves. */
  reveal?: boolean;
  /** Top 10 rows: this card's place, drawn as a large numeral beside it. */
  rank?: number;
}

const RIBBON = { new: "New", "new-episodes": "New episodes" } as const;

export function Card({ item, focusKey, onFocused, showYear, selected, reveal, rank }: CardProps) {
  const image = item.backdrop ?? item.poster;
  const progress = progressOf(item);
  const art = (
    <>
      {image ? (
        <FadeImg className="card-img" src={image} lazy />
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
      {item.fresh && !item.resume && <span className="ribbon">{RIBBON[item.fresh]}</span>}
      <Badge item={item} />
      {progress !== null && (
        <div className={`card-progress ${item.resume ? "is-resume" : "is-download"}`}>
          <div style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} />
        </div>
      )}
    </>
  );
  return (
    <Focusable
      focusKey={focusKey}
      className={`card status-${item.status}${selected ? " is-selected" : ""}${rank ? " is-ranked" : ""}`}
      label={rank ? `Number ${rank}: ${item.title}` : item.title}
      reveal={reveal}
      onFocused={() => onFocused(item, focusKey)}
      onSelect={() =>
        item.resume
          ? navigate({ name: "watch", plexKey: item.resume.plexKey })
          : openTitle(item)
      }
    >
      {() =>
        rank ? (
          <>
            <span className="card-rank" aria-hidden>
              {rank}
            </span>
            <div className="card-art">{art}</div>
          </>
        ) : (
          art
        )
      }
    </Focusable>
  );
}
