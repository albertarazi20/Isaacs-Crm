import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReadInput, ReadOutcome, ReaderResult } from "@/lib/ai/readLenderEmail";
import { listProposed, processInbox, type Reader } from "@/lib/inbox/process";
import { loadCandidates } from "@/lib/inbox/sync";
import { submitToLenders, type Sender } from "@/lib/inbox/submit";
import { matchEmail } from "@/lib/inbox/match";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let manager: string;
let pizza: string;
let pearl: string;
let dealId: string;
const sent: { to: string; subject: string; messageId?: string; threadId?: string }[] = [];
const sender: Sender = async (m) => {
  sent.push({ to: m.to, subject: m.subject, messageId: m.messageId, threadId: m.threadId });
  return { id: `g${sent.length}`, threadId: `thread-${sent.length}` };
};

const outcome = (r: Partial<ReaderResult>, extra: Partial<ReadOutcome> = {}): ReadOutcome => ({
  result: {
    event: "no_change",
    is_from_lender: true,
    lender_name: "Pearl",
    business_name: "Pizza Palace",
    offer: null,
    offers_count: 0,
    decline_reason: null,
    stips_requested: [],
    portal_link_only: false,
    summary: "summary",
    next_step: "",
    evidence: [{ field: "event", quote: "quote" }],
    confidence: 0.95,
    ...r,
  },
  model: "claude-opus-5-5",
  inputTokens: 1000,
  outputTokens: 200,
  inputHash: "h",
  unsupported: [],
  problems: [],
  ...extra,
});

const storeEmail = async (over: Record<string, unknown>) => {
  const cands = await t.db.withSystem(loadCandidates);
  const h = {
    threadId: (over.gmail_thread_id as string) ?? null,
    inReplyTo: null,
    references: [],
    fromAddress: (over.from_address as string) ?? "uw@pearlcapital.com",
    subject: (over.subject as string) ?? "",
    text: (over.text_body as string) ?? "",
  };
  const m = matchEmail(h, cands);
  const { rows } = await t.pool.query<{ id: string }>(
    `insert into inbound_emails (mailbox_user_id, gmail_id, gmail_thread_id, from_address, subject, text_body, received_at, spf_pass, dkim_pass,
                                 deal_id, submission_id, client_id, funder_id, matched_by, kind)
     values ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10, $11, $12, $13, 'lender') returning id`,
    [
      manager,
      `g-${Math.random()}`,
      h.threadId,
      h.fromAddress,
      h.subject,
      h.text,
      over.spf_pass ?? true,
      over.dkim_pass ?? true,
      m?.candidate.dealId ?? null,
      m?.candidate.submissionId ?? null,
      m?.candidate.clientId ?? null,
      m?.candidate.funderId ?? null,
      m?.by ?? "none",
    ],
  );
  return { id: rows[0]?.id as string, matchedBy: m?.by ?? "none" };
};

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com");
  manager = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
  pizza = await insertClient(t.db, rep, "Pizza Palace");
  pearl = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email) values ($1, 'Pearl Capital', 'subs@pearlcapital.com') returning id",
      [manager],
    )
  ).rows[0]?.id as string;
  const d = await t.db.withUser(
    rep,
    async (q) =>
      (await q.query<{ id: string }>("select id from submit_to_ops($1)", [pizza])).rows[0],
  );
  if (!d) throw new Error("no deal");
  dealId = d.id;
});
afterAll(async () => {
  await t.drop();
});

describe("sending to lenders from the CRM", () => {
  it("creates the lender row, emails the lender with [D-n] and our Message-ID, keeps the thread id, marks the deal sent", async () => {
    const r = await t.db.withUser(manager, (q) =>
      submitToLenders(
        q,
        {
          clientId: pizza,
          funderIds: [pearl],
          senderName: "Boss",
          senderEmail: "boss@selectivecap.com",
        },
        sender,
      ),
    );
    expect(r.submissions).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("subs@pearlcapital.com");
    expect(sent[0]?.subject).toMatch(/^\[D-\d+\] New submission: Pizza Palace/);
    expect(sent[0]?.messageId).toMatch(/^<.+@selectivecap\.com>$/);
    const sub = (
      await t.pool.query<{
        gmail_thread_id: string;
        gmail_message_id: string;
        sent_via: string;
        deal_id: string;
      }>(
        "select gmail_thread_id, gmail_message_id, sent_via, deal_id from submissions where client_id = $1",
        [pizza],
      )
    ).rows[0];
    expect(sub?.gmail_thread_id).toBe("thread-1");
    expect(sub?.sent_via).toBe("crm");
    expect(sub?.deal_id).toBe(dealId);
    const d = (
      await t.pool.query<{ ops_status: string }>("select ops_status from deals where id = $1", [
        dealId,
      ])
    ).rows[0];
    expect(d?.ops_status).toBe("sent");
  });
});

describe("reading lender mail", () => {
  it("a stips request on the thread, authenticated and quoted, applies by itself", async () => {
    const e = await storeEmail({
      gmail_thread_id: "thread-1",
      subject: "Re: [D-1] Pizza Palace",
      text_body: "Please provide a voided check and last month statement.",
    });
    expect(e.matchedBy).toBe("thread");
    const reader: Reader = async () =>
      outcome({
        event: "stip_requested",
        stips_requested: ["voided check", "newest statement"],
        summary: "Pearl asked for a voided check and the newest statement",
        evidence: [{ field: "event", quote: "Please provide" }],
      });
    const s = await processInbox({ db: t.db, reader });
    expect(s).toMatchObject({ read: 1, applied: 1, proposed: 0 });
    const sub = (
      await t.pool.query<{ status: string; source: string }>(
        "select status, source from submissions where client_id = $1",
        [pizza],
      )
    ).rows[0];
    expect(sub).toEqual({ status: "stips_requested", source: "email" });
    const act = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and body like '%voided check%'",
      [pizza],
    );
    expect(act.rows.length).toBeGreaterThanOrEqual(1);
    const run = await t.pool.query<{ cost_cents: string; purpose: string }>(
      "select cost_cents::text, purpose from ai_runs",
    );
    expect(run.rows[0]?.purpose).toBe("read_lender_email");
    expect(Number(run.rows[0]?.cost_cents)).toBeGreaterThan(0);
  });
  it("an approval with terms is proposed, never applied, until a manager confirms; then the offer exists", async () => {
    const e = await storeEmail({
      gmail_thread_id: "thread-1",
      subject: "Re: [D-1] Pizza Palace approved",
      text_body: "Approved $45,000 at 1.35, 120 days, $506.25 daily",
    });
    expect(e.matchedBy).toBe("thread");
    const reader: Reader = async () =>
      outcome({
        event: "approved",
        offer: {
          amount_dollars: 45000,
          factor_rate: 1.35,
          payback_dollars: 60750,
          payment_dollars: 506.25,
          frequency: "daily",
          term_days: 120,
          buy_rate: null,
          max_upsell_points: null,
          fees_dollars: null,
          expires_on: null,
          position_no: null,
        },
        offers_count: 1,
        summary: "Pearl approved $45,000 at 1.35 for 120 days",
        next_step: "Pitch it today",
        evidence: [
          { field: "event", quote: "Approved" },
          { field: "amount_dollars", quote: "$45,000" },
          { field: "factor_rate", quote: "1.35" },
        ],
      });
    const s = await processInbox({ db: t.db, reader });
    expect(s).toMatchObject({ read: 1, applied: 0, proposed: 1 });
    expect(
      (await t.pool.query("select count(*)::int as n from offers where client_id = $1", [pizza]))
        .rows[0].n,
    ).toBe(0);
    const tray = await t.db.withUser(manager, listProposed);
    expect(tray).toHaveLength(1);
    expect(tray[0]?.event).toBe("approved");
    expect(tray[0]?.business_name).toBe("Pizza Palace");
    // the rep sees the proposed line in the timeline flagged for review
    const act = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 order by occurred_at desc limit 1",
      [pizza],
    );
    expect(act.rows[0]?.body).toMatch(/^\[needs review\] Pearl approved/);
    // a rep cannot apply it; a manager can
    await expect(
      t.db.withUser(rep, (q) => q.query("select apply_proposed_update($1)", [tray[0]?.id])),
    ).rejects.toThrow();
    await t.db.withUser(manager, (q) => q.query("select apply_proposed_update($1)", [tray[0]?.id]));
    const offer = (
      await t.pool.query<{ amount_cents: number; factor_rate: string; term_days: number }>(
        "select amount_cents, factor_rate::text, term_days from offers where client_id = $1",
        [pizza],
      )
    ).rows[0];
    expect(offer).toEqual({ amount_cents: 4_500_000, factor_rate: "1.350", term_days: 120 });
    expect(
      (
        await t.pool.query<{ status: string }>(
          "select status from submissions where client_id = $1",
          [pizza],
        )
      ).rows[0]?.status,
    ).toBe("approved");
    expect(await t.db.withUser(manager, listProposed)).toHaveLength(0);
  });
  it("a decline with a bad SPF result is proposed, not applied", async () => {
    await storeEmail({
      gmail_thread_id: "thread-1",
      subject: "Re: [D-1]",
      text_body: "We will pass",
      spf_pass: false,
    });
    const reader: Reader = async () =>
      outcome({
        event: "declined",
        decline_reason: "low_balances",
        summary: "Pearl declined: low balances",
        evidence: [{ field: "event", quote: "We will pass" }],
      });
    const s = await processInbox({ db: t.db, reader });
    expect(s).toMatchObject({ applied: 0, proposed: 1 });
  });
  it("an unmatched email is left alone, and a link-only offer becomes a manager task", async () => {
    await storeEmail({
      from_address: "news@randomlender.com",
      subject: "Rates this week",
      text_body: "Great rates",
    });
    const linkOnly = await storeEmail({
      gmail_thread_id: "thread-1",
      subject: "Re: [D-1] your offer is ready",
      text_body: "View your offer at https://portal.pearl.com/x",
    });
    expect(linkOnly.matchedBy).toBe("thread");
    const reader: Reader = async () =>
      outcome({
        event: "no_change",
        portal_link_only: true,
        summary: "Pearl sent a portal link with the offer",
        next_step: "open the link",
      });
    const s = await processInbox({ db: t.db, reader });
    expect(s.proposed).toBe(1);
    const tray = await t.db.withUser(manager, listProposed);
    expect(tray.some((p) => p.next_step.startsWith("Offer waiting behind a link"))).toBe(true);
    const deal = (
      await t.pool.query<{ blocker: string }>("select blocker from deals where id = $1", [dealId])
    ).rows[0];
    expect(deal?.blocker).toMatch(/^Review:/);
  });
  it("the kill switch stops reading; the daily cap stops spending", async () => {
    await t.pool.query("update shop_settings set ai_enabled = false");
    await storeEmail({ gmail_thread_id: "thread-1", subject: "x", text_body: "y" });
    let calls = 0;
    const reader: Reader = async () => ((calls += 1), outcome({}));
    expect(await processInbox({ db: t.db, reader })).toMatchObject({ read: 0 });
    await t.pool.query("update shop_settings set ai_enabled = true, ai_daily_cap_cents = 0");
    expect(await processInbox({ db: t.db, reader })).toMatchObject({ read: 0, skipped: 1 });
    expect(calls).toBe(0);
    await t.pool.query("update shop_settings set ai_daily_cap_cents = 2000");
  });
});
