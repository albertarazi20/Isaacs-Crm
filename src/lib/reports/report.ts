import type { ISODate } from "../mca/dates";
import { STAGE_KEYS, type StageKey } from "../mca/stages";

/**
 * How far along the road to a funded advance a stage is. Exits (declined, lost, killed, dead, not
 * interested) have no rank: they say where a deal ENDED, not how far it got. Everything after Funded
 * ranks as funded — those merchants got the money.
 */
const RANK: Record<StageKey, number | null> = {
  name_in: 0,
  spoke_with_owner: 1,
  interested: 2,
  call_scheduled: 2,
  application_sent: 3,
  application_in: 4,
  stips: 5,
  submitted: 6,
  offers_in: 7,
  offer_presented: 8,
  contract_out: 9,
  funded: 10,
  paying_off_soon: 10,
  paid_in_full: 10,
  default_workable: 10,
  default_bad: 10,
  legal_collections: 10,
  written_off: 10,
  declined: null,
  lost: null,
  killed: null,
  dead: null,
  not_interested: null,
};

export const EXIT_STAGES: readonly StageKey[] = [
  "declined",
  "lost",
  "killed",
  "dead",
  "not_interested",
];

/** The steps the funnel shows, in order. A merchant counts at a step once they reached `rank` or higher. */
export const FUNNEL_STEPS = [
  { key: "added", label: "Added", rank: 0 },
  { key: "spoke", label: "Spoke with owner", rank: 1 },
  { key: "interested", label: "Interested", rank: 2 },
  { key: "application", label: "Application in", rank: 4 },
  { key: "submitted", label: "Submitted to funders", rank: 6 },
  { key: "offers", label: "Offers in", rank: 7 },
  { key: "contract", label: "Contract out", rank: 9 },
  { key: "funded", label: "Funded", rank: 10 },
] as const;

export interface ReportClient {
  id: string;
  source: string;
  stage: StageKey;
  createdAt: string;
  /** First time the merchant entered each stage (ISO timestamps), from the history. */
  reached: Partial<Record<StageKey, string>>;
  fundedCents: number;
  advances: number;
}

/** Furthest rank the merchant ever reached, counting where they are now. */
export function furthestRank(c: Pick<ReportClient, "stage" | "reached">): number {
  let best = 0;
  for (const s of [c.stage, ...(Object.keys(c.reached) as StageKey[])]) {
    if (!STAGE_KEYS.includes(s)) continue;
    const r = RANK[s];
    if (r !== null && r > best) best = r;
  }
  return best;
}

export interface FunnelRow {
  key: string;
  label: string;
  count: number;
  /** Share of everyone added, 0–100. */
  ofAdded: number;
  /** Share of the step before, 0–100; null for the first step. */
  ofPrevious: number | null;
}

export function buildFunnel(clients: readonly ReportClient[]): FunnelRow[] {
  const ranks = clients.map(furthestRank);
  const total = clients.length;
  return FUNNEL_STEPS.map((step, i) => {
    const count = ranks.filter((r) => r >= step.rank).length;
    const prev = i === 0 ? null : ranks.filter((r) => r >= FUNNEL_STEPS[i - 1]!.rank).length;
    return {
      key: step.key,
      label: step.label,
      count,
      ofAdded: pct(count, total),
      ofPrevious: prev === null ? null : pct(count, prev),
    };
  });
}

export interface DeathPoint {
  label: string;
  count: number;
}

/** For merchants now in an exit stage: the furthest funnel step they reached before it ended. */
export function buildDeathPoints(clients: readonly ReportClient[]): DeathPoint[] {
  const counts = new Map<string, number>();
  for (const c of clients) {
    if (!EXIT_STAGES.includes(c.stage)) continue;
    const r = furthestRank(c);
    const step = [...FUNNEL_STEPS].reverse().find((s) => r >= s.rank) ?? FUNNEL_STEPS[0];
    const label = step.rank === 0 ? "Never reached the owner" : `After ${step.label}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const order = (label: string) =>
    label === "Never reached the owner"
      ? -1
      : FUNNEL_STEPS.findIndex((s) => label === `After ${s.label}`);
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => order(a.label) - order(b.label));
}

export const MIN_SAMPLE = 3;

export interface SpeedRow {
  label: string;
  /** Median days; null when fewer than MIN_SAMPLE merchants have both ends. */
  medianDays: number | null;
  n: number;
}

const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** The first time a merchant reached `rank` or beyond, from the history. */
function firstReached(c: ReportClient, rank: number): string | null {
  let best: string | null = null;
  for (const [stage, at] of Object.entries(c.reached) as [StageKey, string][]) {
    const r = RANK[stage];
    if (r === null || r < rank) continue;
    if (best === null || Date.parse(at) < Date.parse(best)) best = at;
  }
  return best;
}

export function buildSpeed(clients: readonly ReportClient[]): SpeedRow[] {
  const between = (label: string, fromRank: number | "added", toRank: number): SpeedRow => {
    const gaps: number[] = [];
    for (const c of clients) {
      const from = fromRank === "added" ? c.createdAt : firstReached(c, fromRank);
      const to = firstReached(c, toRank);
      if (!from || !to) continue;
      const d = days(from, to);
      if (d >= 0) gaps.push(d);
    }
    return {
      label,
      n: gaps.length,
      medianDays: gaps.length >= MIN_SAMPLE ? Math.round(median(gaps) * 10) / 10 : null,
    };
  };
  return [
    between("Added → Interested", "added", 2),
    between("Added → Application in", "added", 4),
    between("Application in → Funded", 4, 10),
    between("Added → Funded", "added", 10),
  ];
}

export interface SourceRow {
  source: string;
  added: number;
  interested: number;
  funded: number;
  fundedCents: number;
  /** Funded as a share of added, 0–100. */
  rate: number;
  /** Too few merchants to trust the rate. */
  small: boolean;
}

export const NO_SOURCE = "(no source entered)";

export function buildSources(clients: readonly ReportClient[]): SourceRow[] {
  const groups = new Map<string, { label: Map<string, number>; rows: ReportClient[] }>();
  for (const c of clients) {
    const trimmed = c.source.trim().replace(/\s+/g, " ");
    const key = trimmed.toLowerCase();
    const g: { label: Map<string, number>; rows: ReportClient[] } = groups.get(key) ?? {
      label: new Map(),
      rows: [],
    };
    g.label.set(trimmed, (g.label.get(trimmed) ?? 0) + 1);
    g.rows.push(c);
    groups.set(key, g);
  }
  const out: SourceRow[] = [];
  for (const [key, g] of groups) {
    const ranks = g.rows.map(furthestRank);
    const funded = ranks.filter((r) => r >= 10).length;
    const label =
      key === ""
        ? NO_SOURCE
        : [...g.label].sort(
            // Most common spelling; on a tie, the one that isn't all lowercase ("Referral" over "referral").
            (a, b) =>
              b[1] - a[1] ||
              Number(a[0] === a[0].toLowerCase()) - Number(b[0] === b[0].toLowerCase()) ||
              a[0].localeCompare(b[0]),
          )[0]![0];
    out.push({
      source: label,
      added: g.rows.length,
      interested: ranks.filter((r) => r >= 2).length,
      funded,
      fundedCents: g.rows.reduce((n, c) => n + c.fundedCents, 0),
      rate: pct(funded, g.rows.length),
      small: g.rows.length < 5,
    });
  }
  return out.sort(
    (a, b) =>
      b.fundedCents - a.fundedCents || b.added - a.added || a.source.localeCompare(b.source),
  );
}

export interface TimerHistory {
  dueOn: ISODate;
  /** The day, in the user's time zone, the timer was closed; null while still open. */
  doneOn: ISODate | null;
  doneReason: "completed" | "replaced" | "stage_moved" | "cancelled" | null;
}

export interface Discipline {
  total: number;
  /** Done on or before its due day. */
  onTime: number;
  /** Done, but after its due day. */
  late: number;
  /** Pushed to a later date instead of being done (snoozed). */
  pushed: number;
  /** Past due and still open today. */
  overdue: number;
  /** onTime as a share of total, 0–100; null when nothing came due. */
  onTimeRate: number | null;
}

/**
 * How well the follow-ups that CAME DUE were handled. Timers still in the future, due today, or cancelled
 * on purpose (do-not-contact, trash, a call that was called off) are not counted either way.
 */
export function buildDiscipline(timers: readonly TimerHistory[], today: ISODate): Discipline {
  const d: Discipline = {
    total: 0,
    onTime: 0,
    late: 0,
    pushed: 0,
    overdue: 0,
    onTimeRate: null,
  };
  for (const t of timers) {
    if (t.dueOn > today) continue;
    if (t.doneOn === null) {
      if (t.dueOn === today) continue;
      d.overdue += 1;
    } else if (t.doneReason === "completed" || t.doneReason === "stage_moved") {
      // Moving the deal to another stage handles the follow-up too: it sets the next timer.
      if (t.doneOn <= t.dueOn) d.onTime += 1;
      else d.late += 1;
    } else if (t.doneReason === "replaced") d.pushed += 1;
    else continue;
    d.total += 1;
  }
  d.onTimeRate = d.total === 0 ? null : pct(d.onTime, d.total);
  return d;
}

function pct(n: number, of: number): number {
  return of === 0 ? 0 : Math.round((n / of) * 1000) / 10;
}
