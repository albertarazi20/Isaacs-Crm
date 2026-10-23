import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runReminders, type DigestSender } from "@/lib/system/reminders";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let ny: string;
let la: string;
let off: string;

// 13:00 UTC = 09:00 in New York (EDT), 06:00 in Los Angeles (PDT).
const MORNING = new Date("2026-10-23T13:00:00Z");

async function seed(userId: string, name: string, dueOn: string, kind = "follow_up", extra = "") {
  const { rows } = await t.pool.query<{ id: string }>(
    "insert into clients (user_id, business_name, contact_name, phone) values ($1, $2, 'Owner', '5551234567') returning id",
    [userId, name],
  );
  const id = rows[0]?.id;
  await t.pool.query(
    "insert into timers (user_id, client_id, kind, due_on, note) values ($1, $2, $3, $4, $5)",
    [userId, id, kind, dueOn, extra],
  );
  return id;
}
const sentRows = async () =>
  (
    await t.pool.query(
      "select user_id, for_date::text, provider_id from reminders_sent order by sent_at",
    )
  ).rows;
const ok = (): DigestSender & ReturnType<typeof vi.fn> => vi.fn(async () => "resend_123") as never;

beforeAll(async () => {
  t = await createTestDb();
  ny = await insertUser(t.pool, "isaac@x.com", "America/New_York");
  la = await insertUser(t.pool, "la@x.com", "America/Los_Angeles");
  off = await insertUser(t.pool, "off@x.com", "America/New_York");
  await t.pool.query("update app_users set digest_enabled = false where id = $1", [off]);
  await t.pool.query("update app_users set notify_email = 'alerts@x.com' where id = $1", [ny]);
  await seed(ny, "Due Today Pizza", "2026-10-23");
  await seed(ny, "Overdue Auto", "2026-10-20");
  await seed(ny, "Future Fitness", "2026-10-24");
  await seed(la, "LA Tacos", "2026-10-23");
  await seed(off, "Muted Co", "2026-10-23");
});
afterAll(async () => {
  await t.drop();
});

describe("reminder digest job", () => {
  it("sends New York's digest at 9am, holds LA's until its 8am, skips muted users", async () => {
    const send = ok();
    const summary = await runReminders({
      db: t.db,
      now: MORNING,
      appUrl: "https://app.test",
      send,
    });
    expect(summary).toEqual({ users: 2, sent: 1, skipped: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const [to, digest] = send.mock.calls[0] ?? [];
    expect(to).toBe("alerts@x.com");
    expect(digest.subject).toBe("1 due today, 1 overdue — follow-ups");
    expect(digest.text).toContain("Due Today Pizza");
    expect(digest.text).toContain("Overdue Auto");
    expect(digest.text).not.toContain("Future Fitness");
    expect(digest.text).not.toContain("LA Tacos");
    expect(digest.text).not.toContain("Muted Co");
  });
  it("recorded the send in the database", async () => {
    expect(await sentRows()).toEqual([
      { user_id: ny, for_date: "2026-10-23", provider_id: "resend_123" },
    ]);
  });
  it("does not send twice on the same local day", async () => {
    const send = ok();
    const summary = await runReminders({
      db: t.db,
      now: new Date("2026-10-23T18:00:00Z"),
      appUrl: "https://app.test",
      send,
    });
    expect(send).not.toHaveBeenCalledWith("alerts@x.com", expect.anything());
    expect(summary.sent).toBe(1); // only LA, now past its 8am
    expect((await sentRows()).map((r) => r.user_id)).toEqual([ny, la]);
  });
  it("sends LA's digest once their clock reaches 8am", async () => {
    const rows = await sentRows();
    expect(rows.at(-1)).toMatchObject({ user_id: la, for_date: "2026-10-23" });
  });
  it("sends nothing and records nothing when nothing is due", async () => {
    const send = ok();
    const summary = await runReminders({
      db: t.db,
      now: new Date("2026-10-19T13:00:00Z"),
      appUrl: "https://app.test",
      send,
    });
    expect(send).not.toHaveBeenCalled();
    expect(summary.sent).toBe(0);
    expect((await sentRows()).filter((r) => r.for_date === "2026-10-19")).toEqual([]);
  });
  it("rolls the claim back when the email provider fails, so the next run retries", async () => {
    const next = new Date("2026-10-25T13:00:00Z");
    await seed(ny, "Retry Roofing", "2026-10-25");
    const boom: DigestSender = async () => {
      throw new Error("resend down");
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await runReminders({
      db: t.db,
      now: next,
      appUrl: "https://app.test",
      send: boom,
    });
    errSpy.mockRestore();
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect(
      (await sentRows()).filter((r) => r.for_date === "2026-10-25" && r.user_id === ny),
    ).toEqual([]);
    const send = ok();
    const retry = await runReminders({ db: t.db, now: next, appUrl: "https://app.test", send });
    expect(retry.sent).toBeGreaterThanOrEqual(1);
    expect(
      (await sentRows()).filter((r) => r.for_date === "2026-10-25" && r.user_id === ny),
    ).toHaveLength(1);
  });
  it("two overlapping runs send exactly once", async () => {
    const day = new Date("2026-10-27T13:00:00Z");
    await seed(ny, "Race Roofing", "2026-10-27");
    const send = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return "id";
    });
    await Promise.all([
      runReminders({ db: t.db, now: day, appUrl: "https://app.test", send }),
      runReminders({ db: t.db, now: day, appUrl: "https://app.test", send }),
    ]);
    const forNy = send.mock.calls.filter((c) => (c as unknown[])[0] === "alerts@x.com");
    expect(forNy).toHaveLength(1);
    expect(
      (await sentRows()).filter((r) => r.for_date === "2026-10-27" && r.user_id === ny),
    ).toHaveLength(1);
  });
  it("shows a booked call's local time in the digest", async () => {
    const day = new Date("2026-10-28T13:00:00Z");
    const id = await seed(ny, "Booked Bakery", "2026-10-28", "scheduled_call");
    await t.pool.query(
      "update clients set scheduled_call_at = '2026-10-28T19:30:00Z' where id = $1",
      [id],
    );
    const send = ok();
    await runReminders({ db: t.db, now: day, appUrl: "https://app.test", send });
    const digest = send.mock.calls.find((c) => (c as unknown[])[0] === "alerts@x.com")?.[1];
    expect(digest?.text).toContain("Call at 3:30 PM");
  });
});
