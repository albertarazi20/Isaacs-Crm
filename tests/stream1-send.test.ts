import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTemplateApproved } from "@/lib/buckets/templates";
import { checkClaims } from "@/lib/messaging/claims";
import { automationDomain, checkAutomationDns, storeDnsCheck } from "@/lib/send/dns";
import { enqueueEmail } from "@/lib/send/enqueue";
import type { Lane } from "@/lib/send/rules";
import { drainOutbox, type Deliverer } from "@/lib/send/worker";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Stream 1 (docs/AUTOMATION-AUDIT.md): the send engine.
 *   S1-2  Pause and Delete reach the outbox.
 *   S1-15 The claim checker on templates and automated sends.
 *   S1-4  The DNS gate before the Resend branch.
 *   S1-5  The Resend branch itself: mailbox kind, reply-to the rep, the ledger.
 */

let t: TestDb;
let rep: string;
let manager: string;
const sent: { via: string; to: string; subject: string; text: string; replyTo?: string }[] = [];
const deliver: Deliverer = {
  gmail: async (_u, m) => (sent.push({ via: "gmail", ...m }), `g_${sent.length}`),
  resend: async (m) => (
    sent.push({ via: "resend", to: m.to, subject: m.subject, text: m.text, replyTo: m.replyTo }),
    `r_${sent.length}`
  ),
};

const client = async (name: string, email: string, state = "FL") =>
  (
    await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Owner', '3055550100', $3, $4) returning id",
      [rep, name, email, state],
    )
  ).rows[0]!.id;
const bucket = async (key: string) =>
  (await t.pool.query<{ id: string }>("select id from buckets where key = $1", [key])).rows[0]!.id;
const outbox = async (id: string) =>
  (
    await t.pool.query<{
      status: string;
      skip_reason: string | null;
      last_error: string | null;
      provider: string | null;
      not_before: string;
    }>(
      "select status, skip_reason, last_error, provider, not_before::text from outbox where id = $1",
      [id],
    )
  ).rows[0]!;
const queue = (clientId: string, source: string, text: string, lane: Lane = "sequence") =>
  t.db.withUser(rep, async (q) => {
    const r = await enqueueEmail(q, {
      clientId,
      lane,
      source,
      subject: "Hello",
      text,
      when: "now",
    });
    if (!r.queued) throw new Error(`not queued: ${r.reason}`);
    return r.outboxId;
  });
// a few seconds of slack: rows released with the database's now() must be due on the worker's clock too
const drain = (now = new Date(Date.now() + 5_000)) =>
  drainOutbox({ db: t.db, deliver, now, appUrl: "https://crm.test" });

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  await t.pool.query(
    "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status) values ($1, 'rep@selectivecap.com', 'enc', 'send', 'ok')",
    [rep],
  );
  manager = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set role = 'manager' where id = $1", [manager]);
  await t.pool.query(
    "update shop_settings set postal_address = '1 Main St, Miami FL 33101', per_merchant_daily = 5, per_merchant_weekly = 20",
  );
});
afterAll(async () => {
  await t.drop();
});

describe("S1-2: Pause and Delete reach the outbox", () => {
  it("a paused enrolment's queued step is held by the worker and goes out after the resume", async () => {
    const id = await client("Pause Co", "pause@x.com");
    const b = await bucket("interested");
    await t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [id, b]));
    const row = await queue(id, `bucket:${b}:step:2`, "Checking in on the funding");
    const n = await t.db.withUser(
      rep,
      async (q) =>
        (await q.query<{ n: number }>("select set_enrollment_paused($1, true) as n", [id])).rows[0]
          ?.n,
    );
    expect(n).toBe(1);
    let o = await outbox(row);
    expect(o.status).toBe("queued");
    expect(o.last_error).toBe("paused");
    // the hold pushed not_before an hour out; a drain past that still holds it while the pause stands
    const later = new Date(Date.now() + 2 * 3_600_000);
    const held = await drain(later);
    expect(held.deferred).toBe(1);
    expect(held.sent).toBe(0);
    o = await outbox(row);
    expect(o).toMatchObject({ status: "queued", last_error: "paused" });
    const paused = await t.pool.query<{ paused: boolean }>(
      "select paused from enrollments where client_id = $1 and stopped_at is null",
      [id],
    );
    expect(paused.rows[0]?.paused).toBe(true);

    await t.db.withUser(rep, (q) => q.query("select set_enrollment_paused($1, false)", [id]));
    o = await outbox(row);
    expect(o.last_error).toBeNull();
    const s = await drain();
    expect(s.sent).toBe(1);
    expect((await outbox(row)).status).toBe("sent");
    const lines = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'system' order by occurred_at",
      [id],
    );
    expect(lines.rows.map((r) => r.body)).toContain("Follow-up emails paused");
    expect(lines.rows.map((r) => r.body)).toContain("Follow-up emails resumed");
  });

  it("trash_client cancels every queued email and ends the enrolment; the worker refuses a trashed merchant's row", async () => {
    const id = await client("Trash Co", "trash@x.com");
    const b = await bucket("missing_statements");
    await t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [id, b]));
    const seq = await queue(id, `bucket:${b}:step:2`, "Still missing statements");
    const intake = await queue(id, "intake", "Welcome", "intake");
    await t.db.withUser(rep, (q) => q.query("select trash_client($1)", [id]));
    expect(await outbox(seq)).toMatchObject({ status: "cancelled", skip_reason: "trashed" });
    expect(await outbox(intake)).toMatchObject({ status: "cancelled", skip_reason: "trashed" });
    const e = await t.pool.query<{ stop_reason: string | null }>(
      "select stop_reason from enrollments where client_id = $1 and stopped_at is not null",
      [id],
    );
    expect(e.rows[0]?.stop_reason).toBe("removed");
    await expect(
      t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [id, b])),
    ).rejects.toThrow(/in the trash/);

    // a row queued before the merchant was trashed by some other path: the worker cancels it, nothing is sent
    const other = await client("Stale Co", "stale@x.com");
    const row = await queue(other, "intake", "Welcome", "intake");
    await t.pool.query("insert into trashed_clients (client_id, user_id) values ($1, $2)", [
      other,
      rep,
    ]);
    const before = sent.length;
    const s = await drain();
    expect(s.sent).toBe(0);
    expect(sent.length).toBe(before);
    expect(await outbox(row)).toMatchObject({ status: "cancelled", skip_reason: "trashed" });
  });
});

describe("S1-15: the claim checker", () => {
  it("pure checks: approved needs an offer, guaranteed / no fees / loan are always out, a rate quote to California is held", () => {
    expect(checkClaims("Hi {first_name}, here is the application for {business}.").ok).toBe(true);
    expect(checkClaims("Good news: you are pre-approved for $50,000").ok).toBe(false);
    expect(
      checkClaims("Your approval is still open", { approvedOffer: true, state: "FL" }).ok,
    ).toBe(true);
    const noOffer = checkClaims("Your approval is still open", {
      approvedOffer: false,
      state: "FL",
    });
    expect(noOffer.ok).toBe(false);
    expect(noOffer.reasons[0]).toMatch(/no approved offer/);
    expect(checkClaims("Guaranteed funding this week").reasons).toEqual([
      'Says "guaranteed": nothing in funding is guaranteed',
    ]);
    expect(checkClaims("No upfront fees, ever").ok).toBe(false);
    expect(checkClaims("A quick business loan").ok).toBe(false);
    expect(
      checkClaims("Factor rate 1.35 over 8 months", { approvedOffer: true, state: "CA" }).ok,
    ).toBe(false);
    expect(
      checkClaims("Factor rate 1.35 over 8 months", { approvedOffer: true, state: "TX" }).ok,
    ).toBe(true);
    // the seeded wording passes: "before they approve" is not a claim of approval
    expect(
      checkClaims("lenders will ask for your newest statement before they approve it").ok,
    ).toBe(true);
  });

  it("the worker holds an automated send that says approved until a lender has approved; one-to-one mail is never checked", async () => {
    const id = await client("Claim Co", "claim@x.com");
    const row = await queue(id, "blast:x", "Good news, you are approved for funding", "blast");
    let s = await drain();
    expect(s.deferred).toBe(1);
    expect(await outbox(row)).toMatchObject({ status: "queued", last_error: "claim_check" });
    const held = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and body like 'Automated email held%'",
      [id],
    );
    expect(held.rows).toHaveLength(1);
    expect(held.rows[0]?.body).toMatch(/no approved offer/);
    // a second pass holds it again without a second timeline line
    await t.pool.query("update outbox set not_before = now() where id = $1", [row]);
    await drain();
    expect(
      (
        await t.pool.query(
          "select 1 from activities where client_id = $1 and body like 'Automated email held%'",
          [id],
        )
      ).rowCount,
    ).toBe(1);

    // a lender approves on an open deal: the same email may go
    const funder = (
      await t.pool.query<{ id: string }>(
        "insert into funders (user_id, name, submission_email) values ($1, 'Alpha Capital', 'subs@alpha.test') returning id",
        [rep],
      )
    ).rows[0]!.id;
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [id]));
    await t.pool.query(
      "insert into submissions (user_id, client_id, funder_id, status) values ($1, $2, $3, 'approved')",
      [rep, id, funder],
    );
    await t.pool.query("update outbox set not_before = now() where id = $1", [row]);
    s = await drain();
    expect(s.sent).toBe(1);
    expect((await outbox(row)).status).toBe("sent");

    // a person's reply is theirs: no check
    const reply = await queue(id, "manual", "Guaranteed, I will call you at 3", "reply");
    s = await drain();
    expect(s.sent).toBe(1);
    expect((await outbox(reply)).status).toBe("sent");
  });

  it("a template that fails the check cannot be approved; a clean one can, and approval lifts an auto-pause", async () => {
    const bad = (
      await t.pool.query<{ id: string }>(
        "insert into templates (owner_id, name, subject, body) values ($1, 'Bad', 'You are approved', 'Guaranteed, no upfront fees on this loan') returning id",
        [rep],
      )
    ).rows[0]!.id;
    await expect(t.db.withUser(manager, (q) => setTemplateApproved(q, bad, true))).rejects.toThrow(
      /cannot be approved as written.*"approved".*guaranteed.*fees.*"loan"/s,
    );
    expect(
      (
        await t.pool.query<{ approved: boolean }>("select approved from templates where id = $1", [
          bad,
        ])
      ).rows[0]?.approved,
    ).toBe(false);
    const good = (
      await t.pool.query<{ id: string }>(
        "insert into templates (owner_id, name, subject, body, auto_paused_at) values ($1, 'Good', 'Statements for {business}', 'Hi {first_name}, upload here: {upload_link}', now()) returning id",
        [rep],
      )
    ).rows[0]!.id;
    expect(
      (await t.pool.query<{ ok: boolean }>("select app.template_may_auto_send($1) as ok", [good]))
        .rows[0]?.ok,
    ).toBe(false);
    await t.db.withUser(manager, (q) => setTemplateApproved(q, good, true));
    const after = (
      await t.pool.query<{ approved: boolean; auto_paused_at: string | null; ok: boolean }>(
        "select approved, auto_paused_at, app.template_may_auto_send(id) as ok from templates where id = $1",
        [good],
      )
    ).rows[0];
    expect(after).toEqual({ approved: true, auto_paused_at: null, ok: true });
  });
});

describe("S1-4 / S1-5: the DNS gate and the Resend branch", () => {
  const records: Record<string, string[]> = {};
  const resolver = {
    resolveTxt: async (host: string) => {
      const r = records[host];
      if (!r) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return r.map((x) => [x]);
    },
  };

  it("reads the domain out of the automation address", () => {
    expect(automationDomain("Selective <auto@mail.selectivecap.com>")).toBe(
      "mail.selectivecap.com",
    );
    expect(automationDomain("auto@Selectivecap.com")).toBe("selectivecap.com");
    expect(automationDomain("")).toBeNull();
    expect(automationDomain("nobody")).toBeNull();
  });

  it("automated mail waits with dns_not_verified until SPF, DKIM and DMARC are all found; then Resend sends it, reply-to the rep", async () => {
    await t.pool.query(
      "update shop_settings set automation_from = 'Selective <auto@mail.selectivecap.com>'",
    );
    const id = await client("Resend Co", "resend@x.com");
    const row = await queue(id, "blast:y", "Here is the upload link for your statements", "blast");
    let s = await drain();
    expect(s.deferred).toBe(1);
    expect(await outbox(row)).toMatchObject({ status: "queued", last_error: "dns_not_verified" });

    // SPF and DMARC only: still not ready
    records["mail.selectivecap.com"] = ["v=spf1 include:amazonses.com ~all"];
    records["_dmarc.selectivecap.com"] = ["v=DMARC1; p=none"];
    let check = await checkAutomationDns("auto@mail.selectivecap.com", resolver);
    expect(check).toMatchObject({
      ok: false,
      spf: { ok: true },
      dkim: { ok: false },
      dmarc: { ok: true, host: "_dmarc.selectivecap.com" },
    });
    await t.db.withUser(manager, (q) => storeDnsCheck(q, check));
    await t.pool.query("update outbox set not_before = now() where id = $1", [row]);
    s = await drain();
    expect(s.deferred).toBe(1);
    expect((await outbox(row)).last_error).toBe("dns_not_verified");

    records["resend._domainkey.mail.selectivecap.com"] = [
      "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7",
    ];
    check = await checkAutomationDns("auto@mail.selectivecap.com", resolver);
    expect(check.ok).toBe(true);
    expect(check.dkim).toEqual({ ok: true, selector: "resend" });
    await t.db.withUser(manager, (q) => storeDnsCheck(q, check));
    const stored = (
      await t.pool.query<{ dns_ok: boolean; domain: string }>(
        "select dns_ok, dns_result->>'domain' as domain from shop_settings",
      )
    ).rows[0];
    expect(stored).toEqual({ dns_ok: true, domain: "mail.selectivecap.com" });

    await t.pool.query("update outbox set not_before = now() where id = $1", [row]);
    s = await drain();
    expect(s.sent).toBe(1);
    const last = sent[sent.length - 1];
    expect(last).toMatchObject({ via: "resend", to: "resend@x.com", replyTo: "rep@x.com" });
    expect(last?.text).toContain("1 Main St, Miami FL 33101");
    expect(await outbox(row)).toMatchObject({ status: "sent", provider: "resend" });
    const ledger = (
      await t.pool.query<{ kind: string; address: string; source: string }>(
        `select m.kind, m.address, l.source from send_ledger l join mailboxes m on m.id = l.mailbox_id
          where l.outbox_id = $1`,
        [row],
      )
    ).rows[0];
    expect(ledger).toEqual({
      kind: "resend",
      address: "Selective <auto@mail.selectivecap.com>",
      source: "crm",
    });

    // changing the automation address clears the result: the next domain must pass its own check
    await t.pool.query("update shop_settings set automation_from = 'auto@other.example.com'");
    const reset = (await t.pool.query<{ dns_ok: boolean }>("select dns_ok from shop_settings"))
      .rows[0];
    expect(reset?.dns_ok).toBe(false);
    await t.pool.query("update shop_settings set automation_from = ''");
  });
});
