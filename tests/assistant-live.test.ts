import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepBrief } from "@/lib/brain/briefs";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The assistant against the REAL model. Costs a few cents, so it only runs when asked:
 *   LIVE_AI=1 ANTHROPIC_API_KEY=… pnpm vitest run tests/assistant-live.test.ts
 * Proves the request the CRM sends is accepted by the model the shop chose, that it reads the merchant through its
 * tools, and that a preparation ends with a saved answer and buttons.
 */
const live = process.env.LIVE_AI === "1" && Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!live)("the assistant on the real model", () => {
  let t: TestDb;
  let rita: string;
  let merchant: string;

  beforeAll(async () => {
    t = await createTestDb();
    const url = new URL(
      (t.pool as unknown as { options: { connectionString: string } }).options.connectionString,
    );
    process.env.DATABASE_URL = url.toString();
    rita = await insertUser(t.pool, "rita@x.com");
    await t.pool.query("update app_users set name = 'Rita Rep' where id = $1", [rita]);
    await t.pool.query(
      "update shop_settings set ai_enabled = true, ai_daily_cap_cents = 500, brain_on = true",
    );
    const bucket = (await t.pool.query("select id from buckets where key = 'missing_statements'"))
      .rows[0].id;
    merchant = (
      await t.pool.query(
        "insert into clients (user_id, business_name, contact_name, phone, email, state, created_at) values ($1, 'Harbor Tacos', 'Rosa Diaz', '3105550199', 'rosa@harbortacos.com', 'CA', now() - interval '10 days') returning id",
        [rita],
      )
    ).rows[0].id;
    await t.pool.query("select enroll_in_bucket($1, $2)", [merchant, bucket]);
    await t.pool.query(
      "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'follow_up', $3::date)",
      [rita, merchant, addDays(t.today, -3)],
    );
  });
  afterAll(async () => {
    const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
    await g.__isaacPool?.end();
    await t.drop();
  });

  it("prepares the next step for an overdue merchant", async () => {
    const { anthropicCaller } = await import("@/lib/assistant/run");
    const { runBrain } = await import("@/lib/system/brain");
    const { db } = await import("@/lib/db");
    const r = await runBrain({ db, keySet: true, caller: anthropicCaller(), budgetMs: 55_000 });
    expect(r.skipped).toBeUndefined();
    expect(r.failed).toBe(0);
    expect(r.prepared).toBeGreaterThanOrEqual(1);
    const prep = (
      await t.pool.query("select summary, actions, status from brain_preps where client_id = $1", [
        merchant,
      ])
    ).rows[0];
    expect(prep.status).toBe("ready");
    expect(prep.summary.length).toBeGreaterThan(20);
    console.log("LIVE SUMMARY:", prep.summary, "| buttons:", prep.actions);
    expect(prepBrief("overdue", merchant)).toContain(merchant);
  }, 120_000);
});
