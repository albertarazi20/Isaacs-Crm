import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dueCount } from "@/lib/data/queries";
import * as m from "@/lib/data/mutations";
import { newClientSchema } from "@/lib/data/schemas";
import { runCallReminders, runReminders, type DigestSender } from "@/lib/system/reminders";
import { runWeeklyScorecards } from "@/lib/system/weekly";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "UTC");
});
afterAll(async () => {
  await t.drop();
});

type Q = Parameters<Parameters<typeof t.db.withUser>[1]>[0];
const asA = <T>(fn: (q: Q) => Promise<T>) => t.db.withUser(a, fn);
const ctx = () => ({ today: t.today, timezone: "UTC" });
const ok = () =>
  vi.fn(async () => "resend_1") as unknown as DigestSender & ReturnType<typeof vi.fn>;
const MORNING = () => new Date(`${t.today}T13:00:00Z`);

describe("B-1: a do-not-contact merchant is never a call to make, whatever their timer says", () => {
  it("is left out of the morning email, the booked-call email and the Today badge", async () => {
    const id = await insertClient(t.db, a, "Stop Pizza", t.today);
    await asA((q) => m.setContactStatus(q, { clientId: id, status: "dnc", note: "asked to stop" }));
    // A later drag / "set follow-up" gives them a timer due today — the status must still win.
    await t.pool.query(
      "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'follow_up', current_date)",
      [a, id],
    );
    await insertClient(t.db, a, "Live Pizza", t.today);
    const digest = ok();
    await runReminders({ db: t.db, now: MORNING(), appUrl: "https://app.test", send: digest });
    const body: string = digest.mock.calls[0]?.[1]?.text ?? "";
    expect(body).toContain("Live Pizza");
    expect(body).not.toContain("Stop Pizza");
    expect(await asA((q) => dueCount(q, t.today))).toBe(1); // Live Pizza only

    await t.pool.query(
      "update clients set scheduled_call_at = now() + interval '60 minutes' where id = $1",
      [id],
    );
    const calls = ok();
    const summary = await runCallReminders({
      db: t.db,
      now: new Date(),
      appUrl: "https://app.test",
      send: calls,
    });
    expect(summary.sent).toBe(0);
    expect(calls).not.toHaveBeenCalled();
  });
  it("a merchant limited only to 'no text' still gets the reminders (they can still be called)", async () => {
    const id = await insertClient(t.db, a, "No Text Diner", t.today);
    await asA((q) => m.setContactStatus(q, { clientId: id, status: "no_text", note: "" }));
    await t.pool.query("delete from reminders_sent");
    const digest = ok();
    await runReminders({ db: t.db, now: MORNING(), appUrl: "https://app.test", send: digest });
    expect(digest.mock.calls[0]?.[1]?.text).toContain("No Text Diner");
  });
});

describe("B-2: taking someone off ALLOWED_EMAILS stops their email too", () => {
  const allowed = (list: string[]) => (email: string) => list.includes(email);
  it("the morning email and the booked-call email are skipped for a user who isn't allowed", async () => {
    await t.pool.query("delete from reminders_sent");
    const c = await insertClient(t.db, a, "Call Pizza", t.today);
    await t.pool.query(
      "update clients set scheduled_call_at = now() + interval '45 minutes' where id = $1",
      [c],
    );
    const send = ok();
    const d = await runReminders({
      db: t.db,
      now: MORNING(),
      appUrl: "https://app.test",
      send,
      allowed: allowed([]),
    });
    const k = await runCallReminders({
      db: t.db,
      now: new Date(),
      appUrl: "https://app.test",
      send,
      allowed: allowed([]),
    });
    expect(d).toMatchObject({ sent: 0, skipped: 1 });
    expect(k.sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
  it("and sent again once they are on the list", async () => {
    const send = ok();
    const d = await runReminders({
      db: t.db,
      now: MORNING(),
      appUrl: "https://app.test",
      send,
      allowed: allowed(["isaac@x.com"]),
    });
    expect(d.sent).toBe(1);
    const k = await runCallReminders({
      db: t.db,
      now: new Date(),
      appUrl: "https://app.test",
      send,
      allowed: allowed(["isaac@x.com"]),
    });
    expect(k.sent).toBe(1);
  });
  it("the Monday scorecard too", async () => {
    const monday = new Date("2026-10-26T16:00:00Z");
    const send = ok();
    const blocked = await runWeeklyScorecards({
      db: t.db,
      now: monday,
      appUrl: "https://app.test",
      send,
      allowed: allowed([]),
    });
    expect(blocked).toMatchObject({ sent: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    const open = await runWeeklyScorecards({
      db: t.db,
      now: monday,
      appUrl: "https://app.test",
      send,
      allowed: allowed(["isaac@x.com"]),
    });
    expect(open.sent).toBe(1);
  });
  it("with no predicate, everyone is served (how the unit tests and the dev server run)", async () => {
    await t.pool.query("delete from reminders_sent");
    const send = ok();
    expect(
      (await runReminders({ db: t.db, now: MORNING(), appUrl: "https://app.test", send })).sent,
    ).toBe(1);
    void newClientSchema;
    void ctx;
  });
});
