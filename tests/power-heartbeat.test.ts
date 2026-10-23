import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  evaluateReminderStatus,
  recordHeartbeat,
  reminderStatus,
  REMINDER_JOB,
  STALE_AFTER_HOURS,
} from "@/lib/system/heartbeat";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let user: string;

const HOUR = 3_600_000;
const NOW = new Date("2026-10-23T15:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

beforeAll(async () => {
  t = await createTestDb();
  user = await insertUser(t.pool, "isaac@x.com");
});
afterAll(async () => {
  // The cron-route test below opens the app's own pool against this database.
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

const rows = async () =>
  (
    await t.pool.query<{ name: string; last_run_at: Date }>(
      "select name, last_run_at from job_runs",
    )
  ).rows;

describe("heartbeat table", () => {
  it("records the run, and a second run updates the same row instead of adding one", async () => {
    await recordHeartbeat(REMINDER_JOB, { db: t.db, now: ago(5 * HOUR) });
    expect(await rows()).toEqual([{ name: "reminders", last_run_at: ago(5 * HOUR) }]);
    await recordHeartbeat(REMINDER_JOB, { db: t.db, now: NOW });
    expect(await rows()).toEqual([{ name: "reminders", last_run_at: NOW }]);
  });
  it("keeps separate jobs apart", async () => {
    await recordHeartbeat("other-job", { db: t.db, now: ago(HOUR) });
    expect((await rows()).map((r) => r.name).sort()).toEqual(["other-job", "reminders"]);
    await t.pool.query("delete from job_runs where name = 'other-job'");
  });
  it("refuses an empty job name", async () => {
    await expect(recordHeartbeat("  ", { db: t.db, now: NOW })).rejects.toThrow();
  });

  it("is unreachable by the browser-facing role: permission denied, not an empty result", async () => {
    await expect(t.db.withUser(user, (q) => q.query("select * from job_runs"))).rejects.toThrow(
      /permission denied for table job_runs/,
    );
    await expect(
      t.db.withUser(user, (q) =>
        q.query("insert into job_runs (name, last_run_at) values ('reminders', now())"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.db.withUser(user, (q) => q.query("update job_runs set last_run_at = now()")),
    ).rejects.toThrow(/permission denied/);
    await expect(t.db.withUser(user, (q) => q.query("delete from job_runs"))).rejects.toThrow(
      /permission denied/,
    );
    // ...and nothing it tried changed the row.
    expect(await rows()).toEqual([{ name: "reminders", last_run_at: NOW }]);
  });
  it("has row-level security on and not one grant for isaac_app", async () => {
    const { rows: r } = await t.pool.query<{ rls: boolean; any_grant: boolean }>(
      `select c.relrowsecurity as rls,
              (has_table_privilege('isaac_app', c.oid, 'select') or has_table_privilege('isaac_app', c.oid, 'insert')
               or has_table_privilege('isaac_app', c.oid, 'update') or has_table_privilege('isaac_app', c.oid, 'delete')) as any_grant
         from pg_class c where c.relname = 'job_runs'`,
    );
    expect(r).toEqual([{ rls: true, any_grant: false }]);
  });
});

describe("when the banner shows (pure)", () => {
  const status = (over: Partial<Parameters<typeof evaluateReminderStatus>[0]>) =>
    evaluateReminderStatus({
      configured: true,
      lastRunAt: ago(HOUR),
      accountCreatedAt: ago(100 * 24 * HOUR),
      now: NOW,
      ...over,
    });

  it("is silent when the scheduler is not set up (local dev)", () => {
    expect(status({ configured: false, lastRunAt: null }).stale).toBe(false);
    expect(status({ configured: false, lastRunAt: ago(99 * HOUR) }).stale).toBe(false);
  });
  it("is silent while the last run is within three hours, even at the edge", () => {
    expect(status({ lastRunAt: ago(HOUR) })).toMatchObject({ stale: false, hoursSince: 1 });
    expect(status({ lastRunAt: ago(STALE_AFTER_HOURS * HOUR) })).toMatchObject({
      stale: false,
      hoursSince: 3,
    });
  });
  it("shows once it is older than three hours, with the hours spelled out", () => {
    expect(status({ lastRunAt: ago(3 * HOUR + 60_000) })).toMatchObject({
      stale: true,
      hoursSince: 3,
    });
    expect(status({ lastRunAt: ago(7 * HOUR + 1_800_000) })).toMatchObject({
      stale: true,
      hoursSince: 7,
    });
    expect(status({ lastRunAt: ago(50 * HOUR) })).toMatchObject({ stale: true, hoursSince: 50 });
  });
  it("never ran: silent for a brand-new account, red once the account is over a day old", () => {
    expect(status({ lastRunAt: null, accountCreatedAt: ago(2 * HOUR) })).toMatchObject({
      stale: false,
      neverRan: true,
    });
    expect(status({ lastRunAt: null, accountCreatedAt: ago(24 * HOUR) }).stale).toBe(false);
    expect(status({ lastRunAt: null, accountCreatedAt: ago(25 * HOUR) })).toMatchObject({
      stale: true,
      neverRan: true,
      hoursSince: null,
    });
    expect(status({ lastRunAt: null, accountCreatedAt: null }).stale).toBe(false);
  });
  it("a clock a little ahead of the database does not read as negative hours", () => {
    expect(status({ lastRunAt: new Date(NOW.getTime() + 5 * 60_000) })).toMatchObject({
      stale: false,
      hoursSince: 0,
    });
  });
});

describe("reminderStatus reads the real heartbeat", () => {
  it("fresh run: no banner", async () => {
    await recordHeartbeat(REMINDER_JOB, { db: t.db, now: ago(HOUR) });
    expect(await reminderStatus(user, { db: t.db, now: NOW, configured: true })).toMatchObject({
      configured: true,
      stale: false,
      hoursSince: 1,
    });
  });
  it("a run from five hours ago: banner, saying five hours", async () => {
    await recordHeartbeat(REMINDER_JOB, { db: t.db, now: ago(5 * HOUR) });
    expect(await reminderStatus(user, { db: t.db, now: NOW, configured: true })).toMatchObject({
      stale: true,
      hoursSince: 5,
      neverRan: false,
    });
  });
  it("never ran and the account is old: banner; new account: none", async () => {
    await t.pool.query("delete from job_runs");
    await t.pool.query("update app_users set created_at = $2 where id = $1", [
      user,
      ago(3 * 24 * HOUR),
    ]);
    expect(await reminderStatus(user, { db: t.db, now: NOW, configured: true })).toMatchObject({
      stale: true,
      neverRan: true,
    });
    await t.pool.query("update app_users set created_at = $2 where id = $1", [user, ago(HOUR)]);
    expect((await reminderStatus(user, { db: t.db, now: NOW, configured: true })).stale).toBe(
      false,
    );
  });
  it("does not even look when the scheduler is not configured", async () => {
    const exploding = {
      withUser: () => Promise.reject(new Error("must not be called")),
      withSystem: () => Promise.reject(new Error("must not be called")),
    };
    expect(
      await reminderStatus(user, { db: exploding, now: NOW, configured: false }),
    ).toMatchObject({
      configured: false,
      stale: false,
    });
  });
});

describe("the hourly cron route", () => {
  async function route() {
    const url = new URL(
      (t.pool as unknown as { options: { connectionString: string } }).options.connectionString,
    );
    process.env.DATABASE_URL = url.toString();
    process.env.SESSION_SECRET = "x".repeat(40);
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_FROM = "Isaac <isaac@example.com>";
    process.env.CRON_SECRET = "c".repeat(20);
    process.env.ALLOWED_EMAILS ??= "isaac@x.com";
    return import("@/app/api/cron/reminders/route");
  }
  const call = (handler: (r: Request) => Promise<Response>, auth?: string) =>
    handler(
      new Request("http://localhost/api/cron/reminders", {
        method: "POST",
        headers: auth ? { authorization: auth } : {},
      }),
    );

  it("records a heartbeat on every authorised run, even when there is nothing to send", async () => {
    const { POST } = await route();
    await t.pool.query("delete from job_runs");
    // No users are due a digest or a call heads-up in this database.
    const before = Date.now();
    const res = await call(POST, `Bearer ${"c".repeat(20)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent?: number };
    expect(body.sent ?? 0).toBe(0);
    const [row] = await rows();
    expect(row?.name).toBe("reminders");
    expect(row?.last_run_at.getTime()).toBeGreaterThanOrEqual(before - 1000);

    // A second run moves the same row forward instead of adding another.
    await new Promise((r) => setTimeout(r, 20));
    const first = row?.last_run_at.getTime() ?? 0;
    expect((await call(POST, `Bearer ${"c".repeat(20)}`)).status).toBe(200);
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]?.last_run_at.getTime()).toBeGreaterThan(first);
  });
  it("an unauthorised call records nothing", async () => {
    const { POST, GET } = await route();
    await t.pool.query("delete from job_runs");
    expect((await call(POST)).status).toBe(401);
    expect((await call(GET, "Bearer wrong-secret-wrong-secret")).status).toBe(401);
    expect(await rows()).toEqual([]);
  });

  describe("when sending fails, it is NOT a healthy run", () => {
    const AUTH = `Bearer ${"c".repeat(20)}`;
    /** Resend answering like it does for an unverified RESEND_FROM. */
    const resend = (fail: (subject: string) => boolean) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body: string }) => {
          const { subject } = JSON.parse(init.body) as { subject: string };
          return fail(subject)
            ? new Response(JSON.stringify({ message: "The from address is not verified" }), {
                status: 403,
              })
            : new Response(JSON.stringify({ id: "re_ok_1" }), { status: 200 });
        }),
      );
    // Real time, not the fixed NOW above: the route stamps the run with the actual clock.
    const FIVE_HOURS_AGO = new Date(Date.now() - 5 * HOUR);

    afterEach(() => vi.unstubAllGlobals());

    async function arrange() {
      await t.pool.query("delete from reminders_sent");
      await t.pool.query("delete from clients");
      await t.pool.query(
        "update app_users set digest_hour = 0, digest_enabled = true where id = $1",
        [user],
      );
      const { rows: c } = await t.pool.query<{ id: string }>(
        "insert into clients (user_id, business_name, contact_name, phone) values ($1, 'Due Co', 'Owner', '5551234567') returning id",
        [user],
      );
      await t.pool.query(
        "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'follow_up', current_date)",
        [user, c[0]?.id],
      );
      await recordHeartbeat(REMINDER_JOB, { db: t.db, now: FIVE_HOURS_AGO });
      return c[0]?.id as string;
    }
    const lastRun = async () => (await rows())[0]?.last_run_at.getTime();

    it("every email sent: 200, and the heartbeat moves forward", async () => {
      await arrange();
      resend(() => false);
      const { POST } = await route();
      const res = await call(POST, AUTH);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ sent: 1, failed: 0, calls: { failed: 0 } });
      expect(await lastRun()).toBeGreaterThan(FIVE_HOURS_AGO.getTime());
    });

    it("a user taken off ALLOWED_EMAILS gets no email through the real route, and the run is still healthy", async () => {
      await arrange();
      const fetched = vi.fn(
        async () => new Response(JSON.stringify({ id: "re_x" }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetched);
      // env() is read once per module load, so load the route fresh with the shorter list.
      const before = process.env.ALLOWED_EMAILS;
      vi.resetModules();
      process.env.ALLOWED_EMAILS = "someone-else@x.com";
      try {
        const { POST } = await route();
        const res = await call(POST, AUTH);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ sent: 0, skipped: 1 });
        expect(fetched).not.toHaveBeenCalled();
        expect(await lastRun()).toBeGreaterThan(FIVE_HOURS_AGO.getTime());
      } finally {
        process.env.ALLOWED_EMAILS = before;
        vi.resetModules();
      }
    });

    it("the digest fails to send (wrong RESEND_FROM): 502 with the counts, and the heartbeat does NOT move", async () => {
      await arrange();
      resend(() => true);
      const { POST } = await route();
      const res = await call(POST, AUTH);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({
        users: 1,
        sent: 0,
        failed: 1,
        calls: { sent: 0, failed: 0 },
      });
      expect(await lastRun()).toBe(FIVE_HOURS_AGO.getTime());
      // The failed send rolled its claim back, so the next hourly run retries it.
      expect((await t.pool.query("select 1 from reminders_sent")).rowCount).toBe(0);
    });

    it("only the booked-call heads-up fails: still 502, heartbeat still does not move", async () => {
      const client = await arrange();
      await t.pool.query(
        "update clients set scheduled_call_at = now() + interval '30 minutes' where id = $1",
        [client],
      );
      resend((subject) => subject.startsWith("Call at"));
      const { POST } = await route();
      const res = await call(POST, AUTH);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ sent: 1, failed: 0, calls: { sent: 0, failed: 1 } });
      expect(await lastRun()).toBe(FIVE_HOURS_AGO.getTime());
    });

    it("a failing scheduler is what the banner is for: stays red until a run really succeeds", async () => {
      await arrange();
      resend(() => true);
      const { POST } = await route();
      expect((await call(POST, AUTH)).status).toBe(502);
      expect(await reminderStatus(user, { db: t.db, configured: true })).toMatchObject({
        stale: true,
        hoursSince: 5,
      });
      resend(() => false);
      expect((await call(POST, AUTH)).status).toBe(200);
      expect((await reminderStatus(user, { db: t.db, configured: true })).stale).toBe(false);
    });
  });
});
