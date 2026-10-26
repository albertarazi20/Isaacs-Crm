import { diffDays, type ISODate } from "../mca/dates";
import { DECLINE_REASONS, type DeclineReason, type SubmissionStatus } from "./types";

/** One submission, as much as the scoreboard needs. */
export interface SubmissionStat {
  funder_id: string;
  status: SubmissionStatus;
  decline_reason: DeclineReason | null;
  sent_on: ISODate;
  /** The day the funder first answered; null while they haven't. */
  responded_on: ISODate | null;
}

/** One offer a funder made. Every offer counts toward their pricing, whatever happened to it later. */
export interface OfferStat {
  funder_id: string;
  factor_rate: number;
}

export interface ScoreRow {
  funderId: string;
  submissions: number;
  approvals: number;
  declines: number;
  /** Still waiting on an answer: sent, or stips requested. */
  pending: number;
  noResponse: number;
  withdrawn: number;
  /** approvals ÷ (approvals + declines), 0–1. Null until the funder has decided something. */
  approvalRate: number | null;
  /** Reasons they declined, most common first. */
  declinesByReason: { reason: DeclineReason | "unspecified"; count: number }[];
  offerCount: number;
  /** Mean factor rate of everything they offered, to 3 decimals. */
  avgFactor: number | null;
  /** Mean calendar days from sending to their first answer, 1 decimal. */
  avgDaysToRespond: number | null;
}

const round = (n: number, places: number) => {
  const m = 10 ** places;
  return Math.round(n * m) / m;
};

export function emptyScore(funderId: string): ScoreRow {
  return {
    funderId,
    submissions: 0,
    approvals: 0,
    declines: 0,
    pending: 0,
    noResponse: 0,
    withdrawn: 0,
    approvalRate: null,
    declinesByReason: [],
    offerCount: 0,
    avgFactor: null,
    avgDaysToRespond: null,
  };
}

/** One row per funder id given — a funder with no submissions yet still gets a (zeroed) row. */
export function buildScoreboard(
  funderIds: readonly string[],
  submissions: readonly SubmissionStat[],
  offers: readonly OfferStat[],
): Record<string, ScoreRow> {
  const out: Record<string, ScoreRow> = {};
  const reasons = new Map<string, Map<DeclineReason | "unspecified", number>>();
  const days = new Map<string, number[]>();
  const factors = new Map<string, number[]>();
  for (const id of funderIds) {
    out[id] = emptyScore(id);
    reasons.set(id, new Map());
    days.set(id, []);
    factors.set(id, []);
  }

  for (const s of submissions) {
    const row = out[s.funder_id];
    if (!row) continue;
    row.submissions += 1;
    switch (s.status) {
      case "approved":
        row.approvals += 1;
        break;
      case "declined": {
        row.declines += 1;
        const key = s.decline_reason ?? "unspecified";
        const m = reasons.get(s.funder_id);
        m?.set(key, (m.get(key) ?? 0) + 1);
        break;
      }
      case "sent":
      case "stips_requested":
        row.pending += 1;
        break;
      case "no_response":
        row.noResponse += 1;
        break;
      case "withdrawn":
        row.withdrawn += 1;
        break;
    }
    if (s.responded_on !== null) {
      days.get(s.funder_id)?.push(Math.max(0, diffDays(s.sent_on, s.responded_on)));
    }
  }

  for (const o of offers) {
    factors.get(o.funder_id)?.push(o.factor_rate);
  }

  const order = new Map<string, number>(DECLINE_REASONS.map((r, i) => [r, i]));
  for (const id of funderIds) {
    const row = out[id];
    if (!row) continue;
    const decided = row.approvals + row.declines;
    row.approvalRate = decided > 0 ? row.approvals / decided : null;
    row.declinesByReason = [...(reasons.get(id) ?? [])]
      .map(([reason, count]) => ({ reason, count }))
      .sort(
        (a, b) => b.count - a.count || (order.get(a.reason) ?? 99) - (order.get(b.reason) ?? 99),
      );
    const f = factors.get(id) ?? [];
    row.offerCount = f.length;
    row.avgFactor = f.length > 0 ? round(f.reduce((a, b) => a + b, 0) / f.length, 3) : null;
    const d = days.get(id) ?? [];
    row.avgDaysToRespond = d.length > 0 ? round(d.reduce((a, b) => a + b, 0) / d.length, 1) : null;
  }
  return out;
}
