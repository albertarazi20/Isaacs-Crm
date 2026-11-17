import { describe, expect, it } from "vitest";
import { addMonths, parseISODate } from "@/lib/mca/dates";
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
  it("works three stages: Interested, Application in and Not interested", () => {
    expect(STAGES.map((s) => s.key)).toEqual(["interested", "application_in", "dead"]);
    expect(CORE_STAGES.map((s) => s.label)).toEqual([
      "Interested",
      "Application in",
      "Not interested",
    ]);
  });
  it("puts every stage in a known group", () => {
    const groups = new Set(STAGE_GROUPS.map((g) => g.key));
    for (const s of STAGES) expect(groups.has(s.group)).toBe(true);
  });
  it("gives every stage a timer — no client ever goes dark", () => {
    for (const key of STAGE_KEYS) {
      const timers = defaultTimers(key, { today: TODAY });
      expect(timers.length, key).toBe(1);
      for (const t of timers) {
        expect(t.kind).toBe("follow_up");
        expect(t.dueOn > TODAY, `${key} must be in the future`).toBe(true);
        expect(t.dueOn <= addMonths(TODAY, 36), `${key} within 36 months`).toBe(true);
      }
    }
  });
  it("recognises the database's stage keys", () => {
    expect(isStageKey("funded")).toBe(true);
    expect(isStageKey("closed_won")).toBe(false);
  });
});

describe("default timers", () => {
  const due = (stage: Parameters<typeof defaultTimers>[0]) =>
    defaultTimers(stage, { today: TODAY })[0]?.dueOn;

  it("keeps the working stages short and trash long", () => {
    // 2026-10-23 is a Friday: 1–3 day timers are BUSINESS days, so "tomorrow" is Monday.
    expect(due("interested")).toBe("2026-10-27");
    expect(due("application_in")).toBe("2026-10-26");
    expect(due("dead")).toBe("2027-07-23");
  });

  it("never lands a short timer on a weekend", () => {
    for (const today of ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]) {
      for (const stage of ["name_in", "spoke_with_owner", "application_sent", "stips"] as const) {
        const day = parseISODate(defaultTimers(stage, { today })[0]?.dueOn ?? today).getUTCDay();
        expect([0, 6], `${stage} from ${today}`).not.toContain(day);
      }
    }
  });

  it("folds every other database stage into one of the three, and every fold target is worked", () => {
    const worked = new Set(CORE_STAGES.map((s) => s.key));
    for (const k of STAGE_KEYS) expect(worked.has(foldStage(k)), k).toBe(true);
    expect(foldStage("spoke_with_owner")).toBe("interested");
    expect(foldStage("call_scheduled")).toBe("interested");
    expect(foldStage("name_in")).toBe("interested");
    expect(foldStage("stips")).toBe("application_in");
    expect(foldStage("funded")).toBe("application_in");
    expect(foldStage("killed")).toBe("dead");
    expect(foldStage("not_interested")).toBe("dead");
    expect(foldStage("declined")).toBe("dead");
    expect(foldStage("lost")).toBe("dead");
    expect(stageDef("name_in").label).toBe("Interested");
    expect(stageDef("funded").label).toBe("Application in");
  });
});
