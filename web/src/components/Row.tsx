import { useLayoutEffect, useRef } from "react";
import type { Row as RowData, RowItem } from "../api/types";
import { FocusGroup, usingPointer } from "../nav/focus";
import { Card } from "./Card";

interface RowProps {
  row: RowData;
  /** The selected card's id when this is the active row, else null. */
  activeId: string | null;
  onFocused: (rowId: string, item: RowItem, focusKey: string) => void;
}

/**
 * A home row. The hero above shows the selected card's title. With keys / a
 * remote, that card is kept at the row's left edge and its row at the top of the
 * rows area, so the selection stays in one place and the content moves to it.
 */
export function Row({ row, activeId, onFocused }: RowProps) {
  const ref = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const section = ref.current;
    const card = section?.querySelector<HTMLElement>(".card.is-selected");
    const track = card?.parentElement;
    if (!section || !card || !track) return;
    if (usingPointer()) {
      card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      return;
    }
    const pad = parseFloat(getComputedStyle(track).paddingLeft) || 0;
    track.scrollTo({ left: card.offsetLeft - pad, behavior: "smooth" });
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeId]);

  return (
    <section ref={ref} className={`row${activeId ? " is-active" : ""}`} aria-label={row.title}>
      <h2 className="row-title">{row.title}</h2>
      <FocusGroup className="row-track" focusKey={`row:${row.id}`}>
        {row.items.map((item) => (
          <Card
            key={item.id}
            item={item}
            focusKey={`card:${row.id}:${item.id}`}
            onFocused={(i, key) => onFocused(row.id, i, key)}
            selected={item.id === activeId}
            reveal={false}
          />
        ))}
        {/* Room to scroll the last cards to the left edge too. */}
        <div className="row-end" aria-hidden />
      </FocusGroup>
    </section>
  );
}
