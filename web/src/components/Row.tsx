import type { Row as RowData, RowItem } from "../api/types";
import { FocusGroup } from "../nav/focus";
import { Card } from "./Card";

interface RowProps {
  row: RowData;
  onFocused: (item: RowItem, focusKey: string) => void;
}

export function Row({ row, onFocused }: RowProps) {
  return (
    <section className="row" aria-label={row.title}>
      <h2 className="row-title">{row.title}</h2>
      <FocusGroup className="row-track" focusKey={`row:${row.id}`}>
        {row.items.map((item) => (
          <Card key={item.id} item={item} focusKey={`card:${row.id}:${item.id}`} onFocused={onFocused} />
        ))}
      </FocusGroup>
    </section>
  );
}
