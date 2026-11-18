import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authResults, getMessage } from "@/lib/inbox/gmailRead";
import { syncInbox } from "@/lib/inbox/sync";
import { enqueueEmail } from "@/lib/send/enqueue";
import { inSendWindow } from "@/lib/send/rules";
import { drainOutbox, mailboxFor, type Deliverer } from "@/lib/send/worker";
import { handleResendEvent } from "@/lib/system/replies";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

const b64url = (s: string) => Buffer.from(s).toString("base64url");
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("authentication results (email-pipeline-1)", () => {
  const good =
    "mx.google.com; dkim=pass header.i=@pizza.com header.s=s1; spf=pass (google.com: domain of mike@pizza.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=mike@pizza.com; dmarc=pass header.from=pizza.com";

  it("counts a pass only when it vouches for the From domain", () => {
    expect(authResults(good, "mike@pizza.com")).toEqual({ spf: true, dkim: true });
    // attacker.com passes SPF and DKIM for itself, but the From says pizza.com
    const attacker =
      "mx.google.com; dkim=pass header.d=attacker.com; spf=pass smtp.mailfrom=bounce@attacker.com";
    expect(authResults(attacker, "mike@pizza.com")).toEqual({ spf: false, dkim: false });
    // a subdomain of the From domain (mail.pizza.com) is aligned
    expect(
      authResults(
        "mx.google.com; dkim=pass header.d=mail.pizza.com; spf=pass smtp.mailfrom=mail.pizza.com",
        "mike@pizza.com",
      ),
    ).toEqual({ spf: true, dkim: true });
  });
  it("does not read 'spf=pass' out of a comment or another clause", () => {
    expect(
      authResults("mx.google.com; spf=fail (not spf=pass) smtp.mailfrom=a@pizza.com; dkim=none"),
    ).toEqual({ spf: false, dkim: false });
  });
  it("getMessage keeps Gmail's own Authentication-Results, never a sender-supplied duplicate", async () => {
    const payload = (headers: { name: string; value: string }[]) => ({
      id: "m1",
      threadId: "t1",
      historyId: "1",
      internalDate: String(Date.now()),
      payload: {
        mimeType: "text/plain",
        headers,
        body: { data: b64url("hello") },
      },
    });
    const fetchImpl = (async () =>
      json(
        payload([
          { name: "Authentication-Results", value: "mx.google.com; spf=fail; dkim=none" },
          { name: "From", value: "mike@pizza.com" },
          { name: "Authentication-Results", value: "mx.google.com; spf=pass; dkim=pass" },
        ]),
      )) as unknown as typeof fetch;
    const m = await getMessage("tok", "m1", fetchImpl);
    expect(m.headers["authentication-results"]).toBe("mx.google.com; spf=fail; dkim=none");
    // a header that is not from Google's authserv-id is not trusted at all
    const other = (async () =>
      json(
        payload([{ name: "Authentication-Results", value: "evil.example; spf=pass; dkim=pass" }]),
      )) as unknown as typeof fetch;
    expect(
      (await getMessage("tok", "m1", other)).headers["authentication-results"],
    ).toBeUndefined();
  });
});

describe("the email pipeline, from a real database", () => {
  let t: TestDb;
  let dir: string;
  let rep: string;
  let boss: string;
  const sentTo: string[] = [];
  const deliver: Deliverer = {
    gmail: async (_u, m) => (sentTo.push(m.to), `g_${sentTo.length}`),
    resend: async (m) => (sentTo.push(m.to), `r_${sentTo.length}`),
  };
  const outbox = async (id: string) =>
    (
      await t.pool.query<{
        status: string;
        attempts: number;
        last_error: string | null;
        not_before: Date;
      }>("select status, attempts, last_error, not_before from outbox where id = $1", [id])
    ).rows[0];
  const queue = async (
    clientId: string,
    source: string,
    lane: "intake" | "sequence" = "intake",
  ) => {
    const r = await t.db.withUser(rep, (q) =>
      enqueueEmail(
        q,
        { clientId, lane, source, subject: `S ${source}`, text: "Hi", when: "now" },
        new Date("2026-12-01T15:00:00Z"),
      ),
    );
    if (!r.queued) throw new Error("not queued");
    return r.outboxId;
  };

  beforeAll(async () => {
    t = await createTestDb();
    dir = mkdtempSync(join(tmpdir(), "isaac-pipeline-"));
    process.env.DATABASE_URL = "postgres://unused@localhost/unused";
    process.env.SESSION_SECRET = "s".repeat(40);
    process.env.DOCS_DIR = dir;
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    boss = await insertUser(t.pool, "boss@x.com", "America/New_York");
    await t.pool.query("update app_users set role = 'manager' where id = $1", [boss]);
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status, can_read_mail) values ($1, 'rep@selectivecap.com', 'enc', 'send', 'ok', false)",
      [rep],
    );
    await t.pool.query("update shop_settings set postal_address = '1 Main St, Miami FL 33101'");
  });
  afterAll(async () => {
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a rep who reconnects Gmail as another account does not poison the run (email-pipeline-2)", async () => {
    const c = await insertClient(t.db, rep, "Reconnect Co");
    await t.pool.query("update clients set email = 'a@reconnect.com' where id = $1", [c]);
    const first = await queue(c, "intake-1");
    await drainOutbox({
      db: t.db,
      deliver,
      now: new Date("2026-12-01T15:05:00Z"),
      appUrl: "https://crm.test",
    });
    expect((await outbox(first))?.status).toBe("sent");
    // the rep disconnects and reconnects as sam@company.com: the mailbox row stays, the connection is new
    await t.pool.query(
      "update gmail_connections set google_email = 'sam@company.com' where user_id = $1",
      [rep],
    );
    const second = await queue(c, "intake-2");
    const s = await drainOutbox({
      db: t.db,
      deliver,
      now: new Date("2026-12-01T15:10:00Z"),
      appUrl: "https://crm.test",
    });
    expect(s.sent).toBe(1);
    expect((await outbox(second))?.status).toBe("sent");
    const boxes = await t.pool.query<{ address: string }>(
      "select address from mailboxes where kind = 'gmail' and user_id = $1",
      [rep],
    );
    expect(boxes.rows).toEqual([{ address: "sam@company.com" }]);
    // both sends are on that one mailbox's ledger
    const ledger = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from send_ledger l join mailboxes m on m.id = l.mailbox_id where m.user_id = $1",
      [rep],
    );
    expect(ledger.rows[0]?.n).toBe(2);
    // and the helper itself is idempotent for the same address
    const id1 = await t.db.withSystem((q) => mailboxFor(q, "gmail", rep, "sam@company.com", 2000));
    const id2 = await t.db.withSystem((q) => mailboxFor(q, "gmail", rep, "sam@company.com", 2000));
    expect(id1).toBe(id2);
  });

  it("one row the checks cannot get through fails alone; the rest of the run goes on (email-pipeline-2)", async () => {
    const bad = await insertClient(t.db, rep, "Bad Zone Co");
    await t.pool.query("update clients set email = 'a@badzone.com' where id = $1", [bad]);
    const badId = await queue(bad, "intake-bad");
    const good = await insertClient(t.db, rep, "Good Co");
    await t.pool.query("update clients set email = 'a@good.com' where id = $1", [good]);
    const goodId = await queue(good, "intake-good");
    // the database refuses one row's attempt bookkeeping, after the claim (an integrity error, class 23, the kind bad data raises)
    await t.pool.query(
      `create function public.test_refuse() returns trigger language plpgsql as $$
       begin
         if new.to_address = 'a@badzone.com' and old.status = 'sending' and new.status = 'sending' then
           raise exception 'refused for the test' using errcode = '23514';
         end if;
         return new;
       end $$`,
    );
    await t.pool.query(
      "create trigger test_refuse before update on outbox for each row execute function public.test_refuse()",
    );
    let s: Awaited<ReturnType<typeof drainOutbox>>;
    const before = sentTo.length;
    try {
      s = await drainOutbox({
        db: t.db,
        deliver,
        now: new Date("2026-12-01T15:15:00Z"),
        appUrl: "https://crm.test",
      });
    } finally {
      await t.pool.query("drop trigger test_refuse on outbox");
      await t.pool.query("drop function public.test_refuse()");
    }
    // the bad row is failed at once (a refusal that will come again) and the run still sent the good one
    expect(s.failed).toBe(1);
    expect(s.sent).toBe(1);
    expect((await outbox(badId))?.status).toBe("failed");
    expect((await outbox(badId))?.last_error).toContain("could not prepare");
    expect((await outbox(goodId))?.status).toBe("sent");
    expect(sentTo.slice(before)).toEqual(["a@good.com"]);
  });

  it("a send that went through is never sent again when the bookkeeping fails (email-pipeline-3)", async () => {
    const c = await insertClient(t.db, rep, "Ledger Fail Co");
    await t.pool.query("update clients set email = 'a@ledgerfail.com' where id = $1", [c]);
    const id = await queue(c, "intake-lf");
    await t.pool.query(
      `create function public.test_boom() returns trigger language plpgsql as $$ begin raise exception 'ledger boom'; end $$`,
    );
    await t.pool.query(
      "create trigger test_boom before insert on send_ledger for each row execute function public.test_boom()",
    );
    const before = sentTo.length;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const s = await drainOutbox({
        db: t.db,
        deliver,
        now: new Date("2026-12-01T15:20:00Z"),
        appUrl: "https://crm.test",
      });
      expect(s.sent).toBe(1);
    } finally {
      quiet.mockRestore();
      await t.pool.query("drop trigger test_boom on send_ledger");
    }
    expect(sentTo.length - before).toBe(1);
    const row = await outbox(id);
    expect(row?.status).toBe("sent");
    expect(row?.last_error).toContain("bookkeeping failed");
    // later runs do not pick it up again
    await drainOutbox({
      db: t.db,
      deliver,
      now: new Date("2026-12-01T16:30:00Z"),
      appUrl: "https://crm.test",
    });
    expect(sentTo.length - before).toBe(1);
  });

  it("a row stuck in 'sending' that reached the provider is failed for a person to check, never resent (email-pipeline-3)", async () => {
    const c = await insertClient(t.db, rep, "Stuck Co");
    await t.pool.query("update clients set email = 'a@stuck.com' where id = $1", [c]);
    const id = await queue(c, "intake-stuck");
    // 'pending' is written just before the provider call: the email may have gone out
    await t.pool.query(
      "update outbox set status = 'sending', provider_id = 'pending', not_before = $2 where id = $1",
      [id, "2026-12-01T10:00:00Z"],
    );
    const before = sentTo.length;
    const s = await drainOutbox({
      db: t.db,
      deliver,
      now: new Date("2026-12-01T17:00:00Z"),
      appUrl: "https://crm.test",
    });
    expect(s.failed).toBe(1);
    expect(sentTo.length).toBe(before);
    expect((await outbox(id))?.status).toBe("failed");
    expect((await outbox(id))?.last_error).toContain("interrupted while sending");
  });

  it("a row stuck in 'sending' that never reached the provider is queued again with its attempt returned (email-pipeline-3)", async () => {
    const c = await insertClient(t.db, rep, "Unmarked Stuck Co");
    await t.pool.query("update clients set email = 'a@unmarked.com' where id = $1", [c]);
    const id = await queue(c, "intake-unmarked");
    // claimed (an attempt counted) but the run died before the 'pending' mark: nothing was sent
    await t.pool.query(
      "update outbox set status = 'sending', provider_id = null, attempts = 1, not_before = $2 where id = $1",
      [id, "2026-12-01T10:00:00Z"],
    );
    const before = sentTo.length;
    const s = await drainOutbox({
      db: t.db,
      deliver,
      now: new Date("2026-12-01T17:00:00Z"),
      appUrl: "https://crm.test",
    });
    // not failed: it was queued again and went out once, on its first real attempt (1 returned, then 1 counted)
    expect(s.failed).toBe(0);
    expect(sentTo.slice(before)).toEqual(["a@unmarked.com"]);
    expect(await outbox(id)).toMatchObject({ status: "sent", attempts: 1, last_error: null });
    // and the sweep alone (a row the run cannot send yet) returns the attempt and says why
    const held = await queue(c, "intake-unmarked-2");
    await t.pool.query(
      "update outbox set status = 'sending', provider_id = null, attempts = 2, not_before = $2, expires_at = $3 where id = $1",
      [held, "2026-12-01T10:00:00Z", "2099-01-01T00:00:00Z"],
    );
    await t.pool.query("update clients set email_opt_out = true where id = $1", [c]);
    await drainOutbox({
      db: t.db,
      deliver,
      now: new Date("2026-12-01T18:00:00Z"),
      appUrl: "https://crm.test",
    });
    expect(await outbox(held)).toMatchObject({
      status: "skipped",
      attempts: 1,
      last_error: "interrupted before sending: queued again",
    });
    await t.pool.query("update clients set email_opt_out = false where id = $1", [c]);
  });

  it("a deferral is not an attempt: one transient error after many deferrals is retried, not failed (email-pipeline-6)", async () => {
    const rep2 = await insertUser(t.pool, "norgmail@x.com", "America/New_York");
    const c = await insertClient(t.db, rep2, "No Gmail Co");
    await t.pool.query("update clients set email = 'a@nogmail.com' where id = $1", [c]);
    const r = await t.db.withUser(rep2, (q) =>
      enqueueEmail(
        q,
        { clientId: c, lane: "intake", source: "intake-ng", subject: "S", text: "t" },
        new Date("2026-12-02T15:00:00Z"),
      ),
    );
    if (!r.queued) throw new Error("not queued");
    // three runs with no Gmail connected: three deferrals, zero attempts
    let at = new Date("2026-12-02T15:05:00Z");
    for (let i = 0; i < 3; i += 1) {
      await drainOutbox({ db: t.db, deliver, now: at, appUrl: "https://crm.test" });
      at = new Date(at.getTime() + 7 * 3_600_000);
    }
    expect(await outbox(r.outboxId)).toMatchObject({
      status: "queued",
      attempts: 0,
      last_error: "gmail_not_connected",
    });
    // Gmail gets connected; the first real send fails once: attempt 1, queued again with a backoff
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status) values ($1, 'norg@selectivecap.com', 'enc', 'send', 'ok')",
      [rep2],
    );
    const failing: Deliverer = {
      gmail: async () => {
        throw new Error("gmail 500");
      },
      resend: async () => "x",
    };
    await drainOutbox({ db: t.db, deliver: failing, now: at, appUrl: "https://crm.test" });
    expect(await outbox(r.outboxId)).toMatchObject({
      status: "queued",
      attempts: 1,
      last_error: "gmail 500",
    });
    // attempts 2 and 3 fail too: only then is it failed, and it was never sent
    at = new Date(at.getTime() + 20 * 60_000);
    await drainOutbox({ db: t.db, deliver: failing, now: at, appUrl: "https://crm.test" });
    expect((await outbox(r.outboxId))?.attempts).toBe(2);
    at = new Date(at.getTime() + 40 * 60_000);
    await drainOutbox({ db: t.db, deliver: failing, now: at, appUrl: "https://crm.test" });
    expect(await outbox(r.outboxId)).toMatchObject({ status: "failed", attempts: 3 });
    const ledger = await t.pool.query("select 1 from send_ledger where outbox_id = $1", [
      r.outboxId,
    ]);
    expect(ledger.rowCount).toBe(0);
  });

  it("a sequence email re-timed by the per-merchant cap lands in the merchant's window (email-pipeline-5)", async () => {
    const c = await insertClient(t.db, rep, "Window Co");
    await t.pool.query("update clients set email = 'a@window.com' where id = $1", [c]);
    const first = await queue(c, "bucket:w:step:1", "sequence");
    const second = await queue(c, "bucket:w:step:2", "sequence");
    // 10:30 in New York: inside the window (bulk mail goes only inside it) and after the queued time
    const now = new Date("2026-12-01T15:30:00Z");
    const s = await drainOutbox({ db: t.db, deliver, now, appUrl: "https://crm.test" });
    expect(s.sent).toBe(1);
    expect(s.deferred).toBe(1);
    expect((await outbox(first))?.status).toBe("sent");
    const row = await outbox(second);
    expect(row?.status).toBe("queued");
    const w = (
      await t.pool.query<{
        tz: string;
        a: number;
        b: number;
        we: boolean;
        h: boolean;
      }>(
        `select app.client_timezone(c) as tz, s.send_window_start as a, s.send_window_end as b,
                s.send_on_weekends as we, s.send_on_holidays as h
           from clients c cross join shop_settings s where c.id = $1`,
        [c],
      )
    ).rows[0];
    if (!row || !w) throw new Error("missing");
    expect(row.not_before.getTime()).toBeGreaterThanOrEqual(now.getTime() + 24 * 3_600_000);
    expect(
      inSendWindow(row.not_before, {
        timezone: w.tz,
        startHour: w.a,
        endHour: w.b,
        weekends: w.we,
        holidays: w.h,
      }),
    ).toBe(true);
  });

  it("the sync maps a reply to the live merchant, not a trashed one with the same address (email-pipeline-8)", async () => {
    const old = await insertClient(t.db, boss, "Old Pizza");
    await t.pool.query(
      "update clients set email = 'mike@dup.com', created_at = now() - interval '30 days' where id = $1",
      [old],
    );
    await t.pool.query("insert into trashed_clients (client_id, user_id) values ($1, $2)", [
      old,
      boss,
    ]);
    const live = await insertClient(t.db, boss, "New Pizza");
    await t.pool.query("update clients set email = 'mike@dup.com' where id = $1", [live]);
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, can_read_mail) values ($1, 'boss@gmail.com', 'enc', true)",
      [boss],
    );
    const note = Buffer.from("x");
    const files: string[] = [];
    const big = {
      filename: "huge.pdf",
      mimeType: "application/pdf",
      size: 30 * 1024 * 1024,
      attachmentId: "big1",
    };
    const msg = {
      id: "d1",
      threadId: "td1",
      historyId: "500",
      internalDate: String(Date.now() - 60_000),
      snippet: "docs attached",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Mike <mike@dup.com>" },
          { name: "To", value: "boss@gmail.com" },
          { name: "Subject", value: "Re: docs" },
          { name: "Message-ID", value: "<d1@mail.test>" },
          {
            name: "Authentication-Results",
            value: "mx.google.com; spf=pass smtp.mailfrom=dup.com; dkim=pass header.d=dup.com",
          },
        ],
        parts: [
          { mimeType: "text/plain", body: { data: note.toString("base64url") } },
          {
            mimeType: big.mimeType,
            filename: big.filename,
            body: { attachmentId: big.attachmentId, size: big.size },
          },
        ],
      },
    };
    const gmail = (async (url: string | URL | Request) => {
      const u = String(url);
      files.push(u);
      if (/\/messages\?/.test(u)) return json({ messages: [{ id: "d1", threadId: "td1" }] });
      if (/\/messages\/d1\?format=full/.test(u)) return json(msg);
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const s = await syncInbox({
      db: t.db,
      tokenFor: async () => "tok",
      fetchImpl: gmail,
      now: new Date(),
    });
    expect(s.merchantReplies).toEqual([live]);
    const stored = await t.pool.query<{ client_id: string }>(
      "select client_id from inbound_emails where gmail_id = 'd1'",
    );
    expect(stored.rows).toEqual([{ client_id: live }]);
    // the 30 MB attachment was not filed, and the rep can see that on the merchant's timeline (email-pipeline-7)
    expect(files.some((u) => u.includes("/attachments/"))).toBe(false);
    const acts = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'system'",
      [live],
    );
    expect(acts.rows.some((r) => r.body.includes("huge.pdf (over 25 MB)"))).toBe(true);
  });

  it("a Resend event that fails in SQL is stored with its error, not thrown (email-pipeline-12)", async () => {
    // a delivered event for a send we know: the update on its outbox row fails inside the handler
    const c = await insertClient(t.db, rep, "Boom Co");
    await t.pool.query(
      "insert into outbox (user_id, client_id, lane, to_address, subject, text_body, status, provider, provider_id) values ($1, $2, 'intake', 'a@boom.com', 's', 't', 'sent', 'resend', 'e1')",
      [rep, c],
    );
    await t.pool.query(
      `create function public.test_boom2() returns trigger language plpgsql as $$ begin raise exception 'delivery boom'; end $$`,
    );
    await t.pool.query(
      "create trigger test_boom2 before update on outbox for each row execute function public.test_boom2()",
    );
    let r: { result: string };
    try {
      r = await handleResendEvent(t.db, "evt_boom", {
        type: "email.delivered",
        data: { email_id: "e1" },
      });
    } finally {
      await t.pool.query("drop trigger test_boom2 on outbox");
    }
    expect(r.result).toContain("error: delivery boom");
    const row = await t.pool.query<{ result: string; handled_at: Date | null }>(
      "select result, handled_at from webhook_events where event_id = 'evt_boom'",
    );
    expect(row.rows[0]?.result).toContain("delivery boom");
    expect(row.rows[0]?.handled_at).not.toBeNull();
  });
});
