import { describe, expect, it } from "vitest";
import {
  buildDeathPoints,
  buildDiscipline,
  buildFunnel,
  buildSources,
  buildSpeed,
  furthestRank,
  NO_SOURCE,
  type ReportClient,
  type TimerHistory,
} from "@/lib/reports/report";

let n = 0;
const client = (over: Partial<ReportClient> = {}): ReportClient => ({
  id: `c${(n += 1)}`,
  source: "Referral",
  stage: "name_in",
  createdAt: "2026-09-01T12:00:00Z",
  reached: {},
  fundedCents: 0,
  advances: 0,
  ...over,
});

describe("furthestRank", () => {
  it("counts the current stage and every stage ever visited", () => {
    expect(furthestRank(client({ stage: "interested" }))).toBe(2);
    expect(
      furthestRank(client({ stage: "lost", reached: { offers_in: "2026-09-10T00:00:00Z" } })),
    ).toBe(7);
  });
  it("an exit stage alone says nothing about how far the deal got", () => {
    expect(furthestRank(client({ stage: "dead" }))).toBe(0);
    expect(furthestRank(client({ stage: "not_interested" }))).toBe(0);
  });
  it("anything after Funded counts as funded — the merchant got the money", () => {
    for (const stage of [
      "funded",
      "paying_off_soon",
      "paid_in_full",
      "default_bad",
      "written_off",
    ] as const)
      expect(furthestRank(client({ stage }))).toBe(10);
  });
  it("a merchant who was funded and later defaulted is still funded", () => {
    expect(
      furthestRank(
        client({ stage: "default_workable", reached: { funded: "2026-09-20T00:00:00Z" } }),
      ),
    ).toBe(10);
  });
});

describe("buildFunnel", () => {
  it("is empty-safe", () => {
    const f = buildFunnel([]);
    expect(f.every((r) => r.count === 0 && r.ofAdded === 0)).toBe(true);
    expect(f[0]?.ofPrevious).toBeNull();
  });
  it("counts each merchant once at every step they reached, with conversion shares", () => {
    const f = buildFunnel([
      client({ stage: "name_in" }),
      client({ stage: "interested" }),
      client({ stage: "application_in" }),
      client({ stage: "submitted" }),
      client({ stage: "funded" }),
      client({ stage: "lost", reached: { submitted: "2026-09-05T00:00:00Z" } }),
    ]);
    const by = Object.fromEntries(f.map((r) => [r.key, r]));
    expect(by.added?.count).toBe(6);
    expect(by.interested?.count).toBe(5);
    expect(by.application?.count).toBe(4);
    expect(by.submitted?.count).toBe(3);
    expect(by.funded?.count).toBe(1);
    expect(by.submitted?.ofAdded).toBe(50);
    expect(by.submitted?.ofPrevious).toBe(75);
    expect(by.funded?.ofPrevious).toBe(100);
  });
  it("counts never go up as the steps go on", () => {
    const f = buildFunnel(
      ["name_in", "spoke_with_owner", "stips", "offers_in", "contract_out", "funded", "dead"].map(
        (stage) => client({ stage: stage as ReportClient["stage"] }),
      ),
    );
    for (let i = 1; i < f.length; i += 1) expect(f[i]!.count).toBeLessThanOrEqual(f[i - 1]!.count);
  });
});

describe("buildDeathPoints", () => {
  it("says where ended deals got to, in funnel order, and ignores live deals", () => {
    const d = buildDeathPoints([
      client({ stage: "dead" }),
      client({ stage: "not_interested", reached: { spoke_with_owner: "2026-09-02T00:00:00Z" } }),
      client({ stage: "lost", reached: { offers_in: "2026-09-02T00:00:00Z" } }),
      client({ stage: "declined", reached: { submitted: "2026-09-02T00:00:00Z" } }),
      client({ stage: "lost", reached: { offer_presented: "2026-09-02T00:00:00Z" } }),
      client({ stage: "interested" }),
    ]);
    expect(d).toEqual([
      { label: "Never reached the owner", count: 1 },
      { label: "After Spoke with owner", count: 1 },
      { label: "After Submitted to funders", count: 1 },
      { label: "After Offers in", count: 2 },
    ]);
  });
});

describe("buildSpeed", () => {
  const funded = (createdAt: string, interested: string, app: string, fundedAt: string) =>
    client({
      createdAt,
      stage: "funded",
      reached: { interested, application_in: app, funded: fundedAt },
    });
  it("reports medians once there are three merchants to compare", () => {
    const rows = buildSpeed([
      funded(
        "2026-09-01T00:00:00Z",
        "2026-09-02T00:00:00Z",
        "2026-09-04T00:00:00Z",
        "2026-09-10T00:00:00Z",
      ),
      funded(
        "2026-09-01T00:00:00Z",
        "2026-09-03T00:00:00Z",
        "2026-09-05T00:00:00Z",
        "2026-09-15T00:00:00Z",
      ),
      funded(
        "2026-09-01T00:00:00Z",
        "2026-09-04T00:00:00Z",
        "2026-09-06T00:00:00Z",
        "2026-09-26T00:00:00Z",
      ),
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by["Added → Interested"]).toMatchObject({ medianDays: 2, n: 3 });
    expect(by["Added → Application in"]).toMatchObject({ medianDays: 4, n: 3 });
    expect(by["Application in → Funded"]).toMatchObject({ medianDays: 10, n: 3 });
    expect(by["Added → Funded"]).toMatchObject({ medianDays: 14, n: 3 });
  });
  it("won't give a number from fewer than three merchants", () => {
    const rows = buildSpeed([
      funded(
        "2026-09-01T00:00:00Z",
        "2026-09-02T00:00:00Z",
        "2026-09-04T00:00:00Z",
        "2026-09-10T00:00:00Z",
      ),
    ]);
    expect(rows.every((r) => r.medianDays === null)).toBe(true);
    expect(rows[0]?.n).toBe(1);
  });
  it("an even count takes the middle pair's average", () => {
    const mk = (d: number) =>
      client({
        createdAt: "2026-09-01T00:00:00Z",
        reached: { interested: new Date(Date.UTC(2026, 8, 1 + d)).toISOString() },
      });
    const row = buildSpeed([mk(1), mk(2), mk(3), mk(10)]).find(
      (r) => r.label === "Added → Interested",
    );
    expect(row?.medianDays).toBe(2.5);
  });
  it("ignores a merchant whose history runs backwards", () => {
    const row = buildSpeed([
      client({
        createdAt: "2026-09-10T00:00:00Z",
        reached: { interested: "2026-09-01T00:00:00Z" },
      }),
    ]).find((r) => r.label === "Added → Interested");
    expect(row?.n).toBe(0);
  });
});

describe("buildSources", () => {
  it("groups 'Referral', ' referral ' and 'REFERRAL' as one source", () => {
    const s = buildSources([
      client({ source: "Referral" }),
      client({ source: " referral " }),
      client({ source: "Referral" }),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ source: "Referral", added: 3 });
  });
  it("shows blank sources honestly and ranks by funded dollars, then volume", () => {
    const s = buildSources([
      client({ source: "" }),
      client({ source: "Lead list A" }),
      client({ source: "Lead list A" }),
      client({ source: "Referral", stage: "funded", fundedCents: 5_000_000, advances: 1 }),
    ]);
    expect(s.map((r) => r.source)).toEqual(["Referral", "Lead list A", NO_SOURCE]);
    expect(s[0]).toMatchObject({ funded: 1, fundedCents: 5_000_000, rate: 100, small: true });
  });
  it("flags a small sample and not a big one", () => {
    const five = Array.from({ length: 5 }, () => client({ source: "Big" }));
    expect(buildSources(five)[0]?.small).toBe(false);
    expect(buildSources(five.slice(0, 4))[0]?.small).toBe(true);
  });
});

describe("buildDiscipline", () => {
  const today = "2026-10-23";
  const t = (
    dueOn: string,
    doneOn: string | null,
    doneReason: TimerHistory["doneReason"],
  ): TimerHistory => ({
    dueOn,
    doneOn,
    doneReason,
  });
  it("is null when nothing has come due", () => {
    expect(buildDiscipline([], today).onTimeRate).toBeNull();
    expect(buildDiscipline([t("2026-10-30", null, null)], today)).toMatchObject({
      total: 0,
      onTimeRate: null,
    });
  });
  it("splits handled-on-time, handled-late, pushed back and still-overdue", () => {
    const d = buildDiscipline(
      [
        t("2026-10-20", "2026-10-20", "completed"),
        t("2026-10-20", "2026-10-19", "completed"),
        t("2026-10-20", "2026-10-22", "completed"),
        t("2026-10-18", "2026-10-18", "replaced"),
        t("2026-10-15", null, null),
      ],
      today,
    );
    expect(d).toEqual({ total: 5, onTime: 2, late: 1, pushed: 1, overdue: 1, onTimeRate: 40 });
  });
  it("a stage move on or before the due day counts as handled on time", () => {
    const d = buildDiscipline(
      [t("2026-10-20", "2026-10-20", "stage_moved"), t("2026-10-20", "2026-10-25", "stage_moved")],
      today,
    );
    expect(d).toMatchObject({ onTime: 1, late: 1 });
  });
  it("leaves out today's open timers, future ones and ones cancelled on purpose", () => {
    const d = buildDiscipline(
      [
        t("2026-10-23", null, null),
        t("2026-10-24", null, null),
        t("2026-10-10", "2026-10-11", "cancelled"),
      ],
      today,
    );
    expect(d.total).toBe(0);
  });
});
