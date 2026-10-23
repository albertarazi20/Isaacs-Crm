"use client";

import {
  useCallback,
  useEffect,
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
let observer: IntersectionObserver | null = null;

function observe(node: Element, report: Report): () => void {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        reports.get(e.target)?.(e.isIntersecting, e.boundingClientRect.height);
    },
    { rootMargin: "800px 600px" },
  );
  reports.set(node, report);
  observer.observe(node);
  return () => {
    observer?.unobserve(node);
    reports.delete(node);
  };
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

const ESTIMATED_HEIGHT = 150;

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
  const [height, setHeight] = useState(ESTIMATED_HEIGHT);
  const node = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(false);
  const dragging = useSyncExternalStore(
    subscribe,
    () => draggingId === id,
    () => false,
  );
  const live = shown || dragging;

  useEffect(() => {
    const el = node.current;
    if (!el) return;
    return observe(el, (visible, h) => {
      if (visible) {
        setShown(true);
        return;
      }
      // Keyboard users must not lose their place when the mouse wheel scrolls it away.
      if (el.contains(document.activeElement)) return;
      setHeight(h);
      setShown(false);
    });
  }, []);

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
    <div ref={node} style={live ? undefined : { height }}>
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
