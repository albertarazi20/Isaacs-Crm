import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopEmailsForGood, turnEmailsBackOn } from "@/lib/approvals/hardStop";
import { syncInbox } from "@/lib/inbox/sync";
import { enqueueEmail } from "@/lib/send/enqueue";
import {
  applyUnverifiedStop,
  handleResendEvent,
  recordMerchantReply,
  resolveUnsubscribe,
  unsubscribeByToken,
} from "@/lib/system/replies";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * A merchant's own wish must be recorded even when a rep's hand stop came first. A hand stop sets the opt-out flag and
 * a 'manual' suppression; the unsubscribe link, a STOP reply (verified or not, by Resend or Gmail), the AI "stop" tag
 * and a complaint used to skip a merchant who was "already opted out", so a manager's "turn emails back on" could
 * re-enable mail to someone who had asked not to be emailed. Every claim is read back from the DATABASE.
 */

let t: TestDb;
let rep: string;
let boss: string;
let dir: string;
const REP = { userId: "", email: "rep@crm.test" };
const BOSS = { userId: "", email: "boss@crm.test" };

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as T;
const many = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as T[];

let n = 0;
/** A merchant (with an address) whose rep has stopped their emails for good. */
async function handStopped(): Promise<{ id: string; email: string; token: string }> {
  n += 1;
  const email = `owner${n}@shop${n}.test`;
  const { id, token } = await one<{ id: string; token: string }>(
    `insert into clients (user_id, business_name, contact_name, phone, email, state)
     values ($1, $2, 'rosa diaz', $3, $4, 'FL') returning id, unsubscribe_token as token`,
    [rep, `Shop ${n}`, `30555507${String(n).padStart(2, "0")}`, email],
  );
  await stopEmailsForGood(t.db, REP, id);
  return { id, email, token };
}

const state = (id: string) =>
  one<{ email_opt_out: boolean; stopped: boolean }>(
    "select email_opt_out, emails_stopped_at is not null as stopped from clients where id = $1",
    [id],
  );
const reasons = async (id: string) =>
  (
    await many<{ reason: string }>(
      "select reason from suppressions where client_id = $1 order by reason",
      [id],
    )
  ).map((r) => r.reason);

/** Turning the emails back on is refused, in words, and nothing changes. */
async function expectCannotTurnOn(id: string) {
  await expect(turnEmailsBackOn(t.db, BOSS, id)).rejects.toMatchObject({
    code: "22023",
    message: expect.stringMatching(/also asked not to be emailed/),
  });
  expect(await state(id)).toEqual({ email_opt_out: true, stopped: true });
  expect(await reasons(id)).not.toContain("manual");
}

/** An email already sent to the merchant, for a provider event to point at. */
const sentEmail = (id: string, email: string, providerId: string) =>
  t.pool.query(
    `insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body, status, sent_at, provider, provider_id)
     values ($1, $2, 'sequence', $3, $4, 'Hello', 'Hi', 'sent', now(), 'resend', $5)`,
    [rep, id, `bucket:test:step:1:${providerId}`, email, providerId],
  );

beforeAll(async () => {
  t = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "isaac-hs-"));
  process.env.DATABASE_URL = "postgres://unused@localhost/unused";
  process.env.SESSION_SECRET = "s".repeat(40);
  process.env.DOCS_DIR = dir;
  rep = await insertUser(t.pool, REP.email, "America/New_York");
  boss = await insertUser(t.pool, BOSS.email);
  REP.userId = rep;
  BOSS.userId = boss;
  await t.pool.query("update app_users set role = 'manager', name = 'amy boss' where id = $1", [
    boss,
  ]);
  await t.pool.query(
    "insert into gmail_connections (user_id, google_email, refresh_token_enc, can_read_mail) values ($1, 'boss@gmail.com', 'enc', true)",
    [boss],
  );
});
afterAll(async () => {
  await t.drop();
  rmSync(dir, { recursive: true, force: true });
});

describe("a hand stop, then the merchant's own unsubscribe", () => {
  it("the page does not call them already unsubscribed; the click makes the suppression theirs, and turning emails back on is refused", async () => {
    const m = await handStopped();
    expect(await reasons(m.id)).toEqual(["manual"]);
    expect(await resolveUnsubscribe(t.db, m.token)).toMatchObject({
      clientId: m.id,
      already: false,
    });

    expect(await unsubscribeByToken(t.db, m.token, "page")).toBe(true);
    expect(await reasons(m.id)).toEqual(["unsubscribe"]);
    expect(await state(m.id)).toEqual({ email_opt_out: true, stopped: true });
    expect(
      await one<{ n: number }>(
        "select count(*)::int as n from activities where client_id = $1 and body like 'Opted out of email (unsubscribe)%'",
        [m.id],
      ),
    ).toEqual({ n: 1 });
    await expectCannotTurnOn(m.id);

    // now they really are unsubscribed: the page says so, and a second click records nothing more
    expect(await resolveUnsubscribe(t.db, m.token)).toMatchObject({ already: true });
    expect(await unsubscribeByToken(t.db, m.token, "one_click")).toBe(true);
    expect(
      await one<{ n: number }>(
        "select count(*)::int as n from activities where client_id = $1 and body like 'Opted out of email (unsubscribe)%'",
        [m.id],
      ),
    ).toEqual({ n: 1 });
  });

  it("the one-click POST from the mail client does the same", async () => {
    const m = await handStopped();
    expect(await unsubscribeByToken(t.db, m.token, "one_click")).toBe(true);
    expect(await reasons(m.id)).toEqual(["unsubscribe"]);
    await expectCannotTurnOn(m.id);
  });

  it("an ordinary unsubscribe, with no hand stop, is unchanged", async () => {
    n += 1;
    const { id, token } = await one<{ id: string; token: string }>(
      `insert into clients (user_id, business_name, contact_name, phone, email, state)
       values ($1, $2, 'rosa diaz', '3055550999', $3, 'FL') returning id, unsubscribe_token as token`,
      [rep, `Shop ${n}`, `plain${n}@shop.test`],
    );
    expect(await resolveUnsubscribe(t.db, token)).toMatchObject({ already: false });
    expect(await unsubscribeByToken(t.db, token, "page")).toBe(true);
    expect(await reasons(id)).toEqual(["unsubscribe"]);
    expect(await state(id)).toEqual({ email_opt_out: true, stopped: false });
    expect(await resolveUnsubscribe(t.db, token)).toMatchObject({ already: true });
    // a manager has nothing to turn back on: it is not a hand stop
    expect(await turnEmailsBackOn(t.db, BOSS, id)).toEqual({ changed: false });
    expect(await state(id)).toEqual({ email_opt_out: true, stopped: false });
  });
});

describe("a hand stop, then a STOP reply", () => {
  it("a verified STOP (recordMerchantReply: Gmail sync and Resend inbound) is the merchant's own", async () => {
    const m = await handStopped();
    const r = await recordMerchantReply(t.db, {
      clientId: m.id,
      subject: "Re: your approval",
      snippet: "STOP",
      from: m.email,
    });
    expect(r.stop).toBe(true);
    expect(await reasons(m.id)).toEqual(["stop_reply"]);
    await expectCannotTurnOn(m.id);
  });

  it("an unverified STOP through Resend is applied and is the merchant's own", async () => {
    const m = await handStopped();
    expect(
      await handleResendEvent(t.db, `evt_u_${m.id}`, {
        type: "email.received",
        data: {
          from: `Fwd <${m.email}>`,
          subject: "Re: docs",
          text: "Stop\n\nSent from my iPhone",
        },
      }),
    ).toEqual({ result: "received:unverified_stop" });
    expect(await reasons(m.id)).toEqual(["stop_reply"]);
    await expectCannotTurnOn(m.id);
    // the timeline says it came from an unverified sender, once
    expect(
      await one<{ n: number }>(
        "select count(*)::int as n from activities where client_id = $1 and body like 'Opted out of email from an unverified sender%'",
        [m.id],
      ),
    ).toEqual({ n: 1 });
  });

  it("applyUnverifiedStop on a hand-stopped merchant reports that it applied, and a second call does nothing more", async () => {
    const m = await handStopped();
    expect(await t.db.withSystem((q) => applyUnverifiedStop(q, m.id, m.email, "stop"))).toBe(true);
    expect(await reasons(m.id)).toEqual(["stop_reply"]);
    expect(await t.db.withSystem((q) => applyUnverifiedStop(q, m.id, m.email, "stop"))).toBe(false);
  });

  it("the AI 'stop' tag on a reply is applied to a hand-stopped merchant", async () => {
    const m = await handStopped();
    const email = await one<{ id: string }>(
      `insert into inbound_emails (mailbox_user_id, gmail_id, client_id, from_address, subject, snippet, received_at)
       values ($1, $2, $3, $4, 'Re: approval', 'please take me off your list', now()) returning id`,
      [rep, `g-${m.id}`, m.id, m.email],
    );
    await t.db.withSystem((q) =>
      q.query("select apply_reply_tag($1, 'stop', 0.95, 'take me off your list', true, 'test')", [
        email.id,
      ]),
    );
    expect(await reasons(m.id)).toEqual(["stop_reply"]);
    await expectCannotTurnOn(m.id);
  });

  it("the AI 'stop' tag on a merchant who is not opted out, or already opted out themselves, is unchanged", async () => {
    n += 1;
    const plain = await one<{ id: string }>(
      `insert into clients (user_id, business_name, contact_name, phone, email, state)
       values ($1, $2, 'rosa diaz', '3055550998', $3, 'FL') returning id`,
      [rep, `Shop ${n}`, `plain${n}@shop.test`],
    );
    const email = await one<{ id: string }>(
      `insert into inbound_emails (mailbox_user_id, gmail_id, client_id, from_address, subject, snippet, received_at)
       values ($1, $2, $3, 'x@y.test', 'Re', 'stop', now()) returning id`,
      [rep, `g-${plain.id}`, plain.id],
    );
    const tag = () =>
      t.db.withSystem((q) =>
        q.query("select apply_reply_tag($1, 'stop', 0.95, 'stop', true, 'test')", [email.id]),
      );
    await tag();
    expect(await reasons(plain.id)).toEqual(["stop_reply"]);
    expect(await state(plain.id)).toEqual({ email_opt_out: true, stopped: false });
    await tag();
    expect(
      await one<{ n: number }>(
        "select count(*)::int as n from activities where client_id = $1 and body like 'Opted out of email (stop reply)%'",
        [plain.id],
      ),
    ).toEqual({ n: 1 });
  });
});

describe("a hand stop, then a complaint or a bounce", () => {
  it("a spam complaint is the merchant's own wish", async () => {
    const m = await handStopped();
    await sentEmail(m.id, m.email, `em_c_${m.id}`);
    expect(
      await handleResendEvent(t.db, `evt_c_${m.id}`, {
        type: "email.complained",
        data: { email_id: `em_c_${m.id}` },
      }),
    ).toEqual({ result: "complaint" });
    expect(await reasons(m.id)).toEqual(["complaint"]);
    await expectCannotTurnOn(m.id);
  });

  it("a hard bounce is not a wish, but it keeps the address blocked when a manager turns the emails back on", async () => {
    const m = await handStopped();
    await sentEmail(m.id, m.email, `em_b_${m.id}`);
    expect(
      await handleResendEvent(t.db, `evt_b_${m.id}`, {
        type: "email.bounced",
        data: { email_id: `em_b_${m.id}`, bounce: { type: "Permanent", message: "no such user" } },
      }),
    ).toEqual({ result: "hard_bounce" });
    expect(await reasons(m.id)).toEqual(["hard_bounce"]);
    expect(await turnEmailsBackOn(t.db, BOSS, m.id)).toEqual({ changed: true });
    expect(await state(m.id)).toEqual({ email_opt_out: false, stopped: false });
    // the bounced address is still refused
    expect(await reasons(m.id)).toEqual(["hard_bounce"]);
    expect(
      await t.db.withUser(rep, (q) =>
        enqueueEmail(q, { clientId: m.id, lane: "intake", source: "i:b", subject: "s", text: "t" }),
      ),
    ).toEqual({ queued: false, reason: "suppressed" });
  });

  it("hand stop, then a bounce, then the merchant's own unsubscribe: the wish replaces the bounce and cannot be undone", async () => {
    const m = await handStopped();
    await sentEmail(m.id, m.email, `em_bu_${m.id}`);
    await handleResendEvent(t.db, `evt_bu_${m.id}`, {
      type: "email.bounced",
      data: { email_id: `em_bu_${m.id}`, bounce: { type: "Permanent" } },
    });
    expect(await reasons(m.id)).toEqual(["hard_bounce"]);
    expect(await unsubscribeByToken(t.db, m.token, "page")).toBe(true);
    expect(await reasons(m.id)).toEqual(["unsubscribe"]);
    await expectCannotTurnOn(m.id);
  });

  it("a bounce on a merchant with no hand stop keeps its own reason, and a later unsubscribe does not rewrite it", async () => {
    n += 1;
    const { id, token, email } = await one<{ id: string; token: string; email: string }>(
      `insert into clients (user_id, business_name, contact_name, phone, email, state)
       values ($1, $2, 'rosa diaz', '3055550997', $3, 'FL') returning id, unsubscribe_token as token, email`,
      [rep, `Shop ${n}`, `bounce${n}@shop.test`],
    );
    await sentEmail(id, email, `em_p_${id}`);
    await handleResendEvent(t.db, `evt_p_${id}`, {
      type: "email.bounced",
      data: { email_id: `em_p_${id}`, bounce: { type: "Permanent" } },
    });
    await unsubscribeByToken(t.db, token, "page");
    expect(await reasons(id)).toEqual(["hard_bounce"]);
    expect(await state(id)).toEqual({ email_opt_out: true, stopped: false });
  });
});

describe("the Gmail inbox sync", () => {
  it("a verified STOP and an unverified STOP from hand-stopped merchants are both recorded as the merchant's own", async () => {
    const verified = await handStopped();
    const forged = await handStopped();
    const b64url = (s: string) => Buffer.from(s).toString("base64url");
    const message = (id: string, from: string, auth: string, history: string) => ({
      id,
      threadId: `t-${id}`,
      historyId: history,
      internalDate: String(Date.now() - 60_000),
      snippet: "STOP",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: from },
          { name: "To", value: "boss@selectivecap.com" },
          { name: "Subject", value: "Re: your approval" },
          { name: "Message-ID", value: `<${id}@mail.test>` },
          { name: "Authentication-Results", value: auth },
        ],
        body: { data: b64url("STOP") },
      },
    });
    const msgs: Record<string, ReturnType<typeof message>> = {
      v1: message(
        "v1",
        `Rosa <${verified.email}>`,
        `mx.google.com; spf=pass smtp.mailfrom=${verified.email.split("@")[1]}; dkim=pass header.i=@${verified.email.split("@")[1]}`,
        "201",
      ),
      f1: message("f1", `Rosa <${forged.email}>`, "mx.google.com; spf=fail; dkim=none", "202"),
    };
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (/\/messages\?/.test(u))
        return new Response(
          JSON.stringify({
            messages: Object.keys(msgs).map((id) => ({ id, threadId: `t-${id}` })),
          }),
          { status: 200 },
        );
      const m = /\/messages\/([^/?]+)\?format=full/.exec(u);
      const found = m ? msgs[m[1] ?? ""] : undefined;
      return found
        ? new Response(JSON.stringify(found), { status: 200 })
        : new Response("not found", { status: 404 });
    }) as typeof fetch;
    const s = await syncInbox({
      db: t.db,
      tokenFor: async () => "tok",
      fetchImpl,
      now: new Date(),
    });
    expect(s).toMatchObject({ fetched: 2, unverified: 1, failed: [] });
    expect(s.merchantReplies).toEqual([verified.id]);
    for (const m of [verified, forged]) {
      expect(await reasons(m.id)).toEqual(["stop_reply"]);
      await expectCannotTurnOn(m.id);
    }
  });
});
