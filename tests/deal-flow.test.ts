import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { milestones, suggestNextStep, type DealSnapshot } from "@/lib/deals/nextStep";
import { loadDealSnapshot } from "@/lib/deals/snapshot";
import { listDealTimeline } from "@/lib/deals/timeline";
import { autoChase, type Sender } from "@/lib/inbox/submit";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

const base: DealSnapshot = {
  today: "2026-11-16",
  status: "working",
  contact_name: "Mike",
  business_name: "Pizza Palace",
  created_on: "2026-11-10",
  queued_at: "2026-11-10T15:00:00Z",
  kicked_back_at: null,
  kickback_reason: null,
  kickback_note: "",
  sent_on: null,
  blocker: "",
  reply_waiting: false,
  reply_subject: "",
  lenders: [],
  offers: [],
  stips_missing: [],
  statement_wanted: null,
  funding: null,
  ai_next_step: null,
  chase_after_days: 3,
};
const lender = (over: Partial<DealSnapshot["lenders"][number]>) => ({
  name: "Pearl",
  status: "sent",
  sent_on: "2026-11-11",
  responded_on: null,
  last_chased_on: null,
  chase_count: 0,
  approval_expires_on: null,
  stips: [],
  decline_reason: null,
  ...over,
});
const offer = (over: Partial<DealSnapshot["offers"][number]>) => ({
  funder_name: "Pearl",
  amount_cents: 5_000_000,
  factor_rate: 1.35,
  status: "open",
  received_on: "2026-11-14",
  expires_on: null,
  ...over,
});

describe("what now", () => {
  it("a waiting reply beats everything", () => {
    const s = suggestNextStep({
      ...base,
      status: "needs_pitch",
      reply_waiting: true,
      reply_subject: "Re: docs",
    });
    expect(s).toMatchObject({ title: "Answer Mike", urgency: "now", action: "answer" });
  });
  it("names the kickback reason and the stips", () => {
    expect(
      suggestNextStep({
        ...base,
        status: "kicked_back",
        kickback_reason: "missing_statement_month",
        kickback_note: "need Oct",
      }),
    ).toMatchObject({
      title: "Fix the file: A statement month is missing",
      why: "need Oct",
      urgency: "now",
    });
    const s = suggestNextStep({
      ...base,
      status: "stips_needed",
      lenders: [lender({ status: "stips_requested", stips: ["voided check", "DL"] })],
    });
    expect(s.title).toBe("Collect voided check, DL");
    expect(s.action).toBe("collect_stips");
  });
  it("presents the best open offer and warns about expiry", () => {
    const s = suggestNextStep({
      ...base,
      status: "needs_pitch",
      offers: [
        offer({ amount_cents: 3_000_000 }),
        offer({ amount_cents: 5_000_000, expires_on: "2026-11-18" }),
      ],
    });
    expect(s.title).toBe("Present Pearl: $50,000 at 1.35");
    expect(s.why).toBe("The approval expires in 2 days.");
    expect(s.urgency).toBe("now");
  });
  it("pushes to close a presented offer as it ages", () => {
    expect(
      suggestNextStep({
        ...base,
        status: "pitched",
        offers: [offer({ status: "presented", received_on: "2026-11-15" })],
      }),
    ).toMatchObject({ title: "Get the yes", urgency: "soon" });
    expect(
      suggestNextStep({
        ...base,
        status: "pitched",
        offers: [offer({ status: "presented", received_on: "2026-11-12" })],
      }),
    ).toMatchObject({ title: "Close it: offer presented 4 days ago", urgency: "today" });
    expect(
      suggestNextStep({
        ...base,
        status: "pitched",
        offers: [
          offer({ status: "presented", received_on: "2026-11-12", expires_on: "2026-11-17" }),
        ],
      }).urgency,
    ).toBe("now");
  });
  it("chases quiet lenders after the shop's window and waits otherwise", () => {
    const quiet = suggestNextStep({
      ...base,
      status: "pending_lenders",
      sent_on: "2026-11-11",
      lenders: [lender({}), lender({ name: "Fora", sent_on: "2026-11-15" })],
    });
    expect(quiet).toMatchObject({ title: "Chase Pearl", action: "chase", targets: ["Pearl"] });
    const waiting = suggestNextStep({
      ...base,
      status: "pending_lenders",
      sent_on: "2026-11-15",
      lenders: [lender({ sent_on: "2026-11-15" })],
    });
    expect(waiting).toMatchObject({ title: "Waiting on 1 lender", urgency: "soon" });
    // a chase resets the clock
    expect(
      suggestNextStep({
        ...base,
        status: "pending_lenders",
        lenders: [lender({ last_chased_on: "2026-11-15" })],
      }).action,
    ).toBe("wait");
  });
  it("knows the rest of the road", () => {
    expect(
      suggestNextStep({ ...base, status: "working_ops", queued_at: "2026-11-16T10:00:00Z" })
        .urgency,
    ).toBe("none");
    expect(
      suggestNextStep({ ...base, status: "working_ops", queued_at: "2026-11-13T10:00:00Z" }).title,
    ).toBe("Ping ops");
    expect(
      suggestNextStep({
        ...base,
        status: "declined_by_all",
        lenders: [lender({ status: "declined", decline_reason: "nsfs" })],
      }).why,
    ).toMatch(/nsfs/);
    expect(
      suggestNextStep({
        ...base,
        status: "funded",
        funding: {
          funded_on: "2026-09-01",
          renewal_eligible_on: "2026-11-10",
          ledger_state: "clear",
        },
      }).action,
    ).toBe("renewal");
    expect(
      suggestNextStep({
        ...base,
        status: "funded",
        funding: {
          funded_on: "2026-11-01",
          renewal_eligible_on: "2027-02-01",
          ledger_state: "at_risk",
        },
      }).urgency,
    ).toBe("none");
    expect(suggestNextStep({ ...base, stips_missing: ["Voided check"] }).title).toBe(
      "Collect Voided check",
    );
    expect(suggestNextStep({ ...base, statement_wanted: "October 2026" }).title).toBe(
      "Get the October 2026 statement",
    );
    expect(suggestNextStep(base)).toMatchObject({ title: "Submit to ops", action: "submit" });
    expect(suggestNextStep({ ...base, status: "funding_call" }).action).toBe("fund");
  });
  it("milestone chips mark what is done and what is next", () => {
    const m = milestones({
      ...base,
      status: "needs_pitch",
      sent_on: "2026-11-11",
      lenders: [lender({ status: "approved", responded_on: "2026-11-14" })],
      offers: [offer({})],
    });
    expect(m.map((x) => [x.key, x.done, x.current])).toEqual([
      ["file", true, false],
      ["ops", true, false],
      ["lenders", true, false],
      ["answer", true, false],
      ["approved", true, false],
      ["presented", false, true],
      ["contracts", false, false],
      ["funded", false, false],
    ]);
    expect(m.find((x) => x.key === "approved")?.on).toBe("2026-11-14");
    expect(milestones({ ...base, status: "declined_by_all" }).some((x) => x.current)).toBe(false);
  });
});

describe("timeline, snapshot and auto-chase", () => {
  let t: TestDb;
  let rep: string;
  let manager: string;
  let pizza: string;
  let pearl: string;
  let deal: string;

  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
    await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
      manager,
    ]);
    await t.pool.query("update app_users set name = 'Josh' where id = $1", [rep]);
    pizza = await insertClient(t.db, rep, "Pizza Palace");
    await t.pool.query("update clients set email = 'mike@pizza.com' where id = $1", [pizza]);
    pearl = (
      await t.pool.query<{ id: string }>(
        "insert into funders (user_id, name, submission_email) values ($1, 'Pearl', 'subs@pearl.com') returning id",
        [manager],
      )
    ).rows[0]!.id;
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [pizza]));
    deal = (
      await t.pool.query<{ id: string }>("select id from deals where client_id = $1", [pizza])
    ).rows[0]!.id;
    await t.pool.query(
      "update deals set ops_status = 'sent', sent_at = now() - interval '5 days', requested_cents = 5000000 where id = $1",
      [deal],
    );
    await t.pool.query(
      `insert into submissions (user_id, client_id, funder_id, deal_id, sent_on, status, sent_via, gmail_thread_id, gmail_message_id, created_at)
       values ($1, $2, $3, $4, current_date - 5, 'sent', 'crm', 'thr_1', '<m1@x>', now() - interval '5 days')`,
      [rep, pizza, pearl, deal],
    );
  });
  afterAll(async () => {
    await t.drop();
  });

  it("the snapshot says to chase the quiet lender; the auto-chase does it from the rep's own mailbox, once per window", async () => {
    const snap = await t.db.withUser(rep, (q) => loadDealSnapshot(q, deal, t.today));
    expect(snap?.status).toBe("pending_lenders");
    expect(suggestNextStep(snap!)).toMatchObject({ action: "chase", targets: ["Pearl"] });

    const sent: {
      userId: string;
      to: string;
      subject: string;
      threadId?: string;
      inReplyTo?: string;
    }[] = [];
    const sendFor =
      (userId: string): Sender =>
      async (m) => {
        sent.push({
          userId,
          to: m.to,
          subject: m.subject,
          threadId: m.threadId,
          inReplyTo: m.inReplyTo,
        });
        return { id: `g_${sent.length}`, threadId: m.threadId ?? "new" };
      };
    // the chase only goes out in business hours (0510 / S2-6): run it as of the next weekday morning, New York
    const now = new Date();
    now.setUTCHours(15, 0, 0, 0);
    if (now < new Date()) now.setUTCDate(now.getUTCDate() + 1);
    while ([0, 6].includes(now.getUTCDay())) now.setUTCDate(now.getUTCDate() + 1);
    expect(await t.db.withSystem((q) => autoChase(q, { sendFor, now }))).toMatchObject({
      chased: 1,
      skipped: 0,
    });
    expect(sent[0]).toEqual({
      userId: rep,
      to: "subs@pearl.com",
      subject: "Re: [D-1] Pizza Palace",
      threadId: "thr_1",
      inReplyTo: "<m1@x>",
    });
    expect(sent[0]).toBeDefined();
    // just chased → nothing more today
    expect(await t.db.withSystem((q) => autoChase(q, { sendFor, now }))).toMatchObject({
      chased: 0,
      skipped: 0,
    });
    const after = await t.db.withUser(rep, (q) => loadDealSnapshot(q, deal, t.today));
    expect(suggestNextStep(after!).action).toBe("wait");
    // the switch in Settings turns it off
    await t.pool.query("update shop_settings set lender_chase_mode = 'off'");
    await t.pool.query(
      "update submissions set last_chased_at = now() - interval '10 days' where deal_id = $1",
      [deal],
    );
    expect(await t.db.withSystem((q) => autoChase(q, { sendFor, now }))).toMatchObject({
      chased: 0,
      skipped: 0,
    });
  });

  it("the timeline merges ops, lender rows, chases, offers, documents and the funding, newest first", async () => {
    const sub = (
      await t.pool.query<{ id: string }>("select id from submissions where deal_id = $1", [deal])
    ).rows[0]!.id;
    await t.pool.query(
      "update submissions set status = 'approved', responded_at = now(), status_changed_at = now(), source = 'email' where id = $1",
      [sub],
    );
    await t.pool.query(
      "insert into offers (user_id, client_id, submission_id, deal_id, amount_cents, factor_rate, received_on, status) values ($1, $2, $3, $4, 4500000, 1.32, current_date, 'open')",
      [rep, pizza, sub, deal],
    );
    await t.db.withUser(rep, (q) =>
      q.query(
        "insert into activities (user_id, client_id, kind, outcome, body) values ($1, $2, 'call', 'reached', 'Walked him through the offer')",
        [rep, pizza],
      ),
    );
    const tl = await t.db.withUser(rep, (q) => listDealTimeline(q, deal));
    const titles = tl.map((e) => `${e.kind}:${e.title}`);
    expect(titles[0]).toBe("call:Call — reached");
    expect(titles).toContain("offer:Offer from Pearl: $45,000 at 1.320");
    expect(titles).toContain("lender:Pearl: approved");
    expect(titles).toContain("lender:Sent to Pearl");
    expect(titles).toContain("email_out:Chased Pearl");
    expect(titles).toContain("ops:Submitted to ops");
    expect(titles).toContain("ops:Sent to lenders");
    expect(tl.find((e) => e.title === "Pearl: approved")?.actor).toBe("AI");
    expect(tl.find((e) => e.kind === "call")?.actor).toBe("Josh");
    // ordered newest first
    const ats = tl.map((e) => e.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    // the snapshot now says: present it
    const snap = await t.db.withUser(rep, (q) => loadDealSnapshot(q, deal, t.today));
    expect(snap?.status).toBe("needs_pitch");
    expect(suggestNextStep(snap!).title).toBe("Present Pearl: $45,000 at 1.32");
    expect(milestones(snap!).find((m) => m.current)?.key).toBe("presented");
    // RLS: another rep sees nothing
    const other = await insertUser(t.pool, "other@x.com");
    expect(await t.db.withUser(other, (q) => listDealTimeline(q, deal))).toEqual([]);
    expect(await t.db.withUser(other, (q) => loadDealSnapshot(q, deal, t.today))).toBeNull();
  });
});
