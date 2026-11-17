import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signSvix, verifySvix } from "@/lib/email/svix";
import { buildRawEmail } from "@/lib/email/raw";
import { nowItems } from "@/lib/dashboard/queries";
import { isStopMessage, ownWords } from "@/lib/messaging/stop";
import {
  addressOf,
  handleResendEvent,
  recordMerchantReply,
  resolveUnsubscribe,
  sendReplyAlerts,
  unsubscribeByToken,
} from "@/lib/system/replies";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

describe("stop detection", () => {
  it("reads the merchant's own words, not our quoted footer", () => {
    const reply =
      "STOP\n\nOn Mon, Nov 10, 2026 at 9:02 AM Josh <josh@selectivecap.com> wrote:\n> Hi Mike,\n> To stop these emails: https://x/u/abc";
    expect(ownWords(reply)).toBe("STOP");
    expect(isStopMessage("Re: Your statements", reply)).toBe(true);
    expect(isStopMessage("Re: Your statements", "please take me off your list")).toBe(true);
    expect(isStopMessage("Unsubscribe", "")).toBe(true);
    expect(
      isStopMessage(
        "Re: Your statements",
        "Hey, I'll send October over tomorrow once the bank posts it.",
      ),
    ).toBe(false);
    // a long real message that mentions "stop" in passing is a conversation
    expect(
      isStopMessage(
        "Re: offer",
        `${"We had to stop the second truck for repairs. ".repeat(10)}Can you send the contracts?`,
      ),
    ).toBe(false);
    // the footer alone, quoted, never counts
    expect(isStopMessage("Re: hi", "> To stop these emails: https://x/u/abc")).toBe(false);
  });
  it("pulls the address out of a From header", () => {
    expect(addressOf("Mike Pizza <Mike@Pizza.com>")).toBe("mike@pizza.com");
    expect(addressOf("mike@pizza.com")).toBe("mike@pizza.com");
    expect(addressOf("nobody")).toBe("");
  });
});

describe("svix signatures", () => {
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "em_1" } });
  const ts = String(1_700_000_000);
  it("accepts a fresh, correctly signed body and nothing else", () => {
    const sig = signSvix(secret, "msg_1", ts, body);
    const h = { id: "msg_1", timestamp: ts, signature: `v1,${sig}` };
    expect(verifySvix(secret, h, body, 1_700_000_100)).toBe(true);
    expect(verifySvix(secret, { ...h, signature: `v1,abc v1,${sig}` }, body, 1_700_000_100)).toBe(
      true,
    );
    expect(verifySvix(secret, h, body.replace("em_1", "em_2"), 1_700_000_100)).toBe(false);
    expect(verifySvix(secret, h, body, 1_700_001_000)).toBe(false); // too old
    expect(verifySvix(`whsec_${randomBytes(24).toString("base64")}`, h, body, 1_700_000_100)).toBe(
      false,
    );
    expect(
      verifySvix(secret, { id: null, timestamp: ts, signature: `v1,${sig}` }, body, 1_700_000_100),
    ).toBe(false);
  });
});

describe("one-click unsubscribe headers", () => {
  it("ride in the raw Gmail message and are validated", () => {
    const raw = Buffer.from(
      buildRawEmail({
        from: "rep@x.com",
        to: "mike@pizza.com",
        subject: "Hi",
        text: "x",
        headers: {
          "List-Unsubscribe": "<https://x/api/unsubscribe/t>",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
      "base64url",
    ).toString("utf8");
    expect(raw).toContain("List-Unsubscribe: <https://x/api/unsubscribe/t>\r\n");
    expect(raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n");
    expect(() =>
      buildRawEmail({
        from: "a@b.co",
        to: "c@d.co",
        subject: "s",
        text: "t",
        headers: { "Bad Name": "x" },
      }),
    ).toThrow(/bad header name/);
    expect(() =>
      buildRawEmail({
        from: "a@b.co",
        to: "c@d.co",
        subject: "s",
        text: "t",
        headers: { "X-A": "x\r\nBcc: e@f.co" },
      }),
    ).toThrow(/line break/);
  });
});

describe("replies, bounces, unsubscribes", () => {
  let t: TestDb;
  let rep: string;
  let pizza: string;
  let taco: string;
  let burger: string;
  let bucket: string;

  const enrol = (client: string) =>
    t.pool.query("select enroll_in_bucket($1, $2, 'moved')", [client, bucket]);
  const enrolment = async (client: string) =>
    (
      await t.pool.query<{ stop_reason: string | null }>(
        "select stop_reason from enrollments where client_id = $1 order by created_at desc limit 1",
        [client],
      )
    ).rows[0];
  const client = async (id: string) =>
    (
      await t.pool.query<{
        reply_waiting_since: string | null;
        reply_waiting_subject: string;
        email_opt_out: boolean;
        email_bounced_at: string | null;
      }>(
        "select reply_waiting_since::text, reply_waiting_subject, email_opt_out, email_bounced_at::text from clients where id = $1",
        [id],
      )
    ).rows[0]!;

  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    await t.pool.query("update app_users set name = 'Josh' where id = $1", [rep]);
    pizza = await insertClient(t.db, rep, "Pizza Palace");
    taco = await insertClient(t.db, rep, "Taco Town");
    burger = await insertClient(t.db, rep, "Burger Barn");
    await t.pool.query("update clients set email = 'mike@pizza.com' where id = $1", [pizza]);
    await t.pool.query("update clients set email = 'tina@taco.com' where id = $1", [taco]);
    await t.pool.query("update clients set email = 'bob@burger.com' where id = $1", [burger]);
    bucket = (
      await t.pool.query<{ id: string }>(
        "select id from buckets where key = 'missing_statements' limit 1",
      )
    ).rows[0]!.id;
    await enrol(pizza);
    await enrol(taco);
    await enrol(burger);
  });
  afterAll(async () => {
    await t.drop();
  });

  it("a reply stops the sequence, flags the merchant, tops the now-list, and the rep's call clears it", async () => {
    const r = await recordMerchantReply(t.db, {
      clientId: pizza,
      subject: "Re: October statement",
      snippet: "Sending it tonight",
      from: "mike@pizza.com",
    });
    expect(r.stop).toBe(false);
    expect((await enrolment(pizza))?.stop_reason).toBe("replied");
    const c = await client(pizza);
    expect(c.reply_waiting_since).not.toBeNull();
    expect(c.reply_waiting_subject).toBe("Re: October statement");
    const act = await t.pool.query<{ body: string; kind: string }>(
      "select body, kind from activities where client_id = $1 order by occurred_at desc limit 1",
      [pizza],
    );
    expect(act.rows[0]).toMatchObject({
      kind: "email",
      body: "Merchant replied: Re: October statement — Sending it tonight (mike@pizza.com)",
    });

    const now = await t.db.withUser(rep, (q) => nowItems(q, t.today));
    expect(now[0]).toMatchObject({
      kind: "merchant_replied",
      business_name: "Pizza Palace",
      detail: "Re: October statement",
    });

    // the rep logs a call → the flag clears; the system's own rows never clear it
    await t.db.withUser(rep, (q) =>
      q.query(
        "insert into activities (user_id, client_id, kind, outcome, body) values ($1, $2, 'call', 'reached', 'got it')",
        [rep, pizza],
      ),
    );
    expect((await client(pizza)).reply_waiting_since).toBeNull();
    const after = await t.db.withUser(rep, (q) => nowItems(q, t.today));
    expect(after.some((n) => n.kind === "merchant_replied")).toBe(false);
  });

  it("a STOP reply opts the merchant out and suppresses the address", async () => {
    const r = await recordMerchantReply(t.db, {
      clientId: taco,
      subject: "Re: statements",
      snippet: "STOP",
      from: "tina@taco.com",
      text: "STOP\n> To stop these emails: x",
    });
    expect(r.stop).toBe(true);
    expect((await client(taco)).email_opt_out).toBe(true);
    const sup = await t.pool.query<{ reason: string }>(
      "select reason from suppressions where display = 'tina@taco.com'",
    );
    expect(sup.rows[0]?.reason).toBe("stop_reply");
  });

  it("Resend events: bounce suppresses and stops, complaint opts out, delivered is noted, retries are no-ops", async () => {
    await t.pool.query(
      `insert into outbox (user_id, client_id, lane, to_address, subject, text_body, status, provider, provider_id, sent_at)
       values ($1, $2, 'sequence', 'bob@burger.com', 'Hi', 'x', 'sent', 'resend', 'em_bounce', now()),
              ($1, $2, 'sequence', 'bob@burger.com', 'Hi 2', 'x', 'sent', 'resend', 'em_ok', now()),
              ($1, $2, 'sequence', 'bob@burger.com', 'Hi 3', 'x', 'queued', null, null, null)`,
      [rep, burger],
    );
    expect(
      await handleResendEvent(t.db, "evt_ok", {
        type: "email.delivered",
        data: { email_id: "em_ok" },
      }),
    ).toEqual({ result: "delivered" });
    expect(
      (
        await t.pool.query<{ s: string }>(
          "select delivery_status as s from outbox where provider_id = 'em_ok'",
        )
      ).rows[0]?.s,
    ).toBe("delivered");

    expect(
      await handleResendEvent(t.db, "evt_b", {
        type: "email.bounced",
        data: {
          email_id: "em_bounce",
          bounce: { type: "Permanent", subType: "General", message: "mailbox does not exist" },
        },
      }),
    ).toEqual({ result: "hard_bounce" });
    const c = await client(burger);
    expect(c.email_bounced_at).not.toBeNull();
    expect((await enrolment(burger))?.stop_reason).toBe("bounced");
    expect(
      (
        await t.pool.query<{ reason: string }>(
          "select reason from suppressions where display = 'bob@burger.com'",
        )
      ).rows[0]?.reason,
    ).toBe("hard_bounce");
    expect(
      (
        await t.pool.query<{ n: number }>(
          "select count(*)::int as n from outbox where client_id = $1 and status = 'cancelled'",
          [burger],
        )
      ).rows[0]?.n,
    ).toBe(1);
    // the same event again does nothing
    expect(
      await handleResendEvent(t.db, "evt_b", {
        type: "email.bounced",
        data: { email_id: "em_bounce" },
      }),
    ).toEqual({ result: "duplicate" });
    // an unknown email id is kept but changes nothing
    expect(
      await handleResendEvent(t.db, "evt_x", {
        type: "email.bounced",
        data: { email_id: "em_nobody" },
      }),
    ).toEqual({ result: "bounce:unknown_email" });
    expect(await handleResendEvent(t.db, "evt_new", { type: "email.opened", data: {} })).toEqual({
      result: "ignored",
    });
    expect(
      (await t.pool.query<{ n: number }>("select count(*)::int as n from webhook_events")).rows[0]
        ?.n,
    ).toBe(4);

    // complaint → full opt-out
    expect(
      await handleResendEvent(t.db, "evt_c", {
        type: "email.complained",
        data: { email_id: "em_ok" },
      }),
    ).toEqual({ result: "complaint" });
    expect((await client(burger)).email_opt_out).toBe(true);
  });

  it("an inbound email on the automation domain is a merchant reply", async () => {
    await t.pool.query("update clients set reply_waiting_since = null where id = $1", [pizza]);
    // a From header alone is not the merchant: no SPF/DKIM and no reply to mail we sent → nothing changes
    expect(
      await handleResendEvent(t.db, "evt_in0", {
        type: "email.received",
        data: { from: "Mike <mike@pizza.com>", subject: "unsubscribe", text: "STOP" },
      }),
    ).toEqual({ result: "received:unverified_sender" });
    expect((await client(pizza)).reply_waiting_subject).toBe("");
    expect((await client(pizza)).email_opt_out).toBe(false);
    expect(
      await handleResendEvent(t.db, "evt_in", {
        type: "email.received",
        data: {
          from: "Mike <mike@pizza.com>",
          subject: "Re: docs",
          text: "attached!",
          headers: [
            {
              name: "Authentication-Results",
              value: "mx.resend.com; spf=pass; dkim=pass header.d=pizza.com",
            },
          ],
        },
      }),
    ).toEqual({ result: "received:reply" });
    expect((await client(pizza)).reply_waiting_subject).toBe("Re: docs");
    expect(
      await handleResendEvent(t.db, "evt_in2", {
        type: "email.received",
        data: { from: "stranger@nowhere.com", subject: "hi" },
      }),
    ).toEqual({ result: "received:unknown_sender" });
  });

  it("the footer token unsubscribes once, idempotently, and the page can describe it without leaking the address", async () => {
    const token = (
      await t.pool.query<{ u: string }>(
        "select unsubscribe_token as u from clients where id = $1",
        [pizza],
      )
    ).rows[0]!.u;
    const v = await resolveUnsubscribe(t.db, token);
    expect(v).toMatchObject({
      businessName: "Pizza Palace",
      already: false,
      shopName: "Selective Capital",
    });
    expect(v?.maskedEmail).toMatch(/^m•+@pizza\.com$/);
    expect(await unsubscribeByToken(t.db, token, "one_click")).toBe(true);
    expect((await client(pizza)).email_opt_out).toBe(true);
    expect((await resolveUnsubscribe(t.db, token))?.already).toBe(true);
    expect(await unsubscribeByToken(t.db, token, "page")).toBe(true);
    expect(
      (
        await t.pool.query<{ n: number }>(
          "select count(*)::int as n from suppressions where client_id = $1 and reason = 'unsubscribe'",
          [pizza],
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(await unsubscribeByToken(t.db, "nope", "page")).toBe(false);
    expect(await resolveUnsubscribe(t.db, "a".repeat(48))).toBeNull();
  });

  it("the rep gets one alert per merchant per day", async () => {
    await t.pool.query("update clients set reply_waiting_subject = 'Re: docs' where id = $1", [
      pizza,
    ]);
    const sent: { to: string; subject: string }[] = [];
    const send = async (to: string, d: { subject: string }) => {
      sent.push({ to, subject: d.subject });
      return `re_${sent.length}`;
    };
    const now = new Date();
    expect(
      await sendReplyAlerts(t.db, [pizza, pizza], { now, appUrl: "https://crm.test", send }),
    ).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(sent[0]).toEqual({ to: "rep@x.com", subject: "Pizza Palace replied: Re: docs" });
    expect(await sendReplyAlerts(t.db, [pizza], { now, appUrl: "https://crm.test", send })).toEqual(
      { sent: 0, skipped: 1, failed: 0 },
    );
    const row = await t.pool.query<{ kind: string; provider_id: string }>(
      "select kind, provider_id from reminders_sent where ref = $1",
      [pizza],
    );
    expect(row.rows[0]).toEqual({ kind: "reply", provider_id: "re_1" });
  });
});
