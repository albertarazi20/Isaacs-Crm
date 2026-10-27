import { describe, expect, it } from "vitest";
import { addMonths, parseISODate } from "@/lib/mca/dates";
import type { FundingTerms } from "@/lib/mca/funding";
import {
  CORE_STAGES,
  defaultTimers,
  foldStage,
  isStageKey,
  STAGE_GROUPS,
  STAGE_KEYS,
  STAGES,
  stageDef,
} from "@/lib/mca/stages";

const TODAY = "2026-10-23";

describe("stage catalogue", () => {
  it("defines every stage key exactly once, in order", () => {
    expect(STAGES.map((s) => s.key)).toEqual([...STAGE_KEYS]);
  });
  it("puts every stage in a known group", () => {
    const groups = new Set(STAGE_GROUPS.map((g) => g.key));
    for (const s of STAGES) expect(groups.has(s.group)).toBe(true);
  });
  it("gives every stage a timer — no client ever goes dark", () => {
    for (const s of STAGES) {
      const timers = defaultTimers(s.key, { today: TODAY });
      expect(timers.length, s.key).toBeGreaterThan(0);
      for (const t of timers) {
        expect(t.dueOn > TODAY, `${s.key} must be in the future`).toBe(true);
        expect(t.dueOn <= addMonths(TODAY, 36), `${s.key} within 36 months`).toBe(true);
      }
    }
  });
  it("recognises stage keys", () => {
    expect(isStageKey("funded")).toBe(true);
    expect(isStageKey("closed_won")).toBe(false);
    expect(stageDef("lost").label).toBe("Lost / dead");
  });
});

describe("default timers", () => {
  const due = (stage: Parameters<typeof defaultTimers>[0]) =>
    defaultTimers(stage, { today: TODAY })[0]?.dueOn;

  it("keeps hot stages short and cold stages long", () => {
    // 2026-10-23 is a Friday: 1–3 day timers are BUSINESS days, so "tomorrow" is Monday.
    expect(due("name_in")).toBe("2026-10-26");
    expect(due("application_sent")).toBe("2026-10-28");
    expect(due("submitted")).toBe("2026-10-26");
    expect(due("default_workable")).toBe("2026-10-28");
    expect(due("default_bad")).toBe("2026-10-30");
    expect(due("paid_in_full")).toBe("2026-11-06");
    expect(due("declined")).toBe("2027-01-23");
    expect(due("killed")).toBe("2027-04-23");
    expect(due("dead")).toBe("2027-07-23");
    expect(due("not_interested")).toBe("2027-10-23");
    expect(due("written_off")).toBe("2027-10-23");
  });

  it("never lands a short timer on a weekend", () => {
    for (const today of ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]) {
      for (const stage of [
        "name_in",
        "spoke_with_owner",
        "application_sent",
        "submitted",
        "contract_out",
        "default_workable",
      ] as const) {
        const day = parseISODate(defaultTimers(stage, { today })[0]?.dueOn ?? today).getUTCDay();
        expect([0, 6], `${stage} from ${today}`).not.toContain(day);
      }
    }
  });

  it("sets two timers when funded: a 30-day check-in and the 50% renewal call", () => {
    const funding: FundingTerms = {
      fundedOn: "2026-10-23",
      amountCents: 5_000_000,
      factorRate: 1.32,
      paymentCents: 55_000,
      frequency: "daily",
    };
    const timers = defaultTimers("funded", { today: TODAY, funding });
    expect(timers.map((t) => t.kind)).toEqual(["check_in", "renewal"]);
    expect(timers[0]?.dueOn).toBe("2026-11-22");
    expect(timers[1]?.dueOn).toBe("2027-01-15");
  });

  it("still sets the check-in when funding terms are not entered yet", () => {
    expect(defaultTimers("funded", { today: TODAY }).map((t) => t.kind)).toEqual(["check_in"]);
  });

  it("times a lost deal off the competitor's term, else six months", () => {
    expect(defaultTimers("lost", { today: TODAY, competitorTermDays: 180 })[0]?.dueOn).toBe(
      "2027-01-21",
    );
    expect(defaultTimers("lost", { today: TODAY })[0]?.dueOn).toBe("2027-04-23");
  });

  it("folds retired stages into the short list, and every fold target is on it", () => {
    expect(foldStage("spoke_with_owner")).toBe("interested");
    expect(foldStage("call_scheduled")).toBe("interested");
    expect(foldStage("funded")).toBe("funded");
    const core = new Set(CORE_STAGES.map((s) => s.key));
    for (const k of STAGE_KEYS) expect(core.has(foldStage(k))).toBe(true);
    expect(core.has("spoke_with_owner")).toBe(false);
    expect(CORE_STAGES.length).toBeLessThanOrEqual(12);
  });
});
