import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildAlertEmail, runUserAlerts } from "@/lib/system/alerts";
import type { DigestSender } from "@/lib/system/reminders";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let rep2: string;
let muted: string;
let manager: string;
let pizza: string;

const NOW = new Date("2026-11-16T15:00:00Z");
const ok = (): DigestSender & ReturnType<typeof vi.fn> => vi.fn(async () => "re_alert") as never;

const alerts = async (userId: string, kind?: string) =>
  (
    await t.pool.query<{
      kind: string;
      title: string;
      body: string;
      dedupe_key: string | null;
      emailed_at: Date | null;
      client_id: string | null;
    }>(
      "select kind, title, body, dedupe_key, emailed_at, client_id from user_alerts where user_id = $1 and ($2::text is null or kind = $2) order by id",
      [userId, kind ?? null],
    )
  ).rows;

/** One alert the way the automations write them: the person, the kind, the merchant, the words, the link, a key. */
const alert = (userId: string, kind: string, title: string, body: string, key: string) =>
  t.pool.query("select app.alert($1, $2, $3, null, $4, $5, $6, $7)", [
    userId,
    kind,
    pizza,
    title,
    body,
    `/clients/${pizza}`,
    key,
  ]);

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  rep2 = await insertUser(t.pool, "rep2@x.com", "America/New_York");
  muted = await insertUser(t.pool, "muted@x.com", "America/New_York");
  manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
  await t.pool.query("update app_users set name = 'Josh' where id = $1", [rep]);
  await t.pool.query("update app_users set name = 'Sam' where id = $1", [rep2]);
  pizza = await insertClient(t.db, rep, "Pizza Palace");
  await t.pool.query("update clients set state = 'NY', email = 'mike@pizza.com' where id = $1", [
    pizza,
  ]);
});
afterAll(async () => {
  await t.drop();
});

describe("the alert drain", () => {
  it("bundles every unsent alert for a person into one email and stamps emailed_at", async () => {
    await alert(manager, "reply", "Mike replied: Pizza Palace", "Re: statements", "reply:1");
    await alert(manager, "application_signed", "Pizza Palace signed the application", "", "app:1");
    await alert(manager, "reply", "Taco Town replied", "Sending docs tomorrow", "reply:2");
    await alert(rep, "reply", "Mike replied: Pizza Palace", "Re: statements", "reply:1");
    const send = ok();
    const before = (await alerts(manager)).filter((a) => a.emailed_at === null).length;
    expect(before).toBe(3);
    const s = await runUserAlerts({ db: t.db, now: NOW, appUrl: "https://crm.test", send });
    // the manager and Josh get one email each; Sam has no alerts of his own
    expect(s.sent).toBe(2);
    expect(s.failed).toBe(0);
    const toBoss = send.mock.calls.find((c) => c[0] === "boss@x.com");
    expect(toBoss).toBeDefined();
    const digest = toBoss![1];
    expect(digest.subject).toMatch(new RegExp(`^${before} things need you — `));
    expect(digest.text).toContain("Pizza Palace signed the application");
    expect(digest.text).toContain("Taco Town replied");
    expect(digest.text).toContain("https://crm.test/clients/");
    expect((await alerts(manager)).every((a) => a.emailed_at !== null)).toBe(true);
    expect((await alerts(rep)).every((a) => a.emailed_at !== null)).toBe(true);
  });
  it("sends at most one email per person per hour, then the next bundle", async () => {
    await t.pool.query(
      "select app.alert($1, 'test', null, null, 'Ten minutes later', '', '/', 'later:1')",
      [manager],
    );
    const soon = ok();
    const s1 = await runUserAlerts({
      db: t.db,
      now: new Date(NOW.getTime() + 10 * 60_000),
      appUrl: "https://crm.test",
      send: soon,
    });
    expect(soon).not.toHaveBeenCalled();
    expect(s1.skipped).toBeGreaterThanOrEqual(1);
    expect((await alerts(manager, "test"))[0]?.emailed_at).toBeNull();
    const later = ok();
    const s2 = await runUserAlerts({
      db: t.db,
      now: new Date(NOW.getTime() + 61 * 60_000),
      appUrl: "https://crm.test",
      send: later,
    });
    expect(s2.sent).toBe(1);
    expect(later.mock.calls[0]?.[0]).toBe("boss@x.com");
    expect(later.mock.calls[0]?.[1].subject).toBe("Ten minutes later");
    expect((await alerts(manager, "test"))[0]?.emailed_at).not.toBeNull();
  });
  it("a failed send leaves the rows unsent for the next run; two overlapping runs send once", async () => {
    const at = new Date(NOW.getTime() + 3 * 3_600_000);
    await t.pool.query("select app.alert($1, 'test', null, null, 'Retry me', '', '/', 'retry:1')", [
      rep2,
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boom: DigestSender = async () => {
      throw new Error("resend down");
    };
    const failed = await runUserAlerts({
      db: t.db,
      now: at,
      appUrl: "https://crm.test",
      send: boom,
    });
    errSpy.mockRestore();
    expect(failed.failed).toBe(1);
    expect((await alerts(rep2, "test"))[0]?.emailed_at).toBeNull();
    const slow = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return "re_slow";
    });
    await Promise.all([
      runUserAlerts({ db: t.db, now: at, appUrl: "https://crm.test", send: slow }),
      runUserAlerts({ db: t.db, now: at, appUrl: "https://crm.test", send: slow }),
    ]);
    expect(slow.mock.calls.filter((c) => (c as unknown[])[0] === "rep2@x.com")).toHaveLength(1);
    expect((await alerts(rep2, "test"))[0]?.emailed_at).not.toBeNull();
  });
  it("a person off the allowlist or with the digest muted gets no email", async () => {
    const at = new Date(NOW.getTime() + 5 * 3_600_000);
    await t.pool.query("select app.alert($1, 'test', null, null, 'Muted', '', '/', 'muted:1')", [
      muted,
    ]);
    const send = ok();
    await runUserAlerts({
      db: t.db,
      now: at,
      appUrl: "https://crm.test",
      send,
      allowed: (e) => e !== "muted@x.com",
    });
    expect(send).not.toHaveBeenCalled();
    await t.pool.query("update app_users set digest_enabled = false where id = $1", [muted]);
    await runUserAlerts({ db: t.db, now: at, appUrl: "https://crm.test", send });
    expect(send).not.toHaveBeenCalled();
    expect((await alerts(muted, "test"))[0]?.emailed_at).toBeNull();
  });
  it("the email: one thing is its own subject", () => {
    const m = buildAlertEmail(
      [
        {
          id: "1",
          kind: "reply",
          title: "Mike replied: Pizza Palace",
          body: "Sending the statements tonight",
          href: "/clients/x",
          created_at: NOW,
        },
      ],
      "https://crm.test",
    );
    expect(m.subject).toBe("Mike replied: Pizza Palace");
    expect(m.text).toContain("https://crm.test/clients/x");
    expect(m.html).toContain("Sending the statements tonight");
  });
});
