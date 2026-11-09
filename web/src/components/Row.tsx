import { useLayoutEffect, useRef } from "react";
import type { Row as RowData, RowItem } from "../api/types";
import { FocusGroup, usingPointer } from "../nav/focus";
import { Card } from "./Card";
import { CardDetails } from "./CardDetails";

interface RowProps {
  row: RowData;
  /** The selected card's id when this is the active row, else null. */
  activeId: string | null;
  onFocused: (rowId: string, item: RowItem, focusKey: string) => void;
}

/**
 * A home row. The active row draws its selected card larger with the title's
 * details underneath; with keys / a remote, that card is kept at the row's left
 * edge and the row at the top of the screen, so the selection stays in one place.
 */
export function Row({ row, activeId, onFocused }: RowProps) {
  const ref = useRef<HTMLElement>(null);
  const active = activeId ? row.items.find((i) => i.id === activeId) : undefined;

  // After layout, so the previously selected card has already shrunk.
  useLayoutEffect(() => {
    const section = ref.current;
    const card = section?.querySelector<HTMLElement>(".card.is-expanded");
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
    <section ref={ref} className={`row${active ? " is-active" : ""}`} aria-label={row.title}>
      <h2 className="row-title">{row.title}</h2>
      <FocusGroup className="row-track" focusKey={`row:${row.id}`}>
        {row.items.map((item) => (
          <Card
            key={item.id}
            item={item}
            focusKey={`card:${row.id}:${item.id}`}
            onFocused={(i, key) => onFocused(row.id, i, key)}
            expanded={item.id === active?.id}
            reveal={false}
          />
        ))}
        {/* Room to scroll the last cards to the left edge too. */}
        <div className="row-end" aria-hidden />
      </FocusGroup>
      {active && <CardDetails item={active} />}
    </section>
  );
}
