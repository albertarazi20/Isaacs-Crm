/**
 * Round 3 hardening of the send path, each proved in the database (or, where nothing is stored, at the call):
 *   1. a disabled team member sends nothing (outbox claim, bucket engine) and loses their Gmail connection and mailbox;
 *   2. a failed document scan cannot skip the offer notices and the outbox heartbeat;
 *   3. the audit IP on a signature comes from the connection, not from a header the visitor can write;
 *   4. a template with a field that does not exist is never sent as typed (bucket step, welcome, nudge, blast).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { queueBlast, runBucketSteps } from "@/lib/buckets/engine";
import { acceptUpload, mintUploadSession, scanPending } from "@/lib/docs/upload";
import { enqueueEmail } from "@/lib/send/enqueue";
import { drainOutbox, type Deliverer } from "@/lib/send/worker";
import { sendWelcome } from "@/lib/sheets/file";
import { retryOfferNotices } from "@/lib/system/offerNotice";
import { runOpenNudges } from "@/lib/system/openNudge";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

// The route tests below watch these two calls; each still does its real work unless a test says otherwise.
vi.mock("@/lib/docs/upload", async (orig) => {
  const real = await orig<typeof import("@/lib/docs/upload")>();
  return {
    ...real,
    scanPending: vi.fn(real.scanPending),
    acceptUpload: vi.fn(real.acceptUpload),
  };
});
vi.mock("@/lib/system/offerNotice", async (orig) => {
  const real = await orig<typeof import("@/lib/system/offerNotice")>();
  return { ...real, retryOfferNotices: vi.fn(real.retryOfferNotices) };
});

let t: TestDb;
let dir: string;
let rep: string;
let gone: string;
let boss: string;
const APP = "https://crm.test";
const CRON_SECRET = "c".repeat(24);

const sentTo: string[] = [];
const deliver: Deliverer = {
  gmail: async (_u, m) => (sentTo.push(m.to), `g_${sentTo.length}`),
  resend: async (m) => (sentTo.push(m.to), `r_${sentTo.length}`),
};
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as T | undefined;
const count = async (sql: string, params: unknown[] = []) =>
  Number((await one<{ n: string }>(sql, params))!.n);

let n = 0;
async function merchant(owner: string, email?: string): Promise<string> {
  n += 1;
  return (await one<{ id: string }>(
    "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Rosa Diaz', $3, $4, 'FL') returning id",
    [
      owner,
      `Round3 Shop ${n}`,
      `30555502${String(n).padStart(2, "0")}`,
      email ?? `o${n}@round3-${n}.com`,
    ],
  ))!.id;
}
const queueMail = async (owner: string, clientId: string, source: string) => {
  const r = await t.db.withUser(owner, (q) =>
    enqueueEmail(
      q,
      { clientId, lane: "intake", source, subject: `S ${source}`, text: "Hi", when: "now" },
      new Date("2026-12-01T15:00:00Z"),
    ),
  );
  if (!r.queued) throw new Error("not queued");
  return r.outboxId;
};
const outboxRow = async (id: string) =>
  one<{ status: string; attempts: number }>("select status, attempts from outbox where id = $1", [
    id,
  ]);
const bucketId = async (key: string) =>
  (await one<{ id: string }>("select id from buckets where key = $1", [key]))!.id;

beforeAll(async () => {
  t = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "isaac-round3-"));
  const url = (t.pool as unknown as { options: { connectionString: string } }).options
    .connectionString;
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = "s".repeat(40);
  process.env.DOCS_DIR = dir;
  process.env.APP_URL = APP;
  process.env.CRON_SECRET = CRON_SECRET;
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  gone = await insertUser(t.pool, "gone@x.com", "America/New_York");
  boss = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager' where id = $1", [boss]);
  for (const [u, g] of [
    [rep, "rep@selectivecap.com"],
    [gone, "gone@selectivecap.com"],
  ] as const)
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status, can_read_mail) values ($1, $2, 'enc', 'send', 'ok', false)",
      [u, g],
    );
  await t.pool.query(
    "update shop_settings set postal_address = '1 Main St, Miami FL 33101', sequences_enabled = true",
  );
  await t.pool.query(
    "update app_users set application_link = 'https://apply.test/x', name = 'Sam Rep'",
  );
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
  rmSync(dir, { recursive: true, force: true });
});

describe("a disabled team member sends nothing", () => {
  it("the outbox leaves a disabled rep's queued mail alone and sends the active rep's", async () => {
    const mineC = await merchant(rep);
    const goneC = await merchant(gone);
    const mine = await queueMail(rep, mineC, "r3-mine");
    const theirs = await queueMail(gone, goneC, "r3-gone");
    // switched off directly: the Gmail connection is still there, so only the worker's own check can stop the send
    await t.pool.query("update app_users set active = false where id = $1", [gone]);
    const before = sentTo.length;
    const s = await drainOutbox({
      db: t.db,
      deliver,
      now: new Date("2026-12-01T15:05:00Z"),
      appUrl: APP,
    });
    expect(s.sent).toBe(1);
    expect(sentTo.slice(before)).toEqual([
      (await one<{ email: string }>("select email from clients where id = $1", [mineC]))!.email,
    ]);
    expect(await outboxRow(mine)).toMatchObject({ status: "sent" });
    expect(await outboxRow(theirs)).toMatchObject({ status: "queued", attempts: 0 });
    // switched back on: the same row goes
    await t.pool.query("update app_users set active = true where id = $1", [gone]);
    await drainOutbox({ db: t.db, deliver, now: new Date("2026-12-01T15:10:00Z"), appUrl: APP });
    expect(await outboxRow(theirs)).toMatchObject({ status: "sent" });
  });

  it("the bucket engine does not queue a step for a disabled rep's merchant", async () => {
    const mineC = await merchant(rep);
    const goneC = await merchant(gone);
    for (const [owner, c] of [
      [rep, mineC],
      [gone, goneC],
    ] as const)
      await t.db.withUser(owner, async (q) =>
        q.query("select enroll_in_bucket($1, $2)", [c, await bucketId("interested")]),
      );
    await t.pool.query("update app_users set active = false where id = $1", [gone]);
    const s = await runBucketSteps({ db: t.db, appUrl: APP });
    expect(s.emailed).toBe(1);
    expect(await count("select count(*) n from outbox where client_id = $1", [mineC])).toBe(1);
    expect(await count("select count(*) n from outbox where client_id = $1", [goneC])).toBe(0);
    // nothing was consumed: the step is still due when the person comes back
    expect(
      await one("select next_step, steps_sent from enrollments where client_id = $1", [goneC]),
    ).toMatchObject({ next_step: 1, steps_sent: 0 });
    await t.pool.query("update app_users set active = true where id = $1", [gone]);
    await runBucketSteps({ db: t.db, appUrl: APP });
    expect(await count("select count(*) n from outbox where client_id = $1", [goneC])).toBe(1);
  });

  it("set_team_member(active = false) cuts the Gmail connection and switches the mailbox off", async () => {
    // a mailbox row exists once the rep has sent something
    const c = await merchant(gone);
    await queueMail(gone, c, "r3-mailbox");
    await drainOutbox({ db: t.db, deliver, now: new Date("2026-12-01T15:15:00Z"), appUrl: APP });
    expect(
      await count("select count(*) n from mailboxes where user_id = $1 and active", [gone]),
    ).toBe(1);
    await t.pool
      .query(
        "insert into mail_sync_state (user_id, history_id) values ($1, '123') on conflict do nothing",
        [gone],
      )
      .catch(() => undefined);

    await t.db.withUser(boss, (q) => q.query("select set_team_member($1, 'rep', false)", [gone]));

    expect(await one("select active from app_users where id = $1", [gone])).toMatchObject({
      active: false,
    });
    expect(await count("select count(*) n from gmail_connections where user_id = $1", [gone])).toBe(
      0,
    );
    expect(await count("select count(*) n from mail_sync_state where user_id = $1", [gone])).toBe(
      0,
    );
    expect(
      await count("select count(*) n from mailboxes where user_id = $1 and active", [gone]),
    ).toBe(0);
    // an active rep is untouched
    expect(await count("select count(*) n from gmail_connections where user_id = $1", [rep])).toBe(
      1,
    );
    // and with no connection and no login, a queued email for them does not go
    const c2 = await merchant(gone);
    const queued = await queueMail(gone, c2, "r3-after");
    const before = sentTo.length;
    await drainOutbox({ db: t.db, deliver, now: new Date("2026-12-01T15:20:00Z"), appUrl: APP });
    expect(sentTo.length).toBe(before);
    expect(await outboxRow(queued)).toMatchObject({ status: "queued" });
  });
});

describe("the outbox cron survives a failed document scan", () => {
  it("still retries the offer notices and records the heartbeat, and reports the scan error", async () => {
    const { GET } = await import("@/app/api/cron/outbox/route");
    vi.mocked(scanPending).mockRejectedValueOnce(new Error("storage is down"));
    vi.mocked(retryOfferNotices).mockClear();
    await t.pool.query("delete from job_runs where name = 'outbox'");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let res: Response;
    try {
      res = await GET(
        new Request("http://localhost/api/cron/outbox", {
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
      );
    } finally {
      quiet.mockRestore();
    }
    const body = (await res.json()) as { scan: unknown };
    expect(body.scan).toEqual({ scanned: 0, clean: 0, rejected: 0, errors: 1 });
    expect(retryOfferNotices).toHaveBeenCalledTimes(1);
    expect(await count("select count(*) n from job_runs where name = 'outbox'")).toBe(1);
  });
});

describe("the audit address comes from the connection, not from a header the visitor writes", () => {
  const FIELDS = {
    legal_business_name: "Harbor Bakery LLC",
    dba: "Harbor Bakery",
    owner_name: "Dana Reyes",
    title: "Owner",
    phone: "(305) 555-0141",
    email: "dana@harborbakery.com",
    address: "12 Pier St",
    city: "Miami",
    state: "fl",
    zip: "33101",
    ein_last4: "4321",
    industry: "Restaurant",
    business_start: "2021-03",
    monthly_revenue_dollars: 62000,
    amount_requested_dollars: 45000,
    use_of_funds: "A second oven",
    existing_advances: "none",
    consent_email: true,
    consent_sms: false,
    agree: true,
    signer_name: "Dana Reyes",
  };
  const sign = async (clientId: string, headers: Record<string, string>) => {
    const { POST } = await import("@/app/api/apply/[token]/route");
    const token = (await one<{ t: string }>(
      "select application_token as t from clients where id = $1",
      [clientId],
    ))!.t;
    const res = await POST(
      new Request(`http://localhost/api/apply/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(FIELDS),
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(200);
    return (await one<{ ip: string }>(
      "select ip from applications where client_id = $1 order by signed_at desc limit 1",
      [clientId],
    ))!.ip;
  };

  it("the signed application records the platform's connection address, whatever x-forwarded-for says", async () => {
    const c = await merchant(rep);
    expect(
      await sign(c, {
        "x-forwarded-for": "6.6.6.6, 10.0.0.1",
        "x-nf-client-connection-ip": "198.51.100.4",
      }),
    ).toBe("198.51.100.4");
  });
  it("without the platform header it takes the entry the nearest proxy added, never the first one the visitor wrote", async () => {
    const c = await merchant(rep);
    expect(await sign(c, { "x-forwarded-for": "6.6.6.6, 203.0.113.9" })).toBe("203.0.113.9");
  });

  it("the upload route hands the same address to the upload", async () => {
    const { POST } = await import("@/app/api/upload/[token]/route");
    const c = await merchant(rep);
    const { token } = await t.db.withSystem((q) => mintUploadSession(q, { clientId: c }));
    const form = new FormData();
    form.append(
      "file",
      new File([`%PDF-1.4\n1 0 obj << >> endobj\n% round3\n%%EOF\n`], "statement.pdf", {
        type: "application/pdf",
      }),
    );
    vi.mocked(acceptUpload).mockClear();
    const res = await POST(
      new Request(`http://localhost/api/upload/${token}`, {
        method: "POST",
        headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
        body: form,
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(acceptUpload).mock.calls[0]?.[2]).toMatchObject({ ip: "203.0.113.9" });
    // the file really landed
    expect(await count("select count(*) n from documents where client_id = $1", [c])).toBe(1);
  });
});

describe("a template with a field that does not exist is never sent as typed", () => {
  const template = async (subject: string, body: string) =>
    (await one<{ id: string }>(
      "insert into templates (owner_id, name, subject, body, approved) values ($1, 'Typo', $2, $3, true) returning id",
      [rep, subject, body],
    ))!.id;
  const typoBucket = async (templateId: string) => {
    const b = (await one<{ id: string }>(
      "insert into buckets (name, owner_id, rule) values ($1, $2, 'manual') returning id",
      [`Typo bucket ${++n}`, rep],
    ))!.id;
    await t.pool.query(
      "insert into bucket_steps (bucket_id, step_no, day_offset, template_id) values ($1, 1, 0, $2)",
      [b, templateId],
    );
    return b;
  };
  const notes = async (clientId: string, like: string) =>
    (
      await t.pool.query<{ body: string }>(
        "select body from activities where client_id = $1 and kind = 'system' and body like $2",
        [clientId, like],
      )
    ).rows.map((r) => r.body);

  it("a bucket step is held (the pause flag is left alone), with one note, and nothing is queued", async () => {
    const tpl = await template("Hello", "Hi {frist_name}, your link: {upload_link}");
    const b = await typoBucket(tpl);
    const c = await merchant(rep);
    await t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [c, b]));
    await runBucketSteps({ db: t.db, appUrl: APP });
    expect(await count("select count(*) n from outbox where client_id = $1", [c])).toBe(0);
    expect(
      await one(
        "select paused, next_step, steps_sent, hold_since is not null as held from enrollments where client_id = $1 and stopped_at is null",
        [c],
      ),
    ).toMatchObject({ paused: false, next_step: 1, steps_sent: 0, held: true });
    const first = await notes(c, "Bucket email on hold%");
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("{frist_name}");
    // a second run the same day: the step is not due again, nothing goes, and the note is not written twice
    await runBucketSteps({ db: t.db, appUrl: APP });
    expect(await count("select count(*) n from outbox where client_id = $1", [c])).toBe(0);
    expect(await notes(c, "Bucket email on hold%")).toHaveLength(1);
  });

  it("a typo in the subject counts too", async () => {
    const tpl = await template("About {busines}", "Hi {first_name}");
    const b = await typoBucket(tpl);
    const c = await merchant(rep);
    await t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [c, b]));
    await runBucketSteps({ db: t.db, appUrl: APP });
    expect(await count("select count(*) n from outbox where client_id = $1", [c])).toBe(0);
    expect((await notes(c, "Bucket email on hold%"))[0]).toContain("{busines}");
  });

  it("a correct template still sends (the check does not catch real fields)", async () => {
    const tpl = await template("About {business}", "Hi {first_name}, upload here: {upload_link}");
    const b = await typoBucket(tpl);
    const c = await merchant(rep);
    await t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [c, b]));
    await runBucketSteps({ db: t.db, appUrl: APP });
    expect(await count("select count(*) n from outbox where client_id = $1", [c])).toBe(1);
  });

  it("the welcome email is not sent, and says why once", async () => {
    const tpl = await template("Welcome", "Hi {frist_name}");
    const b = await typoBucket(tpl);
    const c = await merchant(rep);
    const attempt = () =>
      t.db.withUser(rep, (q) => sendWelcome(q, c, b, APP, new Date("2026-12-01T15:00:00Z")));
    expect(await attempt()).toBe(false);
    expect(await attempt()).toBe(false);
    expect(await count("select count(*) n from outbox where client_id = $1", [c])).toBe(0);
    const w = await notes(c, "Welcome email not sent%");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("{frist_name}");
  });

  it("a bucket with a daily reminder sends no instant welcome; the same bucket without one does", async () => {
    const tpl = await template("Welcome {business}", "Hi {first_name}, upload here: {upload_link}");
    const b = await typoBucket(tpl);
    const control = await merchant(rep);
    expect(
      await t.db.withUser(rep, (q) =>
        sendWelcome(q, control, b, APP, new Date("2026-12-01T15:00:00Z")),
      ),
    ).toBe(true);
    expect(await count("select count(*) n from outbox where client_id = $1", [control])).toBe(1);
    await t.pool.query("update buckets set daily_template_id = $2 where id = $1", [b, tpl]);
    const c = await merchant(rep);
    expect(
      await t.db.withUser(rep, (q) => sendWelcome(q, c, b, APP, new Date("2026-12-01T15:00:00Z"))),
    ).toBe(false);
    expect(await count("select count(*) n from outbox where client_id = $1", [c])).toBe(0);
  });

  it("the nudge after an open is not sent, and says why once", async () => {
    const tpl = await template("Your link", "Hi {frist_name}: {upload_link}");
    await t.pool.query(
      "update shop_settings set open_nudge = true, open_nudge_upload_template = $1, open_nudge_since = now() - interval '10 days'",
      [tpl],
    );
    const c = await merchant(rep);
    await t.pool.query(
      "select enroll_in_bucket($1, (select id from buckets where key = 'interested'))",
      [c],
    );
    await t.pool.query(
      "insert into link_opens (client_id, kind, opened_at) values ($1, 'upload', now() - interval '25 hours')",
      [c],
    );
    // the bucket's own first email would hide the nudge (an email waiting to go): clear it
    await t.pool.query("delete from outbox where client_id = $1", [c]);
    const s1 = await runOpenNudges({ db: t.db, appUrl: APP });
    const s2 = await runOpenNudges({ db: t.db, appUrl: APP });
    expect(s1.queued + s2.queued).toBe(0);
    expect(
      await count("select count(*) n from outbox where client_id = $1 and source like 'nudge:%'", [
        c,
      ]),
    ).toBe(0);
    const w = await notes(c, "Nudge email not sent%");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("{frist_name}");
    await t.pool.query("update shop_settings set open_nudge = false");
  });

  it("a blast skips the merchant with the reason, and queues nothing", async () => {
    const tpl = await template("Hi", "Hi {frist_name}");
    const c = await merchant(rep);
    const r = await t.db.withUser(rep, (q) =>
      queueBlast(q, { templateId: tpl, clientIds: [c], appUrl: APP }),
    );
    expect(r.queued).toBe(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]?.reason).toContain("{frist_name}");
    expect(await count("select count(*) n from outbox where client_id = $1", [c])).toBe(0);
  });
});
