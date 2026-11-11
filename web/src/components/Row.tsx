import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
 * With a mouse, arrows at the row's edges page it sideways.
 */
export function Row({ row, activeId, onFocused }: RowProps) {
  const ref = useRef<HTMLElement>(null);
  /** Whether there are cards out of view to the left / right (for the mouse arrows). */
  const [more, setMore] = useState({ left: false, right: false });
  const track = () => ref.current?.querySelector<HTMLElement>(".row-track") ?? null;

  useLayoutEffect(() => {
    const section = ref.current;
    const card = section?.querySelector<HTMLElement>(".card.is-selected");
    const t = track();
    if (!section || !card || !t) return;
    if (usingPointer()) {
      card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      return;
    }
    const pad = parseFloat(getComputedStyle(t).paddingLeft) || 0;
    t.scrollTo({ left: card.offsetLeft - pad, behavior: "smooth" });
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeId]);

  const measure = useCallback(() => {
    const t = track();
    const cards = t?.querySelectorAll<HTMLElement>(".card");
    const last = cards?.[cards.length - 1];
    if (!t || !last) return;
    const next = { left: t.scrollLeft > 4, right: last.offsetLeft + last.offsetWidth > t.scrollLeft + t.clientWidth + 4 };
    setMore((m) => (m.left === next.left && m.right === next.right ? m : next));
  }, []);
  useEffect(() => {
    const t = track();
    if (!t) return;
    measure();
    t.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      t.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [measure, row.items.length]);

  const page = (dir: -1 | 1) => {
    const t = track();
    t?.scrollBy({ left: dir * t.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <section ref={ref} className={`row${activeId ? " is-active" : ""}${row.ranked ? " is-ranked" : ""}`} aria-label={row.title}>
      <h2 className="row-title">{row.title}</h2>
      <div className="row-body">
        <FocusGroup className="row-track" focusKey={`row:${row.id}`}>
          {row.items.map((item, n) => (
            <Card
              key={item.id}
              item={item}
              focusKey={`card:${row.id}:${item.id}`}
              onFocused={(i, key) => onFocused(row.id, i, key)}
              selected={item.id === activeId}
              reveal={false}
              {...(row.ranked && { rank: n + 1 })}
            />
          ))}
          {/* Room to scroll the last cards to the left edge too. */}
          <div className="row-end" aria-hidden />
        </FocusGroup>
        {/* Mouse only: a remote reaches every card with the arrow keys. */}
        {more.left && (
          <button className="row-page is-left" tabIndex={-1} aria-hidden onClick={() => page(-1)}>
            ‹
          </button>
        )}
        {more.right && (
          <button className="row-page is-right" tabIndex={-1} aria-hidden onClick={() => page(1)}>
            ›
          </button>
        )}
      </div>
    </section>
  );
}
