// A list that draws only the rows in view (and a few either side), so 10,000 tracks scroll as quickly as
// ten. Rows are one fixed height, which keeps the arithmetic exact and needs no measuring.
//
// The FLX4 and the keyboard: every drawn row is a stop for the ring (BROWSE turn, Tab). Ringing a row
// scrolls it into view (focus-navigation.ts), which draws the rows past it before the next detent, so
// BROWSE turns through the whole list. ↑ / ↓, Page Up / Down, Home and End move by rows as well.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/** Rows drawn beyond each edge of the view: more than a fast BROWSE spin moves in one message. */
const OVERSCAN = 8;
/** The view's height before it is measured (and in a test with no layout). */
const FALLBACK_VIEW_PX = 480;

export interface VirtualListProps<Item> {
  readonly items: readonly Item[];
  readonly rowHeight: number;
  readonly itemKey: (item: Item) => string;
  /** The row's own element is drawn here; its contents come from `render`. */
  readonly render: (item: Item, index: number) => ReactNode;
  readonly rowProps: (item: Item, index: number) => { readonly "aria-label": string; readonly className?: string; readonly [data: `data-${string}`]: string | undefined };
  readonly label: string;
  /** Marks the list as where the ring starts (data-nav-start). */
  readonly navStart?: boolean;
  readonly onRowFocus?: (item: Item, index: number) => void;
  /** A click or tap on the row, and BROWSE press with the ring on it. */
  readonly onRowClick?: (item: Item) => void;
  /** A key on a row that is not a move: return true when it was handled. */
  readonly onRowKey?: (item: Item, event: KeyboardEvent<HTMLLIElement>) => boolean;
  /** Changes when the list should put the ring on its first row (after a facet is picked). */
  readonly focusFirstSignal?: number;
}

const MOVES: Readonly<Record<string, (index: number, page: number, last: number) => number>> = {
  ArrowDown: (index) => index + 1,
  ArrowUp: (index) => index - 1,
  PageDown: (index, page) => index + page,
  PageUp: (index, page) => index - page,
  Home: () => 0,
  End: (_index, _page, last) => last,
};

export function VirtualList<Item>({ items, rowHeight, itemKey, render, rowProps, label, navStart = false, onRowFocus, onRowClick, onRowKey, focusFirstSignal }: VirtualListProps<Item>) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewPx, setViewPx] = useState(FALLBACK_VIEW_PX);
  /** A row to ring once it is drawn (it was scrolled to, not yet drawn). */
  const pendingFocus = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const measure = () => {
      setViewPx(element.clientHeight > 0 ? element.clientHeight : FALLBACK_VIEW_PX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  // A shorter list (a new filter) may leave the view scrolled past its end.
  useEffect(() => {
    const element = scroller.current;
    if (element !== null && element.scrollTop > items.length * rowHeight) {
      element.scrollTop = 0;
      setScrollTop(0);
    }
  }, [items.length, rowHeight]);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((scrollTop + viewPx) / rowHeight) + OVERSCAN);

  /** Scrolls row `index` into view, then rings it once it is drawn. */
  const focusRow = useCallback(
    (index: number) => {
      const element = scroller.current;
      if (element === null || items.length === 0) return;
      const target = Math.max(0, Math.min(items.length - 1, index));
      const top = target * rowHeight;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + rowHeight - element.clientHeight;
      const drawn = element.querySelector<HTMLElement>(`[data-index="${String(target)}"]`);
      if (drawn !== null) {
        drawn.focus({ preventScroll: true });
        return;
      }
      pendingFocus.current = target;
      setScrollTop(element.scrollTop);
    },
    [items.length, rowHeight],
  );

  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    const drawn = scroller.current?.querySelector<HTMLElement>(`[data-index="${String(index)}"]`);
    if (drawn == null) return;
    pendingFocus.current = null;
    drawn.focus({ preventScroll: true });
  }, [first, last]);

  useEffect(() => {
    if (focusFirstSignal !== undefined && focusFirstSignal > 0) focusRow(0);
  }, [focusFirstSignal, focusRow]);

  const onKeyDown = (item: Item, index: number) => (event: KeyboardEvent<HTMLLIElement>) => {
    // A key on a button inside the row is the button's.
    if (event.target !== event.currentTarget) return;
    const move = MOVES[event.key];
    if (move !== undefined && !event.altKey && !event.ctrlKey && !event.metaKey) {
      // Never the decks' arrow keys (nudge) while the ring is on the list.
      event.preventDefault();
      event.stopPropagation();
      focusRow(move(index, Math.max(1, Math.floor(viewPx / rowHeight) - 1), items.length - 1));
      return;
    }
    if (onRowKey?.(item, event) === true) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div
      ref={scroller}
      className="lb-scroll"
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
      }}
    >
      <ul aria-label={label} className="lb-rows" style={{ height: `${String(items.length * rowHeight)}px` }} {...(navStart ? { "data-nav-start": "" } : {})}>
        {items.slice(first, last).map((item, offset) => {
          const index = first + offset;
          return (
            <li
              key={itemKey(item)}
              {...rowProps(item, index)}
              data-index={index}
              tabIndex={0}
              style={{ top: `${String(index * rowHeight)}px`, height: `${String(rowHeight)}px` }}
              onFocus={(event) => {
                if (event.target === event.currentTarget) onRowFocus?.(item, index);
              }}
              onKeyDown={onKeyDown(item, index)}
              {...(onRowClick === undefined ? {} : { onClick: () => { onRowClick(item); } })}
            >
              {render(item, index)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
