import type { StageGroup } from "@/lib/mca/stages";

/** A group's left edge, measured from the left edge of the scrolling board. */
export interface GroupEdge {
  key: StageGroup;
  left: number;
}

/**
 * Which stage group the phone Board is showing: the last one whose left edge has come within `reach`
 * pixels of the board's left edge. At the very end of the strip the last group wins, because a narrow
 * one (collapsed, or only a stage or two) can never get that far left. With nothing to scroll the first
 * group is the one on show.
 */
export function activeGroupAt(
  edges: readonly GroupEdge[],
  reach: number,
  atEnd: boolean,
): StageGroup | null {
  const first = edges[0];
  const last = edges[edges.length - 1];
  if (!first || !last) return null;
  if (atEnd) return last.key;
  let active = first.key;
  for (const e of edges) if (e.left <= reach) active = e.key;
  return active;
}

/** True once the board is scrolled to its far right (and there was something to scroll). */
export function scrolledToEnd(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): boolean {
  return scrollWidth > clientWidth + 2 && scrollLeft + clientWidth >= scrollWidth - 2;
}

/** The short names the tab row uses so five tabs fit a phone; the full name stays in the aria-label. */
export const TAB_LABEL: Record<StageGroup, string> = {
  prospecting: "Prospecting",
  underwriting: "Underwriting",
  funded: "Funded",
  trouble: "Default",
  exit: "Exits",
};
