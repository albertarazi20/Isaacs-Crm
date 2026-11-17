import { describe, expect, it } from "vitest";
import {
  ageFactor,
  businessDaySlots,
  compareBiggest,
  daysOverdue,
  isBusinessDay,
  MAX_BULK,
  overdueCards,
  planBulk,
  planSpread,
  priorityOf,
  rankCards,
  snoozeNeedsReason,
  STAKE_CAP_CENTS,
  UNKNOWN_STAKE_CENTS,
  type PriorityCtx,
} from "@/lib/data/priority";
import type { ClientCard } from "@/lib/data/types";
import { addDays } from "@/lib/mca/dates";
import { STAGE_KEYS, stageDef, type StageKey } from "@/lib/mca/stages";

const TODAY = "2026-10-23"; // a Friday
const CTX: PriorityCtx = { today: TODAY };

let seq = 0;
function card(over: Partial<ClientCard> & { business_name?: string } = {}): ClientCard {
  seq += 1;
  return {
    id: over.id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    business_name: over.business_name ?? `Biz ${seq}`,
    dba: "",
    contact_name: "",
    phone: "",
    email: "",
    industry: "",
    state: "",
    source: "",
    monthly_revenue_cents: null,
    time_in_business_months: null,
    stage: "interested",
    stage_changed_at: "2026-10-01T00:00:00Z",
    application_received_on: null,
    scheduled_call_at: null,
    last_contact_at: null,
    contact_status: "ok",
    contact_status_note: "",
    contact_status_at: null,
    created_at: "2026-10-01T00:00:00Z",
    next_due_on: TODAY,
    next_due_kind: "follow_up",
    last_call_at: null,
    last_touch_at: null,
    last_call_note: null,
    wanted_amount_cents: null,
    stips_required: 0,
    stips_received: 0,
    ...over,
  };
}

const score = (c: ClientCard, ctx: PriorityCtx = CTX) => priorityOf(c, ctx).score;
const names = (r: { card: ClientCard }[]) => r.map((x) => x.card.business_name);

describe("overdue age", () => {
  it("is 1 when on time, grows slowly, and is capped", () => {
    expect(ageFactor(0)).toBe(1);
    expect(ageFactor(-3)).toBe(1);
    expect(ageFactor(1)).toBeCloseTo(1 + 0.2 * Math.log(2), 6);
    expect(ageFactor(7)).toBeGreaterThan(ageFactor(1));
    expect(ageFactor(365)).toBe(1.6);
    expect(ageFactor(10_000)).toBe(1.6);
    let prev = 0;
    for (let d = 0; d < 200; d += 1) {
      expect(ageFactor(d)).toBeGreaterThanOrEqual(prev);
      prev = ageFactor(d);
    }
  });
  it("counts whole days past due, never negative, and copes with no date", () => {
    expect(daysOverdue(card({ next_due_on: "2026-10-20" }), TODAY)).toBe(3);
    expect(daysOverdue(card({ next_due_on: TODAY }), TODAY)).toBe(0);
    expect(daysOverdue(card({ next_due_on: "2026-10-30" }), TODAY)).toBe(0);
    expect(daysOverdue(card({ next_due_on: null }), TODAY)).toBe(0);
  });
});

describe("dollars at stake", () => {
  const stake = (over: Partial<ClientCard>) => priorityOf(card(over), CTX);

  it("counts what the merchant asked for", () => {
    const p = stake({ wanted_amount_cents: 5_000_000 });
    expect(p.atStakeCents).toBe(5_000_000);
    expect(p.basis).toBe("ask");
  });
  it("gives an unknown amount a floor instead of zero, and says so", () => {
    for (const wanted of [null, 0]) {
      const p = stake({ wanted_amount_cents: wanted });
      expect(p.atStakeCents).toBe(UNKNOWN_STAKE_CENTS);
      expect(p.basis).toBe("unknown");
      expect(p.explanation).toMatch(/no amount on file/i);
    }
  });
  it("a known amount counts as it is, even a small one", () => {
    expect(stake({ wanted_amount_cents: 200_000 }).atStakeCents).toBe(200_000);
  });
  it("caps one huge ask", () => {
    expect(stake({ wanted_amount_cents: 99_000_000_000 }).atStakeCents).toBe(STAKE_CAP_CENTS);
  });
});

describe("stage closeness", () => {
  const w = (stage: StageKey) => priorityOf(card({ stage }), CTX).stageWeight;

  it("application in beats following up, which beats trash", () => {
    expect(w("application_in")).toBeGreaterThan(w("interested"));
    expect(w("interested")).toBeGreaterThan(w("dead"));
  });
  it("a retired stage is weighed as the stage it folds into", () => {
    expect(w("name_in")).toBe(w("interested"));
    expect(w("stips")).toBe(w("application_in"));
    expect(w("not_interested")).toBe(w("dead"));
  });
  it("has a weight above 0 and at most 1 for every stage key", () => {
    for (const k of STAGE_KEYS) {
      expect(w(k)).toBeGreaterThan(0);
      expect(w(k)).toBeLessThanOrEqual(1);
    }
  });
  it("a merchant with the application in outranks one still being followed up, at the same ask", () => {
    const a = card({ business_name: "A", stage: "application_in", wanted_amount_cents: 5_000_000 });
    const b = card({ business_name: "B", stage: "interested", wanted_amount_cents: 5_000_000 });
    expect(rankCards([b, a], CTX).map((r) => r.card.business_name)).toEqual(["A", "B"]);
  });
});

describe("overdue age in the score", () => {
  it("the same deal scores higher the longer it waits, up to the cap", () => {
    const due = (d: string) =>
      score(card({ stage: "stips", wanted_amount_cents: 5_000_000, next_due_on: d }));
    expect(due("2026-10-22")).toBeGreaterThan(due(TODAY));
    expect(due("2026-10-10")).toBeGreaterThan(due("2026-10-22"));
    expect(due("2026-01-01")).toBe(due("2025-01-01"));
    expect(due("2026-01-01") / due(TODAY)).toBeCloseTo(1.6, 6);
  });
  it("age alone cannot lift a small deal over a much bigger one", () => {
    const small = card({
      business_name: "Small",
      wanted_amount_cents: 2_000_000,
      next_due_on: "2026-01-01",
    });
    const big = card({ business_name: "Big", wanted_amount_cents: 20_000_000 });
    expect(names(rankCards([small, big], CTX))).toEqual(["Big", "Small"]);
  });
  it("explains itself in plain words", () => {
    const p = priorityOf(
      card({ stage: "application_in", wanted_amount_cents: 8_000_000, next_due_on: "2026-10-20" }),
      CTX,
    );
    expect(p.explanation).toBe("$80k at stake (what they want). Application in, 3 days overdue.");
    expect(p.summary).toBe("Application in, 3 days overdue.");
    // no working: no weights, no score
    expect(p.explanation).not.toMatch(/ x [\d.]|priority|counts/);
    expect(priorityOf(card(), CTX).summary).toBe("Interested, due today.");
    expect(priorityOf(card({ next_due_on: null }), CTX).summary).toContain("no follow-up date");
    expect(priorityOf(card({ stage: "dead" }), CTX).summary).toBe("Not interested, due today.");
  });
});

describe("hot star override", () => {
  const big = card({
    business_name: "Big",
    stage: "contract_out",
    wanted_amount_cents: 20_000_000,
  });
  const tiny = card({ business_name: "Tiny", stage: "name_in", wanted_amount_cents: 100_000 });

  it("a starred client goes first no matter how small, in both orders", () => {
    const ctx = { ...CTX, hotIds: new Set([tiny.id]) };
    expect(names(rankCards([big, tiny], ctx, "biggest"))).toEqual(["Tiny", "Big"]);
    expect(names(rankCards([big, tiny], ctx, "oldest"))).toEqual(["Tiny", "Big"]);
    expect(priorityOf(tiny, ctx).hot).toBe(true);
    expect(priorityOf(tiny, ctx).explanation).toContain("Starred");
  });
  it("starred clients rank among themselves by score", () => {
    const ctx = { ...CTX, hotIds: new Set([big.id, tiny.id]) };
    expect(names(rankCards([tiny, big], ctx))).toEqual(["Big", "Tiny"]);
  });
  it("does not change the score itself, only the order", () => {
    expect(score(tiny, { ...CTX, hotIds: new Set([tiny.id]) })).toBe(score(tiny));
  });
});

describe("ordering is total and stable", () => {
  const a = card({ id: "a", business_name: "Alpha", wanted_amount_cents: 5_000_000 });
  const b = card({ id: "b", business_name: "Bravo", wanted_amount_cents: 5_000_000 });
  const c = card({ id: "c", business_name: "Charlie", wanted_amount_cents: 5_000_000 });

  it("equal scores fall back to the name", () => {
    expect(names(rankCards([c, a, b], CTX))).toEqual(["Alpha", "Bravo", "Charlie"]);
  });
  it("the same name falls back to the id", () => {
    const x = card({ id: "x2", business_name: "Same" });
    const y = card({ id: "x1", business_name: "Same" });
    expect(rankCards([x, y], CTX).map((r) => r.card.id)).toEqual(["x1", "x2"]);
  });
  it("on a tie the one that has waited longer goes first", () => {
    // Both are past the age cap, so their scores are equal.
    const older = card({
      id: "z",
      business_name: "Zed",
      next_due_on: "2025-01-01",
      wanted_amount_cents: 5_000_000,
    });
    const old = card({
      id: "y",
      business_name: "Aardvark",
      next_due_on: "2026-01-01",
      wanted_amount_cents: 5_000_000,
    });
    expect(score(older)).toBe(score(old));
    expect(names(rankCards([old, older], CTX))).toEqual(["Zed", "Aardvark"]);
  });
  it("gives the same order whatever order it was handed in", () => {
    const pool = [
      a,
      b,
      c,
      card({ business_name: "D", wanted_amount_cents: 9_000_000 }),
      card({ business_name: "E" }),
    ];
    const want = rankCards(pool, CTX).map((r) => r.card.id);
    for (const shuffled of [[...pool].reverse(), [pool[3], pool[0], pool[4], pool[2], pool[1]]]) {
      expect(rankCards(shuffled as ClientCard[], CTX).map((r) => r.card.id)).toEqual(want);
    }
  });
  it("does not mutate what it was given", () => {
    const input = [c, a, b];
    rankCards(input, CTX);
    expect(input.map((x) => x.business_name)).toEqual(["Charlie", "Alpha", "Bravo"]);
  });
  it("ignores floating-point noise in a comparison", () => {
    const [x, y] = rankCards([a, b], CTX);
    if (!x || !y) throw new Error("ranked");
    expect(compareBiggest(x, y)).toBeLessThan(0);
    expect(compareBiggest(x, x)).toBe(0);
  });
  it("oldest first puts the date first, then the bigger deal", () => {
    const older = card({
      business_name: "Older",
      next_due_on: "2026-10-01",
      wanted_amount_cents: 100_000,
      stage: "name_in",
    });
    const newerBig = card({
      business_name: "NewerBig",
      next_due_on: "2026-10-20",
      wanted_amount_cents: 9_000_000,
      stage: "contract_out",
    });
    const sameDayBig = card({
      business_name: "SameDayBig",
      next_due_on: "2026-10-01",
      wanted_amount_cents: 9_000_000,
      stage: "contract_out",
    });
    expect(names(rankCards([newerBig, older, sameDayBig], CTX, "oldest"))).toEqual([
      "SameDayBig",
      "Older",
      "NewerBig",
    ]);
    expect(names(rankCards([newerBig, older, sameDayBig], CTX, "biggest"))[0]).toBe("SameDayBig");
  });
  it("copes with no due date (last in oldest-first) and no amounts at all", () => {
    const none = card({ business_name: "NoDate", next_due_on: null });
    const dated = card({ business_name: "Dated", next_due_on: "2026-10-22" });
    expect(names(rankCards([none, dated], CTX, "oldest"))).toEqual(["Dated", "NoDate"]);
    expect(Number.isFinite(score(none))).toBe(true);
    expect(rankCards([], CTX)).toEqual([]);
  });
});

describe("spreading overdue work over business days", () => {
  it("knows weekends", () => {
    expect(isBusinessDay("2026-10-23")).toBe(true); // Friday
    expect(isBusinessDay("2026-10-24")).toBe(false);
    expect(isBusinessDay("2026-10-25")).toBe(false);
    expect(isBusinessDay("2026-10-26")).toBe(true);
  });
  it("counts today as day one on a business day, and skips the weekend", () => {
    expect(businessDaySlots("2026-10-23", 5)).toEqual([
      "2026-10-23",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
    ]);
  });
  it("starts on Monday when today is a weekend", () => {
    expect(businessDaySlots("2026-10-24", 2)).toEqual(["2026-10-26", "2026-10-27"]);
    expect(businessDaySlots("2026-10-25", 1)).toEqual(["2026-10-26"]);
  });
  it("rejects a day count that makes no sense", () => {
    for (const d of [0, -1, 1.5, Number.NaN]) {
      expect(() => businessDaySlots(TODAY, d)).toThrow(RangeError);
    }
  });

  const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);

  it("deals an even split, the remainder going to the earliest days", () => {
    const plan = planSpread(ids(12), TODAY, 5);
    expect(plan.perDay.map((d) => d.count)).toEqual([3, 3, 2, 2, 2]);
    expect(plan.perDay.map((d) => d.date)).toEqual(businessDaySlots(TODAY, 5));
    expect(plan.assignments).toHaveLength(12);
  });
  it("puts the first (biggest) clients on the earliest days and keeps their order", () => {
    const plan = planSpread(ids(10), TODAY, 5);
    expect(plan.assignments.map((a) => a.id)).toEqual(ids(10));
    const dates = plan.assignments.map((a) => a.dueOn);
    expect([...dates].sort()).toEqual(dates);
    expect(plan.assignments[0]).toEqual({ id: "c0", dueOn: TODAY });
    expect(plan.assignments[9]?.dueOn).toBe("2026-10-29");
  });
  it("with fewer clients than days it is one a day, not everyone today", () => {
    const plan = planSpread(ids(3), TODAY, 10);
    expect(plan.perDay).toEqual([
      { date: "2026-10-23", count: 1 },
      { date: "2026-10-26", count: 1 },
      { date: "2026-10-27", count: 1 },
    ]);
  });
  it("one day puts everyone on it; nobody means nothing to do", () => {
    expect(planSpread(ids(4), TODAY, 1).perDay).toEqual([{ date: TODAY, count: 4 }]);
    expect(planSpread([], TODAY, 5)).toEqual({ assignments: [], perDay: [] });
  });
  it("never lands anyone on a weekend or before today, whatever the size", () => {
    for (const today of ["2026-10-23", "2026-10-24", "2026-10-28"]) {
      for (const n of [1, 7, 41, 200]) {
        for (const days of [3, 5, 10, 20]) {
          const plan = planSpread(ids(n), today, days);
          expect(plan.assignments).toHaveLength(n);
          expect(plan.perDay.reduce((s, d) => s + d.count, 0)).toBe(n);
          for (const a of plan.assignments) {
            expect(isBusinessDay(a.dueOn)).toBe(true);
            expect(a.dueOn >= today).toBe(true);
          }
          const counts = plan.perDay.map((d) => d.count);
          expect(
            Math.max(...counts) - Math.min(...counts, Math.max(...counts)),
          ).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("snooze guard", () => {
  const APPLICATION_IN = STAGE_KEYS.filter((k) => stageDef(k).group === "application");

  it("covers the merchants whose application is in", () => {
    expect(APPLICATION_IN).toContain("application_in");
    expect(APPLICATION_IN).toContain("stips");
    expect(APPLICATION_IN).not.toContain("interested");
    expect(APPLICATION_IN).not.toContain("dead");
  });
  it("asks about a merchant pushed past a week", () => {
    for (const s of APPLICATION_IN) {
      expect(snoozeNeedsReason(s, TODAY, addDays(TODAY, 8))).toBe(true);
      expect(snoozeNeedsReason(s, TODAY, addDays(TODAY, 30))).toBe(true);
    }
  });
  it("does not ask for a week or less", () => {
    for (const s of APPLICATION_IN) {
      expect(snoozeNeedsReason(s, TODAY, addDays(TODAY, 1))).toBe(false);
      expect(snoozeNeedsReason(s, TODAY, addDays(TODAY, 7))).toBe(false);
    }
  });
  it("never asks about anything else", () => {
    for (const s of STAGE_KEYS.filter((k) => !APPLICATION_IN.includes(k))) {
      expect(snoozeNeedsReason(s, TODAY, addDays(TODAY, 365))).toBe(false);
    }
  });
});

describe("planBulk: who the bulk reschedule moves, and where", () => {
  const overdue = (name: string, over: Partial<ClientCard> = {}) =>
    card({ business_name: name, next_due_on: "2026-10-20", ...over });

  it("moves only overdue clients, biggest first, never do-not-contact", () => {
    const cards = [
      overdue("Small", { wanted_amount_cents: 1_000_000 }),
      overdue("Big", { wanted_amount_cents: 9_000_000 }),
      overdue("Silenced", { contact_status: "dnc", wanted_amount_cents: 99_000_000 }),
      card({ business_name: "Fine", next_due_on: TODAY }),
      card({ business_name: "Future", next_due_on: "2026-11-30" }),
    ];
    expect(
      overdueCards(cards, TODAY)
        .map((c) => c.business_name)
        .sort(),
    ).toEqual(["Big", "Small"]);
    const plan = planBulk(cards, CTX, { days: 5, keepApplicationIn: false });
    expect(plan.ordered.map((c) => c.business_name)).toEqual(["Big", "Small"]);
    expect(plan.assignments.map((a) => a.dueOn)).toEqual([TODAY, "2026-10-26"]);
  });
  it("keeps merchants whose application is in overdue when asked, and moves them when not", () => {
    const cards = [
      overdue("Contract", { stage: "application_in", wanted_amount_cents: 9_000_000 }),
      overdue("Stips", { stage: "stips" }),
      overdue("Interested"),
    ];
    const keep = planBulk(cards, CTX, { days: 5, keepApplicationIn: true });
    expect(keep.ordered.map((c) => c.business_name)).toEqual(["Interested"]);
    expect(keep.keptApplicationIn.map((c) => c.business_name).sort()).toEqual([
      "Contract",
      "Stips",
    ]);
    const all = planBulk(cards, CTX, { days: 5, keepApplicationIn: false });
    expect(all.ordered).toHaveLength(3);
    expect(all.ordered[0]?.business_name).toBe("Contract");
    expect(all.keptApplicationIn).toEqual([]);
  });
  it("leaves a passed booked call alone: moving the follow-up would not clear it", () => {
    const cards = [
      overdue("Ghost", { next_due_kind: "scheduled_call" }),
      overdue("Normal"),
      overdue("Hidden chase"),
    ];
    const plan = planBulk(cards, CTX, {
      days: 5,
      keepApplicationIn: false,
      blockedIds: new Set([cards[2]?.id ?? ""]),
    });
    expect(plan.ordered.map((c) => c.business_name)).toEqual(["Normal"]);
    expect(plan.needHands.map((c) => c.business_name).sort()).toEqual(["Ghost", "Hidden chase"]);
  });
  it("honours stars, and moves at most 200 in one go, highest priority first", () => {
    const many = Array.from({ length: 230 }, (_, i) =>
      overdue(`N${String(i).padStart(3, "0")}`, { wanted_amount_cents: 1_000_000 + i * 10_000 }),
    );
    const plan = planBulk(many, CTX, { days: 20, keepApplicationIn: false });
    expect(plan.ordered).toHaveLength(MAX_BULK);
    expect(plan.overCap).toBe(30);
    expect(plan.assignments).toHaveLength(MAX_BULK);
    expect(plan.ordered[0]?.business_name).toBe("N229");
    expect(plan.ordered.some((c) => c.business_name === "N000")).toBe(false);

    const smallest = many[0];
    if (!smallest) throw new Error("fixture");
    const starred = planBulk(
      many,
      { ...CTX, hotIds: new Set([smallest.id]) },
      { days: 20, keepApplicationIn: false },
    );
    expect(starred.ordered[0]?.business_name).toBe("N000");
  });
  it("is a no-op with nothing overdue", () => {
    const plan = planBulk([card()], CTX, { days: 5, keepApplicationIn: true });
    expect(plan.assignments).toEqual([]);
    expect(plan.perDay).toEqual([]);
  });
});
