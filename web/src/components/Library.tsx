import { useMemo, useState } from "react";
import type { Row as Section, RowItem } from "../api/types";
import { FocusGroup, Focusable } from "../nav/focus";
import { Card } from "./Card";

export type LibrarySort = "title" | "released-asc" | "released-desc";

const SORTS: Array<{ sort: LibrarySort; label: string }> = [
  { sort: "title", label: "Title" },
  { sort: "released-asc", label: "Release Date ↑" },
  { sort: "released-desc", label: "Release Date ↓" },
];

const SORT_KEY = "sofarr.librarySort";

// Remembered per browser; storage can be unavailable (private mode), so never required.
function loadSort(): LibrarySort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return SORTS.some((s) => s.sort === v) ? (v as LibrarySort) : "title";
  } catch {
    return "title";
  }
}
function saveSort(s: LibrarySort): void {
  try {
    localStorage.setItem(SORT_KEY, s);
  } catch {
    /* not remembered; fine */
  }
}

/** Sortable date: the full release date, else the year; unknown dates last either way. */
const dateKey = (i: RowItem): string | null => i.released ?? (i.year ? `${i.year}` : null);

/** The server sends title order; release-date sorts keep it for ties. */
export function sortItems(items: RowItem[], sort: LibrarySort): RowItem[] {
  if (sort === "title") return items;
  const dir = sort === "released-asc" ? 1 : -1;
  return items
    .map((item, n) => ({ item, n, d: dateKey(item) }))
    .sort((a, b) => {
      if (a.d === b.d) return a.n - b.n;
      if (a.d === null) return 1;
      if (b.d === null) return -1;
      return (a.d < b.d ? -1 : 1) * dir || a.n - b.n;
    })
    .map((x) => x.item);
}

/** First card's focus key in the current order (for initial focus). */
export function firstLibraryKey(sections: Section[]): string | null {
  const s = sections.find((x) => x.items.length);
  return s ? libraryKey(s.id, sortItems(s.items, loadSort())[0]!.id) : null;
}

const libraryKey = (sectionId: string, itemId: string) => `lib:${sectionId}:${itemId}`;

interface LibraryProps {
  sections: Section[];
  onFocused: (focusKey: string) => void;
}

/** My Library: a sort switch, then one card grid per media type. */
export function Library({ sections, onFocused }: LibraryProps) {
  const [sort, setSort] = useState<LibrarySort>(loadSort);
  const sorted = useMemo(() => sections.map((s) => ({ ...s, items: sortItems(s.items, sort) })), [sections, sort]);

  const choose = (s: LibrarySort) => {
    setSort(s);
    saveSort(s);
  };

  return (
    <div className="library">
      <FocusGroup className="library-sort" focusKey="library-sort" preferredChildFocusKey={`sort:${sort}`}>
        <span className="muted">Sort by</span>
        {SORTS.map((s) => (
          <Focusable
            key={s.sort}
            focusKey={`sort:${s.sort}`}
            className={`btn btn-quiet tab${s.sort === sort ? " is-current" : ""}`}
            onSelect={() => choose(s.sort)}
            onFocused={() => onFocused(`sort:${s.sort}`)}
            label={`Sort by ${s.label}`}
          >
            {() => s.label}
          </Focusable>
        ))}
      </FocusGroup>
      {sorted.map((s) => (
        <section key={s.id} className="library-section" aria-label={s.title}>
          <h2 className="row-title">
            {s.title} <span className="muted library-count">{s.items.length}</span>
          </h2>
          {/* Keyed by sort: a new order starts from its first card, not the old position. */}
          <FocusGroup key={sort} className="library-grid" focusKey={`grid:${s.id}`}>
            {s.items.map((item) => (
              <Card
                key={item.id}
                item={item}
                focusKey={libraryKey(s.id, item.id)}
                onFocused={(_i, key) => onFocused(key)}
                showYear
              />
            ))}
          </FocusGroup>
        </section>
      ))}
    </div>
  );
}
