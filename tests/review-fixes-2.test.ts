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

describe("B-4: 'reschedule all overdue' keeps each follow-up's reason", () => {
  it("carries the old note forward and only fills in a blank one", async () => {
    const { bulkReschedule, followUpReasons } = await import("@/lib/data/overdue");
    const b = await insertUser(t.pool, "bulk@x.com", "UTC");
    const withNote = await insertClient(t.db, b, "Reason Co", t.today);
    const blank = await insertClient(t.db, b, "Blank Co", t.today);
    await t.pool.query(
      "update timers set due_on = current_date - 3, note = 'Call after his tax return is filed' where client_id = $1 and done_at is null",
      [withNote],
    );
    await t.pool.query(
      "update timers set due_on = current_date - 2, note = '' where client_id = $1 and done_at is null",
      [blank],
    );
    await t.db.withUser(b, (q) => bulkReschedule(q, ctx(), { days: 5, keepUnderwriting: false }));
    const reasons = await t.db.withUser(b, (q) => followUpReasons(q, [withNote, blank]));
    expect(reasons[withNote]?.note).toBe("Call after his tax return is filed");
    expect(reasons[blank]?.note).toBe("Rescheduled in bulk");
    const moved = await t.pool.query(
      "select count(*)::int n from timers where client_id = any($1) and done_at is null and due_on > current_date - 1",
      [[withNote, blank]],
    );
    expect(moved.rows[0].n).toBe(2);
  });
});

describe("B-5: setting a merchant back from do-not-contact brings them back on purpose", () => {
  const open = async (id: string) =>
    (
      await t.pool.query(
        "select kind, due_on::text, note from timers where client_id = $1 and done_at is null",
        [id],
      )
    ).rows;
  it("replaces the 36-month review timer with a follow-up a week out", async () => {
    const { addDays } = await import("@/lib/mca/dates");
    const id = await insertClient(t.db, a, "Stop Then Go Pizza", t.today);
    await asA((q) => m.setContactStatus(q, { clientId: id, status: "dnc", note: "asked to stop" }));
    expect((await open(id)).map((x) => x.note)).toEqual(["Do-not-contact — review this status"]);
    await asA((q) =>
      m.setContactStatus(q, { clientId: id, status: "ok", note: "called back, wants funding" }),
    );
    expect(await open(id)).toEqual([
      {
        kind: "follow_up",
        due_on: addDays(t.today, 7),
        note: "Contact allowed again — pick the next step",
      },
    ]);
  });
  it("a limit like 'no text' keeps the timers alone, and moving between limits adds nothing", async () => {
    const id = await insertClient(t.db, a, "Limit Pizza", t.today);
    const before = await open(id);
    await asA((q) => m.setContactStatus(q, { clientId: id, status: "no_text", note: "" }));
    await asA((q) => m.setContactStatus(q, { clientId: id, status: "no_email", note: "" }));
    expect(await open(id)).toEqual(before);
  });
  it("dnc → a limit also brings them back (they can be called again)", async () => {
    const id = await insertClient(t.db, a, "Stop To Limit Pizza", t.today);
    await asA((q) => m.setContactStatus(q, { clientId: id, status: "dnc", note: "" }));
    await asA((q) => m.setContactStatus(q, { clientId: id, status: "no_text", note: "" }));
    expect((await open(id)).map((x) => x.note)).toEqual([
      "Contact allowed again — pick the next step",
    ]);
  });
});
