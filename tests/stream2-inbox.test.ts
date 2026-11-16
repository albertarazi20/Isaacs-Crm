import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReadOutcome, ReaderResult } from "@/lib/ai/readLenderEmail";
import { runBucketSteps } from "@/lib/buckets/engine";
import { LocalStore } from "@/lib/docs/storage";
import { addDocument } from "@/lib/docs/upload";
import { importPastedOffer } from "@/lib/inbox/paste";
import { listProposed, processInbox, type Reader } from "@/lib/inbox/process";
import { submitToLenders, type Sender } from "@/lib/inbox/submit";
import { loadCandidates } from "@/lib/inbox/sync";
import { matchEmail } from "@/lib/inbox/match";
import { handleResendEvent } from "@/lib/system/replies";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

/**
 * Stream 2, the AI engine side: every effect proved in the database after acting as the role.
 *   S2-1 stips rows → re-bucket → the upload email names what is needed
 *   S2-3 missing SPF/DKIM is not authenticated → proposed
 *   S2-4 approval landed → the rep's alert; funded → the proposed funding and the managers' alert
 *   S2-5 Route B: Reply-To on the submission, Resend inbound lender mail stored and read
 *   S2-7 expiring watermarked links in the submission email, document_links per lender
 *   S2-9 revert_ai_update puts the lender row back
 *   S2-13 a rep cannot write a manager note; an unsupported quote lands as proposed
 *   S2-15 a pasted portal page lands in the tray
 */
let t: TestDb;
let dir: string;
let store: LocalStore;
let rep: string;
let manager: string;
let manager2: string;
let pizza: string;
let pearl: string;
let dealId: string;
let submissionId: string;
let ourMessageId: string;
const sent: Parameters<Sender>[0][] = [];
const sender: Sender = async (m) => {
  sent.push(m);
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
      Object.hasOwn(over, "spf_pass") ? over.spf_pass : true,
      Object.hasOwn(over, "dkim_pass") ? over.dkim_pass : true,
      m?.candidate.dealId ?? null,
      m?.candidate.submissionId ?? null,
      m?.candidate.clientId ?? null,
      m?.candidate.funderId ?? null,
      m?.by ?? "none",
    ],
  );
  return { id: rows[0]?.id as string, matchedBy: m?.by ?? "none" };
};
const submission = async () =>
  (
    await t.pool.query<{
      status: string;
      source: string;
      approval_expires_on: string | null;
      chase_count: number;
    }>(
      "select status, source, approval_expires_on::text as approval_expires_on, chase_count from submissions where id = $1",
      [submissionId],
    )
  ).rows[0]!;
const alerts = async (kind: string) =>
  (
    await t.pool.query<{ user_id: string; title: string; body: string; href: string }>(
      "select user_id, title, body, href from user_alerts where kind = $1 order by id",
      [kind],
    )
  ).rows;
const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF\n`);

beforeAll(async () => {
  t = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "isaac-s2-"));
  store = new LocalStore(dir);
  rep = await insertUser(t.pool, "rep@x.com");
  manager = await insertUser(t.pool, "boss@x.com");
  manager2 = await insertUser(t.pool, "boss2@x.com");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
  await t.pool.query("update app_users set role = 'manager', name = 'Boss Two' where id = $1", [
    manager2,
  ]);
  await t.pool.query("update app_users set name = 'Josh' where id = $1", [rep]);
  await t.pool.query(
    "update shop_settings set postal_address = '1 Main St', deals_inbox_address = 'deals@selectivecap.com'",
  );
  pizza = await insertClient(t.db, rep, "Pizza Palace");
  await t.pool.query("update clients set email = 'mike@pizza.com', state = 'FL' where id = $1", [
    pizza,
  ]);
  pearl = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email, commission_points) values ($1, 'Pearl Capital', 'subs@pearlcapital.com', 8) returning id",
      [manager],
    )
  ).rows[0]!.id;
  // two clean documents on the file before it goes out
  for (const [name, kind, period] of [
    ["app.pdf", "signed_application", null],
    ["oct.pdf", "bank_statement", "2026-10-01"],
  ] as const) {
    await t.db.withUser(rep, (q) =>
      addDocument(q, store, {
        clientId: pizza,
        filename: name,
        contentType: "application/pdf",
        bytes: pdf(name),
        uploadedBy: rep,
        today: t.today,
        kind,
        period,
      }),
    );
  }
  dealId = (await t.db.withUser(
    rep,
    async (q) =>
      (await q.query<{ id: string }>("select id from submit_to_ops($1)", [pizza])).rows[0],
  ))!.id;
});
afterAll(async () => {
  await t.drop();
  rmSync(dir, { recursive: true, force: true });
});

describe("S2-5 + S2-7: the submission email", () => {
  it("carries the deals inbox as Reply-To and an expiring watermarked link per document, minted for that lender", async () => {
    const r = await t.db.withUser(manager, (q) =>
      submitToLenders(
        q,
        {
          clientId: pizza,
          funderIds: [pearl],
          senderName: "Boss",
          senderEmail: "boss@selectivecap.com",
          appUrl: "https://crm.test",
        },
        sender,
      ),
    );
    submissionId = r.submissions[0]!.submissionId;
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.headers?.["Reply-To"]).toBe("deals@selectivecap.com");
    ourMessageId = m.messageId as string;
    const urls = m.text.match(/https:\/\/crm\.test\/d\/[A-Za-z0-9]+/g) ?? [];
    expect(urls).toHaveLength(2);
    expect(m.text).toContain("Signed application: https://crm.test/d/");
    expect(m.text).toContain("Oct 2026 bank statement: https://crm.test/d/");
    expect(m.text).toContain("Each link is good for 7 days and the copies carry your name.");
    const links = await t.pool.query<{
      watermark: string;
      lender_id: string;
      max_downloads: number;
      token: string;
      live: boolean;
    }>(
      "select watermark, lender_id, max_downloads, token, expires_at > now() + interval '6 days' as live from document_links order by created_at",
    );
    expect(links.rows).toHaveLength(2);
    for (const l of links.rows) {
      expect(l).toMatchObject({
        watermark: "Prepared for Pearl Capital",
        lender_id: pearl,
        max_downloads: 10,
        live: true,
      });
      expect(urls).toContain(`https://crm.test/d/${l.token}`);
    }
    const views = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from document_views where action = 'link_minted' and lender_id = $1 and viewer_user_id = $2",
      [pearl, manager],
    );
    expect(views.rows[0]?.n).toBe(2);
  });
});

describe("S2-1: the stips loop", () => {
  afterAll(async () => {
    // the forward path puts the row back to sent so the next lender email reads against it
    await t.pool.query("select set_submission_status($1, 'sent', null, 'stips sent')", [
      submissionId,
    ]);
  });
  it("a lender's stips request becomes checklist rows, re-buckets the merchant and the upload email names what is needed", async () => {
    const e = await storeEmail({
      gmail_thread_id: "thread-1",
      subject: "Re: [D-1] Pizza Palace",
      text_body:
        "Please provide a voided check and a copy of the DL, plus a selfie with the check.",
    });
    expect(e.matchedBy).toBe("thread");
    const reader: Reader = async () =>
      outcome({
        event: "stip_requested",
        stips_requested: ["voided check", "copy of DL", "selfie with the check"],
        summary: "Pearl asked for a voided check, the DL and a selfie",
        evidence: [{ field: "event", quote: "Please provide" }],
      });
    expect(await processInbox({ db: t.db, reader })).toMatchObject({ applied: 1, proposed: 0 });
    // the two filed documents already sat on the checklist as received; the lender's three asks join it as required
    const stips = await t.pool.query<{
      kind: string;
      label: string;
      required: boolean;
      received_at: string | null;
    }>(
      "select kind, label, required, received_at from stips where client_id = $1 and received_at is null order by kind",
      [pizza],
    );
    expect(
      (
        await t.pool.query<{ kind: string }>(
          "select kind from stips where client_id = $1 and received_at is not null and not required order by kind",
          [pizza],
        )
      ).rows.map((r) => r.kind),
    ).toEqual(["bank_statement", "signed_application"]);
    expect(stips.rows).toEqual([
      { kind: "drivers_license", label: "copy of DL", required: true, received_at: null },
      { kind: "other", label: "selfie with the check", required: true, received_at: null },
      { kind: "voided_check", label: "voided check", required: true, received_at: null },
    ]);
    const bucket = await t.pool.query<{ key: string }>(
      "select b.key from enrollments e join buckets b on b.id = e.bucket_id where e.client_id = $1 and e.stopped_at is null",
      [pizza],
    );
    expect(bucket.rows[0]?.key).toBe("missing_id");
    const act = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from activities where client_id = $1 and body = $2",
      [
        pizza,
        "Checklist updated — Pearl Capital needs: Voided check, Driver's license / ID, selfie with the check",
      ],
    );
    expect(act.rows[0]?.n).toBe(1);
    await runBucketSteps({ db: t.db, appUrl: "https://crm.test" });
    const ob = await t.pool.query<{ text_body: string; status: string }>(
      "select text_body, status from outbox where client_id = $1 order by created_at desc limit 1",
      [pizza],
    );
    expect(ob.rows[0]?.status).toBe("queued");
    expect(ob.rows[0]?.text_body).toContain("voided check");
    expect(ob.rows[0]?.text_body).toContain("driver's license");
    expect(ob.rows[0]?.text_body).toMatch(/https:\/\/crm\.test\/upload\/[0-9a-f]+/);
    expect((await submission()).status).toBe("stips_requested");
  });
});

describe("S2-3 + S2-13: what only ever proposes", () => {
  it("a low-stakes event with no SPF/DKIM result is proposed, not applied", async () => {
    await storeEmail({
      gmail_thread_id: "thread-1",
      subject: "Re: [D-1]",
      text_body: "We will pass",
      spf_pass: null,
      dkim_pass: null,
    });
    const reader: Reader = async () =>
      outcome({
        event: "declined",
        decline_reason: "nsfs",
        summary: "Pearl declined: NSFs",
        evidence: [{ field: "event", quote: "We will pass" }],
      });
    expect(await processInbox({ db: t.db, reader })).toMatchObject({ applied: 0, proposed: 1 });
    expect((await submission()).status).toBe("sent");
    const p = await t.pool.query<{ status: string }>(
      "select status from proposed_updates where event = 'declined'",
    );
    expect(p.rows[0]?.status).toBe("proposed");
    await t.db.withUser(manager, (q) =>
      q.query(
        "update proposed_updates set status = 'rejected' where event = 'declined' and status = 'proposed'",
      ),
    );
  });
  it("an unsupported quote or bad arithmetic lands as proposed even when authenticated and on the thread", async () => {
    await storeEmail({
      gmail_thread_id: "thread-1",
      subject: "Re: [D-1]",
      text_body: "Docs out today",
    });
    const reader: Reader = async () =>
      outcome(
        {
          event: "docs_out",
          summary: "Pearl sent contracts",
          evidence: [{ field: "event", quote: "we are thrilled" }],
        },
        { unsupported: ["event"] },
      );
    expect(await processInbox({ db: t.db, reader })).toMatchObject({ applied: 0, proposed: 1 });
    expect((await submission()).status).toBe("sent");
    await storeEmail({
      gmail_thread_id: "thread-1",
      subject: "Re: [D-1]",
      text_body: "Contracts in",
    });
    const reader2: Reader = async () =>
      outcome(
        { event: "contracts_in", summary: "Pearl got the contracts" },
        { problems: ["payback ≠ amount × factor"] },
      );
    expect(await processInbox({ db: t.db, reader: reader2 })).toMatchObject({
      applied: 0,
      proposed: 1,
    });
    expect((await submission()).status).toBe("sent");
    await t.db.withUser(manager, (q) =>
      q.query("update proposed_updates set status = 'rejected' where status = 'proposed'"),
    );
  });
  it("a rep cannot write the manager note or the ops note; a manager can", async () => {
    await expect(
      t.db.withUser(rep, (q) =>
        q.query("update deals set manager_note = 'no' where id = $1", [dealId]),
      ),
    ).rejects.toThrow(/only a manager can write the manager note/);
    await expect(
      t.db.withUser(rep, (q) =>
        q.query("update deals set ops_note = 'no' where id = $1", [dealId]),
      ),
    ).rejects.toThrow(/only ops or a manager can write the ops note/);
    await t.db.withUser(rep, (q) =>
      q.query("update deals set rep_note = 'mine' where id = $1", [dealId]),
    );
    await t.db.withUser(manager, (q) =>
      q.query("update deals set manager_note = 'ok' where id = $1", [dealId]),
    );
    const d = await t.pool.query<{ rep_note: string; manager_note: string }>(
      "select rep_note, manager_note from deals where id = $1",
      [dealId],
    );
    expect(d.rows[0]).toEqual({ rep_note: "mine", manager_note: "ok" });
  });
});

describe("S2-4 + S2-9: an approval lands, is undone, lands again; a funded email proposes the funding", () => {
  let approvalId: string;
  it("confirming an approval writes the rep's alert, the offer and the expiry clock", async () => {
    await storeEmail({
      gmail_thread_id: "thread-1",
      subject: "Re: [D-1] approved",
      text_body: "Approved $45,000 at 1.35, 120 days, $506.25 daily",
    });
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
        evidence: [
          { field: "event", quote: "Approved" },
          { field: "amount_dollars", quote: "$45,000" },
          { field: "factor_rate", quote: "1.35" },
        ],
      });
    expect(await processInbox({ db: t.db, reader })).toMatchObject({ applied: 0, proposed: 1 });
    expect(await alerts("approval_landed")).toHaveLength(0);
    const tray = await t.db.withUser(manager, listProposed);
    approvalId = tray[0]!.id;
    await t.db.withUser(manager, (q) => q.query("select apply_proposed_update($1)", [approvalId]));
    const a = await alerts("approval_landed");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      user_id: rep,
      title: "Pearl Capital approved Pizza Palace",
      href: `/deals/${dealId}`,
    });
    const s = await submission();
    expect(s.status).toBe("approved");
    // no stated date: today + the shop's 30 days (the lender has none of its own)
    const want = (await t.pool.query<{ d: string }>("select (current_date + 30)::text as d"))
      .rows[0]!.d;
    expect(s.approval_expires_on).toBe(want);
    const u = await t.pool.query<{
      previous_status: string;
      created_offer_id: string | null;
      status: string;
    }>("select previous_status, created_offer_id, status from proposed_updates where id = $1", [
      approvalId,
    ]);
    expect(u.rows[0]).toMatchObject({ previous_status: "sent", status: "applied" });
    expect(u.rows[0]?.created_offer_id).not.toBeNull();
    expect(
      (await t.pool.query<{ blocker: string }>("select blocker from deals where id = $1", [dealId]))
        .rows[0]?.blocker,
    ).toBe("");
  });
  it("revert_ai_update puts the lender row back and removes the offer, with a timeline line; manager-only", async () => {
    await expect(
      t.db.withUser(rep, (q) => q.query("select revert_ai_update($1)", [approvalId])),
    ).rejects.toThrow(/only a manager/);
    await t.db.withUser(manager, (q) => q.query("select revert_ai_update($1)", [approvalId]));
    expect(await submission()).toMatchObject({
      status: "sent",
      source: "manual",
      approval_expires_on: null,
    });
    expect(
      (await t.pool.query("select 1 from offers where submission_id = $1", [submissionId]))
        .rowCount,
    ).toBe(0);
    const u = await t.pool.query<{ status: string; reverted_by: string }>(
      "select status, reverted_by from proposed_updates where id = $1",
      [approvalId],
    );
    expect(u.rows[0]).toEqual({ status: "reverted", reverted_by: manager });
    const act = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 order by occurred_at desc limit 1",
      [pizza],
    );
    expect(act.rows[0]?.body).toBe("Undid the AI update — Pearl Capital is back to sent");
    await expect(
      t.db.withUser(manager, (q) => q.query("select revert_ai_update($1)", [approvalId])),
    ).rejects.toThrow(/only an applied update/);
  });
  it("a lender's funded email proposes the funding from the offer and alerts the managers", async () => {
    // the approval again, this time it stays
    await t.db.withUser(manager, (q) =>
      q.query("select record_offer($1, $2::jsonb)", [
        submissionId,
        JSON.stringify({
          amount_cents: 4_500_000,
          factor_rate: 1.35,
          payment_cents: 50_625,
          frequency: "daily",
          term_days: 120,
        }),
      ]),
    );
    await storeEmail({
      gmail_thread_id: "thread-1",
      subject: "Re: [D-1] funded",
      text_body: "Pizza Palace has been funded, wire sent",
    });
    const reader: Reader = async () =>
      outcome({
        event: "funded",
        summary: "Pearl funded Pizza Palace",
        evidence: [{ field: "event", quote: "has been funded" }],
      });
    expect(await processInbox({ db: t.db, reader })).toMatchObject({ applied: 0, proposed: 1 });
    expect(
      (await t.pool.query("select 1 from fundings where client_id = $1", [pizza])).rowCount,
    ).toBe(0);
    const tray = await t.db.withUser(manager, listProposed);
    const funded = tray.find((p) => p.event === "funded")!;
    await t.db.withUser(manager, (q) => q.query("select apply_proposed_update($1)", [funded.id]));
    const f = await t.pool.query<{
      deal_id: string;
      funder_id: string;
      amount_cents: number;
      sell_rate: string;
      payment_cents: number;
      frequency: string;
      proposed_by: string;
      confirmed_at: string | null;
      term_days: number;
      note: string;
    }>(
      "select deal_id, funder_id, amount_cents, sell_rate::text as sell_rate, payment_cents, frequency, proposed_by, confirmed_at, term_days, note from fundings where client_id = $1",
      [pizza],
    );
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({
      deal_id: dealId,
      funder_id: pearl,
      amount_cents: 4_500_000,
      sell_rate: "1.350",
      payment_cents: 50_625,
      frequency: "daily",
      proposed_by: manager,
      confirmed_at: null,
      term_days: 120,
      note: "Proposed from Pearl Capital's funded email",
    });
    expect((await submission()).status).toBe("funded");
    const d = await t.pool.query<{ blocker: string; outcome: string }>(
      "select blocker, outcome from deals where id = $1",
      [dealId],
    );
    expect(d.rows[0]).toEqual({
      blocker: "Funding proposed from Pearl Capital's email — a manager confirms it with FUND",
      outcome: "open",
    });
    const a = await alerts("funding_proposed");
    expect(a.map((x) => x.user_id).sort()).toEqual([manager, manager2].sort());
    expect(a[0]).toMatchObject({
      title: "Confirm the funding: Pizza Palace with Pearl Capital",
      body: "$45,000 at 1.35 factor, proposed from the lender's funded email",
    });
  });
});

describe("S2-15: a pasted portal page", () => {
  let pasted: string;
  let pastedSub: string;
  beforeAll(async () => {
    // a second merchant with its own open deal and lender row
    pasted = await insertClient(t.db, rep, "Bella Nails");
    await t.pool.query(
      "update clients set phone = '3055550199', email = 'b@nails.com' where id = $1",
      [pasted],
    );
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [pasted]));
    pastedSub = (await t.db.withUser(
      manager,
      async (q) =>
        (
          await q.query<{ id: string }>("select id from create_submissions($1, $2::uuid[])", [
            pasted,
            [pearl],
          ])
        ).rows[0],
    ))!.id;
  });
  it("the reader's terms land in the tray as a pasted update, never applied by themselves; applying writes the offer", async () => {
    const reader: Reader = async (i) => {
      expect(i.from).toBe("pasted by Boss");
      expect(i.expectedLender).toBe("Pearl Capital");
      return outcome({
        event: "approved",
        offer: {
          amount_dollars: 30000,
          factor_rate: 1.29,
          payback_dollars: 38700,
          payment_dollars: null,
          frequency: null,
          term_days: 100,
          buy_rate: null,
          max_upsell_points: null,
          fees_dollars: null,
          expires_on: null,
          position_no: null,
        },
        offers_count: 1,
        summary: "Pearl approved $30,000 at 1.29 for 100 days",
        evidence: [
          { field: "event", quote: "Approved" },
          { field: "amount_dollars", quote: "$30,000" },
        ],
      });
    };
    const deal = (
      await t.pool.query<{ id: string }>(
        "select id from deals where client_id = $1 and outcome = 'open'",
        [pasted],
      )
    ).rows[0]!.id;
    const r = await importPastedOffer({
      db: t.db,
      userId: manager,
      input: {
        dealId: deal,
        submissionId: pastedSub,
        text: "Offer summary\nApproved: $30,000\nFactor 1.29\nTerm 100 days\nPayback $38,700",
      },
      reader,
    });
    expect(r).toMatchObject({
      event: "approved",
      summary: "Pearl approved $30,000 at 1.29 for 100 days",
    });
    const row = await t.pool.query<{ source: string; status: string; email_id: string | null }>(
      "select source, status, email_id from proposed_updates where id = $1",
      [r.proposedId],
    );
    expect(row.rows[0]).toEqual({ source: "pasted", status: "proposed", email_id: null });
    expect(
      (await t.pool.query("select 1 from offers where submission_id = $1", [pastedSub])).rowCount,
    ).toBe(0);
    const run = await t.pool.query<{ purpose: string }>(
      "select purpose from ai_runs where deal_id = $1",
      [deal],
    );
    expect(run.rows[0]?.purpose).toBe("read_pasted_offer");
    expect((await t.db.withUser(manager, listProposed)).some((p) => p.id === r.proposedId)).toBe(
      true,
    );
    await t.db.withUser(manager, (q) =>
      q.query("select apply_proposed_update($1)", [r.proposedId]),
    );
    const offer = await t.pool.query<{ amount_cents: number; term_days: number }>(
      "select amount_cents, term_days from offers where submission_id = $1",
      [pastedSub],
    );
    expect(offer.rows[0]).toEqual({ amount_cents: 3_000_000, term_days: 100 });
    expect(
      (
        await t.pool.query<{ source: string }>("select source from submissions where id = $1", [
          pastedSub,
        ])
      ).rows[0]?.source,
    ).toBe("manual");
  });
  it("too little text, a switched-off reader and text that says nothing are refused in plain words", async () => {
    const deal = (
      await t.pool.query<{ id: string }>(
        "select id from deals where client_id = $1 and outcome = 'open'",
        [pasted],
      )
    ).rows[0]!.id;
    await expect(
      importPastedOffer({ db: t.db, userId: manager, input: { dealId: deal, text: "hi" } }),
    ).rejects.toThrow(/Paste the lender's text/);
    await t.pool.query("update shop_settings set ai_enabled = false");
    await expect(
      importPastedOffer({
        db: t.db,
        userId: manager,
        input: { dealId: deal, text: "a long enough piece of text to read" },
        reader: async () => outcome({}),
      }),
    ).rejects.toThrow(/switched off/);
    await t.pool.query("update shop_settings set ai_enabled = true");
    await expect(
      importPastedOffer({
        db: t.db,
        userId: manager,
        input: { dealId: deal, text: "a long enough piece of text to read" },
        reader: async () => outcome({}),
      }),
    ).rejects.toThrow(/Nothing in that text/);
  });
});

describe("S2-5: lender mail through the deals inbox (Resend inbound)", () => {
  it("a lender's reply to our Message-ID is stored, matched by reply headers, and read like Gmail mail", async () => {
    // the first merchant's lender row is funded now; a fresh thread on the second merchant's row
    const sub = (
      await t.pool.query<{ msg: string | null }>(
        "select gmail_message_id as msg from submissions where client_id = $1",
        [pizza],
      )
    ).rows[0];
    expect(sub?.msg).toBe(ourMessageId);
    let fetched = 0;
    const r = await handleResendEvent(
      t.db,
      "evt_lender_1",
      {
        type: "email.received",
        created_at: "2026-11-16T15:00:00Z",
        data: {
          email_id: "re_abc",
          from: "Jane <uw@pearlcapital.com>",
          to: ["deals@selectivecap.com"],
          subject: "Re: [D-1] Pizza Palace",
          headers: [
            { name: "In-Reply-To", value: ourMessageId },
            { name: "Message-ID", value: "<pearl-1@pearlcapital.com>" },
          ],
          attachments: [{ filename: "Terms.pdf" }],
        },
      },
      {
        fetchInbound: async (id) => (
          (fetched += 1),
          id === "re_abc" ? { text: "Revised: $40,000 at 1.30, 100 days" } : null
        ),
      },
    );
    expect(r).toEqual({ result: "received:lender:reply_headers" });
    expect(fetched).toBe(1);
    const e = await t.pool.query<{
      channel: string;
      mailbox_user_id: string | null;
      matched_by: string;
      kind: string;
      text_body: string;
      spf_pass: boolean | null;
      deal_id: string;
      submission_id: string;
      attachment_names: string[];
      received_at: string;
      processed_at: string | null;
    }>(
      "select channel, mailbox_user_id, matched_by, kind, text_body, spf_pass, deal_id, submission_id, attachment_names, received_at::text as received_at, processed_at from inbound_emails where gmail_id = 'resend:re_abc'",
    );
    expect(e.rows[0]).toMatchObject({
      channel: "resend",
      mailbox_user_id: null,
      matched_by: "reply_headers",
      kind: "lender",
      text_body: "Revised: $40,000 at 1.30, 100 days",
      spf_pass: null,
      deal_id: dealId,
      submission_id: submissionId,
      attachment_names: ["Terms.pdf"],
      processed_at: null,
    });
    // the same event again stores nothing twice
    expect(
      await handleResendEvent(t.db, "evt_lender_1", { type: "email.received", data: {} }),
    ).toEqual({ result: "duplicate" });
    const reader: Reader = async (i) => {
      expect(i.text).toBe("Revised: $40,000 at 1.30, 100 days");
      return outcome({
        event: "revised",
        offer: {
          amount_dollars: 40000,
          factor_rate: 1.3,
          payback_dollars: 52000,
          payment_dollars: null,
          frequency: null,
          term_days: 100,
          buy_rate: null,
          max_upsell_points: null,
          fees_dollars: null,
          expires_on: null,
          position_no: null,
        },
        offers_count: 1,
        summary: "Pearl revised to $40,000 at 1.30",
        evidence: [{ field: "event", quote: "Revised" }],
      });
    };
    expect(await processInbox({ db: t.db, reader })).toMatchObject({
      read: 1,
      proposed: 1,
      applied: 0,
    });
    const p = await t.pool.query<{ status: string; event: string }>(
      "select p.status, p.event from proposed_updates p join inbound_emails e on e.id = p.email_id where e.gmail_id = 'resend:re_abc'",
    );
    expect(p.rows[0]).toEqual({ status: "proposed", event: "revised" });
  });
  it("a lender writing with the deal token and a body in the payload needs no fetch; a stranger is not stored", async () => {
    let fetched = 0;
    expect(
      await handleResendEvent(
        t.db,
        "evt_lender_2",
        {
          type: "email.received",
          data: {
            email_id: "re_tok",
            from: "ops@pearlcapital.com",
            subject: "[D-2] Bella Nails - need stips",
            text: "Please send the voided check.",
          },
        },
        { fetchInbound: async () => ((fetched += 1), null) },
      ),
    ).toEqual({ result: "received:lender:deal_token" });
    expect(fetched).toBe(0);
    expect(
      await handleResendEvent(t.db, "evt_stranger", {
        type: "email.received",
        data: { from: "stranger@nowhere.com", subject: "hi", text: "buy now" },
      }),
    ).toEqual({ result: "received:unknown_sender" });
    expect(
      (
        await t.pool.query<{ n: number }>(
          "select count(*)::int as n from inbound_emails where channel = 'resend'",
        )
      ).rows[0]?.n,
    ).toBe(2);
  });
});
