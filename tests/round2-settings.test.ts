import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shopSchema } from "@/lib/settings/schemas";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
const form = {
  shopName: "Selective Capital",
  postalAddress: "1 Main St, Miami FL 33101",
  dailyCap: 1500,
  amberAt: 1200,
  reservedForIntake: 150,
  sequencesEnabled: true,
  sendWindowStart: 9,
  sendWindowEnd: 11,
  sendOnWeekends: false,
  perMerchantDaily: 1,
  perMerchantWeekly: 3,
  automationFrom: "",
  automationReplyToRep: true,
};
const issues = (over: Record<string, unknown>) => {
  const r = shopSchema.safeParse({ ...form, ...over });
  return r.success
    ? []
    : r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
};

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

describe("the shop form reports a bad combination before the database check fires", () => {
  it.each([
    [{ sendWindowStart: 17, sendWindowEnd: 9 }, "sendWindowEnd", /end after it starts/],
    [{ sendWindowStart: 10, sendWindowEnd: 10 }, "sendWindowEnd", /end after it starts/],
    [
      { dailyCap: 100, amberAt: 50, reservedForIntake: 100 },
      "reservedForIntake",
      /smaller than the daily cap/,
    ],
    [{ dailyCap: 1000, amberAt: 1001 }, "amberAt", /can't be above the daily cap/],
    [{ perMerchantDaily: 4, perMerchantWeekly: 3 }, "perMerchantWeekly", /weekly limit/],
  ])("%j", (over, path, message) => {
    const found = issues(over);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe(path);
    expect(found[0]?.message).toMatch(message);
  });

  it("agrees with the database check on the boundary values (0563_send_settings_checks.sql)", async () => {
    const cases: [Record<string, unknown>, Record<string, number>, boolean][] = [
      [
        { sendWindowStart: 9, sendWindowEnd: 10 },
        { send_window_start: 9, send_window_end: 10 },
        true,
      ],
      [
        { sendWindowStart: 10, sendWindowEnd: 10 },
        { send_window_start: 10, send_window_end: 10 },
        false,
      ],
      [
        { dailyCap: 100, reservedForIntake: 99, amberAt: 100 },
        { daily_cap: 100, reserved_for_intake: 99, amber_at: 100 },
        true,
      ],
      [
        { dailyCap: 100, reservedForIntake: 100, amberAt: 50 },
        { daily_cap: 100, reserved_for_intake: 100, amber_at: 50 },
        false,
      ],
      [
        { dailyCap: 100, amberAt: 101, reservedForIntake: 10 },
        { daily_cap: 100, amber_at: 101, reserved_for_intake: 10 },
        false,
      ],
    ];
    for (const [formOver, cols, ok] of cases) {
      expect(issues(formOver).length === 0, JSON.stringify(formOver)).toBe(ok);
      const sets = Object.keys(cols).map((c, i) => `${c} = $${i + 1}`);
      const run = t.pool.query(`update shop_settings set ${sets.join(", ")}`, Object.values(cols));
      if (ok) await run;
      else await expect(run).rejects.toThrow(/check constraint/);
    }
  });
});
