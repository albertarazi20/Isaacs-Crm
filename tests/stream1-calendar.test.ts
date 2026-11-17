import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBucketSteps } from "@/lib/buckets/engine";
import { enqueueEmail } from "@/lib/send/enqueue";
import { inSendWindow, nextSendTime, usFederalHoliday, usFederalHolidays } from "@/lib/send/rules";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Stream 1: S1-11 holidays in the send window (send_on_holidays, off by default) and S1-14 the Cold bucket (it keeps
 * no email steps: a Cold member stays put and the engine sends it nothing).
 */

let t: TestDb;
let rep: string;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  await t.pool.query(
    "update app_users set application_link = 'https://apply.test/x', name = 'Sam Rep' where id = $1",
    [rep],
  );
  await t.pool.query("update shop_settings set postal_address = '1 Main St'");
});
afterAll(async () => {
  await t.drop();
});

describe("S1-11: US federal holidays", () => {
  it("the calendar, as observed", () => {
    expect(usFederalHoliday("2026-11-26")).toBe("Thanksgiving");
    expect(usFederalHoliday("2026-11-27")).toBeNull();
    expect(usFederalHoliday("2026-07-03")).toBe("Independence Day"); // July 4 2026 is a Saturday
    expect(usFederalHoliday("2026-07-04")).toBeNull();
    expect(usFederalHoliday("2027-12-24")).toBe("Christmas Day"); // Dec 25 2027 is a Saturday
    expect(usFederalHoliday("2027-12-31")).toBe("New Year's Day"); // Jan 1 2028 is a Saturday
    expect(usFederalHoliday("2026-01-19")).toBe("Martin Luther King Jr. Day");
    expect(usFederalHoliday("2026-05-25")).toBe("Memorial Day");
    expect(usFederalHoliday("2026-09-07")).toBe("Labor Day");
    expect(usFederalHoliday("2026-10-12")).toBe("Columbus Day");
    expect(usFederalHoliday("2026-06-19")).toBe("Juneteenth");
    expect(usFederalHoliday("2026-11-11")).toBe("Veterans Day");
    expect(usFederalHoliday("2026-02-16")).toBe("Presidents' Day");
    expect(usFederalHolidays(2026).size).toBe(11);
  });

  it("the window is closed on a holiday unless the shop sends on them", () => {
    const w = { timezone: "America/New_York", startHour: 9, endHour: 11, weekends: false };
    const thanksgiving = new Date("2026-11-26T15:00:00Z"); // 10:00 ET, a Thursday
    expect(inSendWindow(thanksgiving, w)).toBe(false);
    expect(inSendWindow(thanksgiving, { ...w, holidays: true })).toBe(true);
    // from Wednesday evening: Friday 9:00 ET, not Thursday
    const from = new Date("2026-11-25T23:00:00Z");
    expect(nextSendTime(from, w, 0).toISOString()).toBe("2026-11-27T14:00:00.000Z");
    expect(nextSendTime(from, { ...w, holidays: true }, 0).toISOString()).toBe(
      "2026-11-26T14:00:00.000Z",
    );
  });

  it("enqueue reads the setting: a sequence email queued on Thanksgiving morning waits for Friday until the shop says otherwise", async () => {
    const id = (
      await t.pool.query<{ id: string }>(
        "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Holiday Co', 'Owner', '3055550100', 'holiday@x.com', 'FL') returning id",
        [rep],
      )
    ).rows[0]!.id;
    const at = new Date("2026-11-26T14:30:00Z"); // 9:30 ET on Thanksgiving
    const queued = () =>
      t.db.withUser(rep, async (q) => {
        const r = await enqueueEmail(
          q,
          { clientId: id, lane: "sequence", source: "bucket:x:step:1", subject: "s", text: "t" },
          at,
        );
        if (!r.queued) throw new Error("not queued");
        return r.notBefore;
      });
    expect((await queued()).slice(0, 10)).toBe("2026-11-27");
    await t.pool.query("update shop_settings set send_on_holidays = true");
    expect(await queued()).toBe("2026-11-26T14:30:00.000Z");
    await t.pool.query("update shop_settings set send_on_holidays = false");
  });
});

describe("S1-14: the Cold bucket", () => {
  it("the Cold bucket has no email steps; a Cold member stays put and the engine sends it nothing", async () => {
    const steps = await t.pool.query<{ action: string }>(
      "select s.action from bucket_steps s join buckets b on b.id = s.bucket_id where b.key = 'cold'",
    );
    expect(steps.rows).toEqual([]);
    const id = (
      await t.pool.query<{ id: string }>(
        "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Cold Co', 'Owner', '3055550101', 'cold@x.com', 'FL') returning id",
        [rep],
      )
    ).rows[0]!.id;
    const cold = (await t.pool.query<{ id: string }>("select id from buckets where key = 'cold'"))
      .rows[0]!.id;
    await t.pool.query("select enroll_in_bucket($1, $2, 'sequence_done')", [id, cold]);
    const today = t.today;
    const day = (n: number) => new Date(`${today}T16:00:00Z`).getTime() + n * 86_400_000;
    const emails = async () =>
      (
        await t.pool.query<{ source: string }>(
          "select source from outbox where client_id = $1 and status <> 'cancelled' order by created_at",
          [id],
        )
      ).rows.map((r) => r.source);

    // ninety days of the bucket engine: nothing from the bucket, and the merchant is still in Cold
    for (const n of [0, 1, 30, 31, 60, 61, 90])
      await runBucketSteps({ db: t.db, now: new Date(day(n)), appUrl: "https://crm.test" });
    expect(await emails()).toEqual([]);
    const live = await t.pool.query<{ key: string; next_due_on: string | null }>(
      "select b.key, e.next_due_on::text from enrollments e join buckets b on b.id = e.bucket_id where e.client_id = $1 and e.stopped_at is null",
      [id],
    );
    expect(live.rows).toEqual([{ key: "cold", next_due_on: null }]);
  });
});
