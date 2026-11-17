import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  runCallReminders,
  runReminders,
  sendTestDigest,
  type DigestSender,
} from "@/lib/system/reminders";
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
    expect(digest.subject).toBe("Follow-ups: 1 due today, 1 overdue");
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

describe("test digest", () => {
  it("sends a clearly-labelled preview when nothing is due, and says so", async () => {
    const empty = await insertUser(t.pool, "empty@x.com", "America/New_York");
    const send = ok();
    const r = await sendTestDigest({
      db: t.db,
      userId: empty,
      now: MORNING,
      appUrl: "https://app.test",
      send,
    });
    expect(r).toEqual({ to: "empty@x.com", usedSample: true, count: 1 });
    const [, digest] = send.mock.calls[0] ?? [];
    expect(digest.subject).toMatch(/^\[Test\] /);
    expect(digest.text).toContain("Sample Pizza");
  });
  it("sends the real due list when there is one, to the notification address", async () => {
    const send = ok();
    const r = await sendTestDigest({
      db: t.db,
      userId: ny,
      now: MORNING,
      appUrl: "https://app.test",
      send,
    });
    expect(r.usedSample).toBe(false);
    expect(r.to).toBe("alerts@x.com");
    expect(send.mock.calls[0]?.[1].text).toContain("Due Today Pizza");
  });
  it("never consumes the real daily digest", async () => {
    const before = (await t.pool.query("select count(*)::int as n from reminders_sent")).rows[0].n;
    await sendTestDigest({
      db: t.db,
      userId: ny,
      now: new Date("2026-11-02T13:00:00Z"),
      appUrl: "https://app.test",
      send: ok(),
    });
    expect((await t.pool.query("select count(*)::int as n from reminders_sent")).rows[0].n).toBe(
      before,
    );
  });
  it("surfaces a provider failure instead of pretending it sent", async () => {
    const boom: DigestSender = async () => {
      throw new Error("Resend failed (403: domain not verified)");
    };
    await expect(
      sendTestDigest({
        db: t.db,
        userId: ny,
        now: MORNING,
        appUrl: "https://app.test",
        send: boom,
      }),
    ).rejects.toThrow(/domain not verified/);
  });
});

describe("booked-call reminders", () => {
  const NOW = new Date("2026-11-10T18:00:00Z"); // 1:00 PM in New York
  let callClient: string;

  const book = async (name: string, at: string, userId = ny) => {
    const { rows } = await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, scheduled_call_at) values ($1, $2, 'Pat', '5551230000', $3) returning id",
      [userId, name, at],
    );
    return rows[0]?.id as string;
  };
  const callRows = async () =>
    (await t.pool.query("select ref from reminders_sent where kind = 'call'")).rows;

  it("emails a heads-up for a call starting within 90 minutes, with the facts he needs", async () => {
    callClient = await book("Call Soon Bakery", "2026-11-10T19:30:00Z"); // 2:30 PM New York, 90 min away
    await t.pool.query(
      "insert into client_asks (user_id, client_id, wanted_amount_cents) values ($1, $2, 5000000)",
      [ny, callClient],
    );
    await t.pool.query(
      "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'call', 'Wants it for a new oven')",
      [ny, callClient],
    );
    const send = ok();
    const r = await runCallReminders({ db: t.db, now: NOW, appUrl: "https://app.test", send });
    expect(r).toEqual({ sent: 1, failed: 0 });
    const [to, msg] = send.mock.calls[0] ?? [];
    expect(to).toBe("alerts@x.com");
    expect(msg.subject).toBe("Call at 2:30 PM: Call Soon Bakery");
    expect(msg.text).toContain("Wants $50k");
    expect(msg.text).toContain("Last call: Wants it for a new oven");
    expect(msg.text).toContain(`https://app.test/clients/${callClient}`);
  });
  it("sends it once per booking", async () => {
    const send = ok();
    expect(
      await runCallReminders({ db: t.db, now: NOW, appUrl: "https://app.test", send }),
    ).toEqual({ sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await callRows()).toHaveLength(1);
  });
  it("sends a fresh reminder when the call is rebooked to a new time", async () => {
    await t.pool.query(
      "update clients set scheduled_call_at = '2026-11-10T19:00:00Z' where id = $1",
      [callClient],
    );
    const send = ok();
    expect(
      (await runCallReminders({ db: t.db, now: NOW, appUrl: "https://app.test", send })).sent,
    ).toBe(1);
    expect(send.mock.calls[0]?.[1].subject).toBe("Call at 2:00 PM: Call Soon Bakery");
  });
  it("ignores calls further out than 90 minutes and calls already past", async () => {
    await book("Far Call Co", "2026-11-10T21:00:00Z");
    await book("Missed Call Co", "2026-11-10T17:00:00Z");
    const send = ok();
    expect(
      await runCallReminders({ db: t.db, now: NOW, appUrl: "https://app.test", send }),
    ).toEqual({ sent: 0, failed: 0 });
  });
  it("skips users who turned reminders off", async () => {
    await book("Muted Call Co", "2026-11-10T19:00:00Z", off);
    const send = ok();
    await runCallReminders({ db: t.db, now: NOW, appUrl: "https://app.test", send });
    expect(send.mock.calls.some((c) => (c as unknown[])[0] === "off@x.com")).toBe(false);
  });
  it("rolls the claim back on a provider failure so the next run retries", async () => {
    const id = await book("Retry Call Co", "2026-11-10T19:15:00Z");
    const boom: DigestSender = async () => {
      throw new Error("resend down");
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await runCallReminders({
      db: t.db,
      now: NOW,
      appUrl: "https://app.test",
      send: boom,
    });
    errSpy.mockRestore();
    expect(failed.failed).toBe(1);
    expect((await callRows()).some((r) => String(r.ref).startsWith(id))).toBe(false);
    expect(
      (await runCallReminders({ db: t.db, now: NOW, appUrl: "https://app.test", send: ok() })).sent,
    ).toBe(1);
  });
});
