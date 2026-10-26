import type { StageGroup, StageKey } from "../mca/stages";
import { mostCommonSpelling } from "../mca/spelling";
import { stageDef } from "../mca/stages";
import type { ClientCard } from "./types";

export type QuietFilter = "any" | "30" | "90" | "180" | "never";

export interface ClientFilters {
  term: string;
  group: StageGroup | "all";
  stage: StageKey | "all";
  source: string;
  state: string;
  industry: string;
  /** Cents; 0 = any. Compared against what the merchant wants. */
  minWanted: number;
  /** "Not contacted in" — days since the last call, text or email, or never. */
  quiet: QuietFilter;
}

export const NO_FILTERS: ClientFilters = {
  term: "",
  group: "all",
  stage: "all",
  source: "all",
  state: "all",
  industry: "all",
  minWanted: 0,
  quiet: "any",
};

const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const DAY = 86_400_000;

function matchesTerm(c: ClientCard, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  const digits = t.replace(/\D/g, "");
  return (
    c.business_name.toLowerCase().includes(t) ||
    c.dba.toLowerCase().includes(t) ||
    c.contact_name.toLowerCase().includes(t) ||
    c.email.toLowerCase().includes(t) ||
    (digits.length >= 3 && c.phone.replace(/\D/g, "").includes(digits))
  );
}

export function applyFilters(
  cards: readonly ClientCard[],
  f: ClientFilters,
  nowMs: number,
): ClientCard[] {
  return cards.filter((c) => {
    if (!matchesTerm(c, f.term)) return false;
    if (f.group !== "all" && stageDef(c.stage).group !== f.group) return false;
    if (f.stage !== "all" && c.stage !== f.stage) return false;
    if (f.source !== "all" && key(c.source) !== key(f.source)) return false;
    if (f.state !== "all" && key(c.state) !== key(f.state)) return false;
    if (f.industry !== "all" && key(c.industry) !== key(f.industry)) return false;
    if (f.minWanted > 0 && (c.wanted_amount_cents ?? 0) < f.minWanted) return false;
    if (f.quiet !== "any") {
      const last = c.last_touch_at ? Date.parse(c.last_touch_at) : null;
      if (f.quiet === "never") return last === null;
      // "Not contacted in 90 days" includes people never contacted at all.
      if (last !== null && nowMs - last < Number(f.quiet) * DAY) return false;
    }
    return true;
  });
}

export interface Facets {
  sources: string[];
  states: string[];
  industries: string[];
}

/** The distinct values in use, one per spelling, in the most common spelling. Blank values are left out. */
export function facetsOf(cards: readonly ClientCard[]): Facets {
  const pick = (values: readonly string[]): string[] => {
    const groups = new Map<string, Map<string, number>>();
    for (const raw of values) {
      const label = raw.trim().replace(/\s+/g, " ");
      if (!label) continue;
      const g = groups.get(key(label)) ?? new Map<string, number>();
      g.set(label, (g.get(label) ?? 0) + 1);
      groups.set(key(label), g);
    }
    return [...groups.values()].map(mostCommonSpelling).sort((a, b) => a.localeCompare(b));
  };
  return {
    sources: pick(cards.map((c) => c.source)),
    states: pick(cards.map((c) => c.state)),
    industries: pick(cards.map((c) => c.industry)),
  };
}

/** How many filters (not counting search and sort) are narrowing the list. */
export function activeCount(f: ClientFilters): number {
  return [
    f.group !== "all",
    f.stage !== "all",
    f.source !== "all",
    f.state !== "all",
    f.industry !== "all",
    f.minWanted > 0,
    f.quiet !== "any",
  ].filter(Boolean).length;
}
