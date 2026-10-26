"use client";

import { useEffect, useRef, useState } from "react";
import { cn, GROUP_COLOR } from "@/components/ui";
import type { StageGroup } from "@/lib/mca/stages";
import { activeGroupAt, scrolledToEnd, TAB_LABEL } from "./whichGroup";

export interface GroupTab {
  key: StageGroup;
  /** Full name, for the screen reader. */
  label: string;
  count: number;
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Phone only: a row of stage-group tabs above the board. The pipeline is one very wide strip, so a tab
 * jumps straight to Prospecting / Underwriting / Funded…, and the tab that is lit shows how far along
 * the strip he is (I-20). Collapsed groups open when their tab is tapped.
 */
export function GroupTabs({
  tabs,
  scroller,
  collapsed,
  onToggleGroup,
}: {
  tabs: readonly GroupTab[];
  scroller: HTMLElement | null;
  collapsed: ReadonlySet<StageGroup>;
  onToggleGroup: (g: StageGroup) => void;
}) {
  const [seen, setSeen] = useState<StageGroup | null>(null);
  const row = useRef<HTMLUListElement>(null);
  const current = tabs.some((t) => t.key === seen) ? seen : (tabs[0]?.key ?? null);

  // Follow the board as it scrolls (a swipe, a tab tap, or the auto-scroll of a drag).
  useEffect(() => {
    if (!scroller) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const left = scroller.getBoundingClientRect().left;
      const edges = [...scroller.querySelectorAll<HTMLElement>("[data-group]")].map((el) => ({
        key: el.dataset.group as StageGroup,
        left: el.getBoundingClientRect().left - left,
      }));
      const atEnd = scrolledToEnd(scroller.scrollLeft, scroller.clientWidth, scroller.scrollWidth);
      setSeen(activeGroupAt(edges, scroller.clientWidth / 2, atEnd));
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scroller]);

  // Keep the lit tab in view when the row itself is wider than the screen.
  useEffect(() => {
    const ul = row.current;
    const tab = ul?.querySelector<HTMLElement>("[aria-current=true]");
    if (!ul || !tab) return;
    const over = tab.offsetLeft + tab.offsetWidth - (ul.scrollLeft + ul.clientWidth);
    if (over > 0) ul.scrollLeft += over + 8;
    else if (tab.offsetLeft < ul.scrollLeft) ul.scrollLeft = Math.max(0, tab.offsetLeft - 8);
  }, [current]);

  function jump(key: StageGroup) {
    if (!scroller) return;
    // A collapsed group is a thin strip: open it first, then go there once it has its width.
    if (collapsed.has(key)) onToggleGroup(key);
    const go = () => {
      const target = scroller.querySelector<HTMLElement>(`[data-group="${key}"]`);
      if (!target) return;
      const left =
        scroller.scrollLeft +
        target.getBoundingClientRect().left -
        scroller.getBoundingClientRect().left;
      scroller.scrollTo({ left, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    };
    requestAnimationFrame(() => requestAnimationFrame(go));
  }

  if (tabs.length < 2) return null;
  return (
    <nav
      aria-label="Jump to a stage group"
      className="sticky top-[57px] z-10 -mx-4 bg-bg/95 px-4 py-1 backdrop-blur md:hidden"
    >
      <ul ref={row} className="flex gap-1.5 overflow-x-auto">
        {tabs.map((t) => {
          const lit = t.key === current;
          return (
            <li key={t.key} className="shrink-0">
              <button
                type="button"
                aria-current={lit ? "true" : undefined}
                aria-label={`${t.label}, ${t.count} merchants`}
                onClick={() => jump(t.key)}
                className={cn(
                  "inline-flex h-10 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium whitespace-nowrap transition",
                  lit
                    ? "border-transparent bg-surface text-text shadow-sm"
                    : "border-border bg-surface-2 text-muted",
                )}
                style={lit ? { boxShadow: `inset 0 -3px 0 ${GROUP_COLOR[t.key]}` } : undefined}
              >
                {TAB_LABEL[t.key]}
                <span className="rounded-full bg-surface-2 px-1.5 text-xs text-muted">
                  {t.count}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
