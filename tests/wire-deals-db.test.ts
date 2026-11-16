import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askManager } from "@/lib/deals/mutations";
import { aiBlockedReason } from "@/lib/deals/aiStatus";
import { loadApplicationInfo } from "@/lib/deals/application";
import { loadStateBadge } from "@/lib/deals/compliance";
import { missingStipLabels } from "@/lib/deals/stipLabels";
import { listAppliedUpdates } from "@/lib/inbox/appliedUpdates";
import { listChaseDrafts, parseChaseDraft, sendChaseDraft } from "@/lib/inbox/chaseDrafts";
import { autoChase, type Sender } from "@/lib/inbox/submit";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

/**
 * The read side of the board and deal-page controls, proved in the database: the Review tray's applied list and its
 * way back, the chase drafts and what sending one changes, the stip wording, the state badge's inputs, the
 * application link, and the AI readiness check. Each effect is read back from the tables, not from a return value.
 */
let t: TestDb;
let rep: string;
let ops: string;
let manager: string;
let pearl: string;
let fora: string;
let seq = 0;

const one = async <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await t.pool.query<R>(sql, params)).rows[0] as R;
const asManager = <T>(fn: (q: import("@/lib/db").Db) => Promise<T>) => t.db.withUser(manager, fn);

/** A merchant of the rep's with an open deal and a lender row per funder. */
async function merchant(name: string, lenders: string[] = []) {
  seq += 1;
  const id = await insertClient(t.db, rep, name);
  await t.pool.query(
    "update clients set phone = $2, email = $3, state = 'FL', industry = 'Restaurant', monthly_revenue_cents = 4000000, time_in_business_months = 30 where id = $1",
    [id, `305777${String(1000 + seq).slice(-4)}`, `w3-${seq}@biz.com`],
  );
  const deal = (
    await t.db.withUser(rep, (q) =>
      q.query<{ id: string; number: number }>(
        "select id, number from submit_to_ops($1, 'new', 5000000, 'stock')",
        [id],
      ),
    )
  ).rows[0]!;
  const subs = lenders.length
    ? (
        await asManager((q) =>
          q.query<{ id: string; funder_id: string }>(
            "select id, funder_id from create_submissions($1, $2::uuid[])",
            [id, lenders],
          ),
        )
      ).rows
    : [];
  return {
    id,
    deal: deal.id,
    number: deal.number,
    subs: subs.map((s) => s.id),
    /** The lender row by funder: create_submissions does not return them in the order asked. */
    by: Object.fromEntries(subs.map((s) => [s.funder_id, s.id])) as Record<string, string>,
  };
}

/** A proposed update the AI read on a lender row, applied the way a manager's yes (or the auto path) does. */
async function applied(
  m: { deal: string; subs: string[] },
  event: string,
  payload: Record<string, unknown>,
  summary: string,
  source: "email" | "pasted" = "email",
) {
  const u = await one<{ id: string }>(
    `insert into proposed_updates (deal_id, submission_id, event, payload, evidence, confidence, status, summary, source)
     values ($1, $2, $3, $4::jsonb, '[]'::jsonb, 0.9, 'proposed', $5, $6) returning id`,
    [m.deal, m.subs[0], event, JSON.stringify(payload), summary, source],
  );
  await asManager((q) => q.query("select apply_proposed_update($1)", [u.id]));
  return u.id;
}

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  ops = await insertUser(t.pool, "ops@x.com", "America/New_York");
  manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
  await t.pool.query("update app_users set role = 'ops', name = 'Olive' where id = $1", [ops]);
  await t.pool.query("update app_users set name = 'Josh' where id = $1", [rep]);
  pearl = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email) values ($1, 'Pearl', 'subs@pearl.com') returning id",
      [manager],
    )
  ).rows[0]!.id;
  fora = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email) values ($1, 'Fora', 'subs@fora.com') returning id",
      [manager],
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  await t.drop();
});

describe("the Review tray's applied list", () => {
  it("lists what the AI applied with the status it replaced, and the one it is in now", async () => {
    const m = await merchant("Applied Co", [pearl]);
    await applied(m, "declined", { decline_reason: "revenue" }, "Pearl declined: revenue too low");
    const list = await asManager((q) => listAppliedUpdates(q));
    const row = list.find((u) => u.business_name === "Applied Co");
    expect(row).toMatchObject({
      event: "declined",
      status: "applied",
      source: "email",
      funder_name: "Pearl",
      previous_status: "sent",
      current_status: "declined",
      created_offer: false,
      can_undo: true,
      deal_number: m.number,
    });
  });

  it("leaves out what is still a proposal, what changed no lender row, and what is older than the window", async () => {
    const m = await merchant("Not Listed Co", [pearl]);
    await t.pool.query(
      `insert into proposed_updates (deal_id, submission_id, event, payload, confidence, status, summary)
       values ($1, $2, 'declined', '{}'::jsonb, 0.9, 'proposed', 'still waiting')`,
      [m.deal, m.subs[0]],
    );
    const old = await merchant("Old Update Co", [pearl]);
    const oldId = await applied(old, "declined", {}, "an old one");
    await t.pool.query(
      "update proposed_updates set decided_at = now() - interval '20 days', created_at = now() - interval '21 days' where id = $1",
      [oldId],
    );
    const list = await asManager((q) => listAppliedUpdates(q));
    expect(list.some((u) => u.business_name === "Not Listed Co")).toBe(false);
    expect(list.some((u) => u.business_name === "Old Update Co")).toBe(false);
    expect(
      (await asManager((q) => listAppliedUpdates(q, 30))).some(
        (u) => u.business_name === "Old Update Co",
      ),
    ).toBe(true);
  });

  it("offers Undo only on the newest applied update of a lender row, never on a funding", async () => {
    const m = await merchant("Two Updates Co", [pearl]);
    const first = await applied(m, "stip_requested", { stip_rows: [] }, "Pearl wants stips");
    const second = await applied(
      m,
      "approved",
      { amount_cents: 3_000_000, factor_rate: 1.3 },
      "Pearl approved",
    );
    // the clock the two rows share is one transaction apart; make the order unambiguous
    await t.pool.query(
      "update proposed_updates set decided_at = now() - interval '1 hour' where id = $1",
      [first],
    );
    const rows = (await asManager((q) => listAppliedUpdates(q))).filter(
      (u) => u.business_name === "Two Updates Co",
    );
    expect(rows.find((u) => u.id === second)).toMatchObject({
      can_undo: true,
      created_offer: true,
      previous_status: "stips_requested",
    });
    expect(rows.find((u) => u.id === first)).toMatchObject({
      can_undo: false,
      previous_status: "sent",
    });
    const f = await merchant("Funded Update Co", [pearl]);
    await applied(f, "funded", {}, "Pearl says funded");
    expect(
      (await asManager((q) => listAppliedUpdates(q))).find(
        (u) => u.business_name === "Funded Update Co",
      )?.can_undo,
    ).toBe(false);
  });

  it("shows an undone update as undone, with who undid it, and the row is back where it was", async () => {
    const m = await merchant("Undone Co", [pearl]);
    const id = await applied(m, "declined", { decline_reason: "revenue" }, "Pearl declined");
    await asManager((q) => q.query("select revert_ai_update($1)", [id]));
    expect(
      (await one<{ status: string }>("select status from submissions where id = $1", [m.subs[0]]))
        .status,
    ).toBe("sent");
    const row = (await asManager((q) => listAppliedUpdates(q))).find(
      (u) => u.business_name === "Undone Co",
    );
    expect(row).toMatchObject({
      status: "reverted",
      can_undo: false,
      reverted_by_name: "Boss",
      previous_status: "sent",
    });
  });

  it("is not in ops' view (proposed_updates is manager and deal owner only), and the SQL function refuses ops an undo", async () => {
    const m = await merchant("Ops Undo Co", [pearl]);
    const id = await applied(m, "declined", {}, "declined");
    const list = await t.db.withUser(ops, (q) => listAppliedUpdates(q));
    expect(list.find((u) => u.id === id)).toBeUndefined();
    expect((await asManager((q) => listAppliedUpdates(q))).find((u) => u.id === id)).toMatchObject({
      can_undo: true,
    });
    await expect(
      t.db.withUser(ops, (q) => q.query("select revert_ai_update($1)", [id])),
    ).rejects.toThrow(/only a manager/);
    expect(
      (await one<{ status: string }>("select status from submissions where id = $1", [m.subs[0]]))
        .status,
    ).toBe("declined");
  });
});

describe("chase drafts", () => {
  const sent: { userId: string; to: string; thread?: string; inReplyTo?: string }[] = [];
  const sendFor =
    (userId: string): Sender =>
    async (mail) => {
      sent.push({ userId, to: mail.to, thread: mail.threadId, inReplyTo: mail.inReplyTo });
      return { id: "g1", threadId: mail.threadId ?? "t1" };
    };
  /** The next weekday at 10:00 New York, so a chase may go out. */
  const businessMorning = (): Date => {
    const d = new Date();
    d.setUTCHours(15, 0, 0, 0);
    if (d < new Date()) d.setUTCDate(d.getUTCDate() + 1);
    while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  };
  let m: Awaited<ReturnType<typeof merchant>>;
  let alertId: string;

  beforeAll(async () => {
    m = await merchant("Draft Co", [pearl, fora]);
    await t.pool.query(
      "update submissions set sent_via = 'crm', gmail_thread_id = 'thr', gmail_message_id = '<m@x>', created_at = now() - interval '7 days' where deal_id = $1",
      [m.deal],
    );
    await t.pool.query("update shop_settings set lender_chase_mode = 'draft'");
    const summary = await t.db.withSystem((q) => autoChase(q, { sendFor, now: businessMorning() }));
    expect(summary.drafted).toBeGreaterThanOrEqual(2);
  });

  it("lists the drafts the nightly chase wrote, as the ops user who got them sees them", async () => {
    const drafts = await t.db.withUser(ops, (q) => listChaseDrafts(q));
    const d = drafts.find((x) => x.business_name === "Draft Co" && x.funder_name === "Pearl")!;
    expect(d).toMatchObject({
      deal_id: m.deal,
      deal_number: m.number,
      submission_id: m.by[pearl],
      moot: false,
      to: "subs@pearl.com",
      subject: `Re: [D-${m.number}] Draft Co`,
    });
    expect(d.text).toContain("Any update on Draft Co");
    expect(d.why).toMatch(/quiet for \d+ business days/);
    alertId = d.id;
    // the draft is the ops user's alone: another person's list does not have it
    expect((await t.db.withUser(rep, (q) => listChaseDrafts(q))).length).toBe(0);
    // what the generator wrote is what the parser reads back
    const raw = await one<{ body: string }>("select body from user_alerts where id = $1::bigint", [
      alertId,
    ]);
    expect(parseChaseDraft(raw.body).to).toBe("subs@pearl.com");
  });

  it("sends on the lender's thread from the deal's rep, puts the count back, and clears the draft", async () => {
    const before = await one<{ chase_count: number }>(
      "select chase_count from submissions where id = $1",
      [m.by[pearl]],
    );
    expect(before.chase_count).toBe(1); // the draft already counted as the first chase
    const r = await t.db.withUser(ops, (q) => sendChaseDraft(q, { alertId, sendFor }));
    expect(r.funderName).toBe("Pearl");
    const mail = sent.at(-1)!;
    expect(mail).toMatchObject({
      userId: rep,
      to: "subs@pearl.com",
      thread: "thr",
      inReplyTo: "<m@x>",
    });
    const after = await one<{ chase_count: number; chased: boolean; read: boolean; lines: number }>(
      `select s.chase_count, s.last_chased_at is not null as chased,
              (select read_at is not null from user_alerts where id = $2::bigint) as read,
              (select count(*)::int from activities where client_id = $3 and body = 'Chased Pearl for an answer') as lines
         from submissions s where s.id = $1`,
      [m.by[pearl], alertId, m.id],
    );
    expect(after).toEqual({ chase_count: 1, chased: true, read: true, lines: 1 });
    await expect(
      t.db.withUser(ops, (q) => sendChaseDraft(q, { alertId, sendFor })),
    ).rejects.toThrow(/already dealt with/);
    expect(
      (await t.db.withUser(ops, (q) => listChaseDrafts(q))).some((x) => x.id === alertId),
    ).toBe(false);
  });

  it("refuses a draft for a lender that answered since, and one that is not the person's", async () => {
    const d = (await t.db.withUser(ops, (q) => listChaseDrafts(q))).find(
      (x) => x.funder_name === "Fora",
    )!;
    await asManager((q) =>
      q.query("select set_submission_status($1, 'declined', 'revenue', '')", [m.by[fora]]),
    );
    const moot = (await t.db.withUser(ops, (q) => listChaseDrafts(q))).find((x) => x.id === d.id)!;
    expect(moot.moot).toBe(true);
    const mailsBefore = sent.length;
    await expect(
      t.db.withUser(ops, (q) => sendChaseDraft(q, { alertId: d.id, sendFor })),
    ).rejects.toThrow(/has answered since/);
    await expect(
      t.db.withUser(rep, (q) => sendChaseDraft(q, { alertId: d.id, sendFor })),
    ).rejects.toThrow(/not in your list/);
    expect(sent.length).toBe(mailsBefore);
    expect(
      (
        await one<{ read_at: string | null }>(
          "select read_at from user_alerts where id = $1::bigint",
          [d.id],
        )
      ).read_at,
    ).toBeNull();
  });
});

describe("stips, state badge, application, AI readiness", () => {
  it("names a missing 'other' stip by the lender's words and the rest by their kind", async () => {
    const m = await merchant("Stips Co");
    await t.pool.query(
      `insert into stips (user_id, client_id, kind, required, label) values
         ($1, $2, 'other', true, 'Landlord letter on letterhead'),
         ($1, $2, 'tax_return', true, ''),
         ($1, $2, 'voided_check', true, 'ignored on this kind')`,
      [rep, m.id],
    );
    expect(await t.db.withUser(rep, (q) => missingStipLabels(q, m.id))).toEqual(
      expect.arrayContaining(["Landlord letter on letterhead", "Tax return", "Voided check"]),
    );
    // received ones are not missing
    await t.pool.query(
      "update stips set received_at = now() where client_id = $1 and kind = 'tax_return'",
      [m.id],
    );
    const left = await t.db.withUser(rep, (q) => missingStipLabels(q, m.id));
    expect(left).not.toContain("Tax return");
    expect(left).not.toContain("Other document");
  });

  it("reads the rules and the shop's registration for the merchant's state", async () => {
    await t.pool.query("delete from shop_registrations where state = 'CT'");
    const stop = await t.db.withUser(rep, (q) => loadStateBadge(q, "Connecticut", t.today));
    expect(stop).toMatchObject({ state: "CT", tone: "stop", label: "CT · not registered" });
    await t.pool.query(
      "insert into shop_registrations (state, registration_no, status, renews_on) values ('CT', 'X-1', 'registered', current_date + 400)",
    );
    const ok = await t.db.withUser(rep, (q) => loadStateBadge(q, "ct", t.today));
    expect(ok.label).toBe("CT · registered");
    expect(ok.warnings.some((w) => /disclosure must be signed/.test(w))).toBe(true);
    await t.pool.query("update shop_registrations set status = 'filed' where state = 'CT'");
    expect((await t.db.withUser(rep, (q) => loadStateBadge(q, "CT", t.today))).warnings[0]).toMatch(
      /filed, not yet granted/,
    );
    expect((await t.db.withUser(rep, (q) => loadStateBadge(q, "Narnia", t.today))).label).toBe(
      "Unknown state: Narnia",
    );
    expect((await t.db.withUser(rep, (q) => loadStateBadge(q, "", t.today))).label).toBe(
      "No state on file",
    );
    expect((await t.db.withUser(rep, (q) => loadStateBadge(q, "OH", t.today))).label).toBe(
      "OH · no special rules",
    );
  });

  it("gives the merchant's application token and its latest signed application", async () => {
    const m = await merchant("Apply Co");
    const info = await t.db.withUser(rep, (q) => loadApplicationInfo(q, m.id));
    const token = (
      await one<{ application_token: string }>(
        "select application_token from clients where id = $1",
        [m.id],
      )
    ).application_token;
    expect(info).toEqual({ token, latest: null });
    const doc = await one<{ id: string }>(
      `insert into documents (user_id, client_id, kind, filename, content_type, size_bytes, sha256, storage_key, source, scan_status)
       values ($1, $2, 'signed_application', 'app.pdf', 'application/pdf', 100, $3, 'k/apply-co', 'upload_link', 'clean') returning id`,
      [rep, m.id, "b".repeat(64)],
    );
    await t.pool.query(
      "insert into applications (client_id, user_id, document_id, fields, signer_name) values ($1, $2, $3, '{}'::jsonb, 'Pat Owner')",
      [m.id, rep, doc.id],
    );
    const signed = await t.db.withUser(rep, (q) => loadApplicationInfo(q, m.id));
    expect(signed?.latest).toMatchObject({ signer_name: "Pat Owner", document_id: doc.id });
    // another rep's merchant is not in view
    expect(await t.db.withUser(ops, (q) => loadApplicationInfo(q, m.id))).not.toBeNull();
  });

  it("says why the AI cannot run: no key, the kill switch, the spend cap, in that order", async () => {
    await t.pool.query("update shop_settings set ai_enabled = true, ai_daily_cap_cents = 2000");
    expect(await t.db.withUser(rep, (q) => aiBlockedReason(q, true))).toBeNull();
    expect(await t.db.withUser(rep, (q) => aiBlockedReason(q, false))).toMatch(/no Anthropic key/);
    await t.pool.query("update shop_settings set ai_enabled = false");
    expect(await t.db.withUser(rep, (q) => aiBlockedReason(q, true))).toBe(
      "The AI is switched off in Settings.",
    );
    await t.pool.query("update shop_settings set ai_enabled = true, ai_daily_cap_cents = 0");
    expect(await t.db.withUser(rep, (q) => aiBlockedReason(q, true))).toMatch(
      /spend cap is used up/,
    );
  });

  it("asks every manager, which the Ask manager button relies on", async () => {
    const m = await merchant("Ask Co");
    const n = await t.db.withUser(rep, (q) =>
      askManager(q, { dealId: m.deal, question: "Can we push Pearl?" }),
    );
    expect(n).toBe(1);
    const alert = await one<{ user_id: string; kind: string; body: string }>(
      "select user_id, kind, body from user_alerts where deal_id = $1 and kind = 'ask_manager'",
      [m.deal],
    );
    expect(alert).toMatchObject({ user_id: manager, kind: "ask_manager" });
    expect(alert.body.startsWith("Can we push Pearl?")).toBe(true);
  });
});
