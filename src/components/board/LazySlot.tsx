"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/**
 * Cards far from the screen are a plain empty box of the same height; the real card (and its
 * drag-and-drop hooks) only exists near the viewport. Every card subscribing to dnd-kit is what
 * made 2,000 cards slow, and this keeps the live count to a few dozen.
 */

type Report = (visible: boolean, height: number) => void;
const reports = new WeakMap<Element, Report>();
const observers = new WeakMap<Element, IntersectionObserver>();

/**
 * One observer per column, rooted on the column's own scroll box: a margin only widens the area
 * of an explicit root, so this is what makes cards mount a little before they scroll into view.
 */
function observe(root: Element, node: Element, report: Report): () => void {
  let io = observers.get(root);
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          reports.get(e.target)?.(e.isIntersecting, e.boundingClientRect.height);
      },
      { root, rootMargin: "600px 0px" },
    );
    observers.set(root, io);
  }
  reports.set(node, report);
  io.observe(node);
  return () => {
    io.unobserve(node);
    reports.delete(node);
  };
}

interface ColumnView {
  root: HTMLElement | null;
  /** False while the whole column is scrolled well out of sight sideways. */
  near: boolean;
}
const ColumnContext = createContext<ColumnView>({ root: null, near: true });

/** The sideways-scrolling board that holds the columns. */
export const BoardScrollContext = createContext<HTMLElement | null>(null);

/** The scrolling part of a column. Tells its cards when to be real and when to be empty boxes. */
export function LazyColumnBody({ children }: { children: ReactNode }) {
  const board = useContext(BoardScrollContext);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [near, setNear] = useState(true);
  useEffect(() => {
    if (!root || !board) return;
    const io = new IntersectionObserver(([e]) => e && setNear(e.isIntersecting), {
      root: board,
      rootMargin: "0px 700px",
    });
    io.observe(root);
    return () => io.disconnect();
  }, [root, board]);
  const value = useMemo(() => ({ root, near }), [root, near]);
  return (
    <div
      ref={setRoot}
      className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-y-contain p-2"
    >
      <ColumnContext.Provider value={value}>{children}</ColumnContext.Provider>
    </div>
  );
}

// The card being dragged must stay mounted even if auto-scroll carries it far off screen.
let draggingId: string | null = null;
const listeners = new Set<() => void>();

export function setDraggingId(id: string | null): void {
  draggingId = id;
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * What an unseen card is guessed to be until it has been on screen once: roughly the median real card (about 170px
 * on a desktop column, 215px on a phone, where the 40px tap targets make cards taller). A low guess made every card
 * that mounted push the ones below it down by the difference, so a card scrolled to the top of its column slid away.
 */
const GUESSED_HEIGHT = "h-[170px] max-sm:h-[215px]";

export function LazySlot({
  id,
  label,
  eager,
  children,
}: {
  id: string;
  label: string;
  /** The first few cards of a column render at once so the page is never blank. */
  eager: boolean;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(eager);
  const [height, setHeight] = useState<number | null>(null);
  const node = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(false);
  const dragging = useSyncExternalStore(
    subscribe,
    () => draggingId === id,
    () => false,
  );
  const { root, near } = useContext(ColumnContext);
  const live = (shown && near) || dragging;

  useEffect(() => {
    const el = node.current;
    if (!el || !root) return;
    return observe(root, el, (visible, h) => {
      if (visible) {
        setShown(true);
        return;
      }
      // Keyboard users must not lose their place when the mouse wheel scrolls it away.
      if (el.contains(document.activeElement)) return;
      setHeight(h);
      setShown(false);
    });
  }, [root]);

  // Tabbing onto a placeholder swaps in the real card, which then takes the focus.
  useEffect(() => {
    if (live && wantFocus.current) {
      wantFocus.current = false;
      node.current?.querySelector<HTMLElement>("article")?.focus();
    }
  }, [live]);

  const onPlaceholderFocus = useCallback(() => {
    wantFocus.current = true;
    setShown(true);
  }, []);

  return (
    <div
      ref={node}
      className={live || height !== null ? undefined : GUESSED_HEIGHT}
      style={live || height === null ? undefined : { height }}
    >
      {live ? (
        children
      ) : (
        <div
          role="group"
          tabIndex={0}
          aria-label={label}
          onFocus={onPlaceholderFocus}
          className="h-full rounded-lg border border-dashed border-border"
        />
      )}
    </div>
  );
}
