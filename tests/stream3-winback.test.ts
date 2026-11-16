import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyOpener, type OpenerInput, type OpenerOutcome } from "@/lib/ai/draftWinbackOpener";
import { confirmFunding, fundSchema, proposeFunding } from "@/lib/money/fund";
import {
  hotList,
  listWinback,
  listWinbackReasons,
  mergeOpener,
  reviewWinbackOpener,
  runRescueNudges,
  runWinback,
  setWinbackReason,
  winbackRecovered,
  type OpenerDrafter,
} from "@/lib/money/winback";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let manager: string;
let pearl: string;

const APP = "https://crm.test";

const fakeDrafter =
  (line: (i: OpenerInput) => string): OpenerDrafter =>
  async (i, model) => {
    const result = { opener: line(i), facts_used: [] as string[] };
    return {
      result,
      model,
      inputTokens: 100,
      outputTokens: 20,
      inputHash: "h",
      problems: verifyOpener(i, result),
    } satisfies OpenerOutcome;
  };

let phones = 0;

/**
 * Each merchant gets its own phone: the helper's one number would make every merchant here the same owner to the
 * double-submission guard (0512, same phone or email = same file), which refuses the second file to Pearl.
 */
async function merchant(name: string, email: string): Promise<string> {
  const id = await insertClient(t.db, rep, name);
  phones += 1;
  await t.pool.query(
    "update clients set state = 'NY', email = $2, contact_name = 'Mike Ross', phone = $3 where id = $1",
    [id, email, `555${String(1_000_000 + phones)}`],
  );
  return id;
}

/** A merchant with an open deal and an approval from Pearl `daysAgo` days back. */
async function approved(name: string, email: string, daysAgo: number, amount = 8_000_000) {
  const id = await merchant(name, email);
  await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [id]));
  const sub = (await t.db.withUser(
    manager,
    async (q) =>
      (
        await q.query<{ id: string }>("select id from create_submissions($1, $2::uuid[])", [
          id,
          [pearl],
        ])
      ).rows[0],
  ))!.id;
  await t.db.withUser(manager, (q) =>
    q.query("select record_offer($1, $2::jsonb)", [
      sub,
      JSON.stringify({ amount_cents: amount, factor_rate: 1.3 }),
    ]),
  );
  await t.pool.query(
    "update submissions set responded_at = now() - make_interval(days => $2), status = 'approved' where id = $1",
    [sub, daysAgo],
  );
  return { id, sub };
}

const member = async (clientId: string, pool?: string) =>
  (
    await t.pool.query<{
      id: string;
      pool: string;
      status: string;
      stop_reason: string | null;
      opener: string;
      opener_status: string;
      why_not_funded: string | null;
      source_id: string | null;
    }>(
      "select id, pool, status, stop_reason, opener, opener_status, why_not_funded, source_id from winback_members where client_id = $1 and ($2::text is null or pool = $2) order by created_at",
      [clientId, pool ?? null],
    )
  ).rows;
const outbox = async (clientId: string) =>
  (
    await t.pool.query<{ source: string; subject: string; text_body: string }>(
      "select source, subject, text_body from outbox where client_id = $1 order by created_at",
      [clientId],
    )
  ).rows;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager' where id = $1", [manager]);
  await t.pool.query("update app_users set name = 'Josh Reps' where id = $1", [rep]);
  pearl = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email) values ($1, 'Pearl', 'subs@pearl.com') returning id",
      [manager],
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  await t.drop();
});

describe("the opener checks (pure)", () => {
  const input: OpenerInput = {
    businessName: "Golden Wok",
    contactFirstName: "Mike",
    pool: "approved_unfunded",
    reason: "Approved $80,000 by Pearl on 2026-10-01",
    whyNotFunded: "Terms were too high",
    bestOffer: { funderName: "Pearl", amountDollars: 80_000, factorRate: 1.3 },
    monthsSince: 2,
    state: "NY",
  };
  it("a line built from the facts passes; an invented number, a claim word or a second line does not", () => {
    expect(
      verifyOpener(input, {
        opener:
          "Pearl's $80,000 approval for Golden Wok is still on my desk, and I know the 1.3 felt high.",
        facts_used: [],
      }),
    ).toEqual([]);
    expect(verifyOpener(input, { opener: "Pearl can do $95,000 now.", facts_used: [] })).toEqual([
      "number not in the facts: $95,000",
    ]);
    expect(
      verifyOpener(input, { opener: "You are pre-approved for a loan.", facts_used: [] }),
    ).toEqual(["claim word: pre-approved", "claim word: loan"]);
    expect(verifyOpener(input, { opener: "Line one.\nLine two.", facts_used: [] })).toEqual([
      "more than one line",
    ]);
    expect(verifyOpener(input, { opener: "Great news!", facts_used: [] })).toEqual([
      "exclamation mark",
    ]);
    expect(
      verifyOpener(
        { ...input, pool: "cold", reason: "No reply", bestOffer: null },
        { opener: "Your approval is waiting.", facts_used: [] },
      ),
    ).toEqual(["says approved without an approval"]);
  });
  it("{opener} merges into the body, or vanishes with its blank line", () => {
    expect(mergeOpener("Hi {first_name},\n\n{opener}\n\nBody.", "Line.")).toBe(
      "Hi {first_name},\n\nLine.\n\nBody.",
    );
    expect(mergeOpener("Hi {first_name},\n\n{opener}\n\nBody.", "")).toBe(
      "Hi {first_name},\n\nBody.",
    );
    expect(mergeOpener("No placeholder.", "Line.")).toBe("No placeholder.");
  });
});

describe("S3-11 pools 2–5, the stops, Cold → win-back, finished stays finished", () => {
  it("a curable decline lands in the pool at its cure date; a reply stops it; it never re-enrols for the same deal", async () => {
    const { id, sub } = await approved("Declined Deli", "d@d.com", 5);
    await t.db.withUser(manager, (q) =>
      q.query("select set_submission_status($1, 'declined', 'revenue')", [sub]),
    );
    await t.pool.query(
      "update submissions set status_changed_at = now() - interval '100 days' where id = $1",
      [sub],
    );
    await runWinback({ db: t.db, appUrl: APP });
    const m = await member(id, "declined_curable");
    expect(m).toHaveLength(1);
    expect(m[0]?.status).toBe("active"); // 100 days > the 90-day cure
    expect(m[0]?.source_id).not.toBeNull();
    expect((await outbox(id))[0]?.source).toBe("winback:declined_curable:1");
    // the merchant writes back: the sequence stops and the rep takes over
    await t.pool.query(
      "select record_merchant_reply($1, 'Re: Worth another look', 'call me', 'd@d.com')",
      [id],
    );
    expect((await member(id, "declined_curable"))[0]?.status).toBe("replied");
    await t.pool.query("update clients set reply_waiting_since = null where id = $1", [id]);
    await runWinback({ db: t.db, appUrl: APP });
    await runWinback({ db: t.db, appUrl: APP });
    expect(await member(id, "declined_curable")).toHaveLength(1);
  });
  it("took another offer: back when that advance is half paid; an opt-out stops it", async () => {
    const id = await merchant("Lost Lanes", "l@l.com");
    await t.pool.query(
      "update clients set stage = 'lost', stage_changed_at = now() - interval '100 days' where id = $1",
      [id],
    );
    await t.pool.query(
      "insert into competing_offers (user_id, client_id, funder_name, amount_cents, factor_rate, term_days, offered_on, won) values ($1, $2, 'Rival', 4000000, 1.4, 180, current_date - 100, true)",
      [rep, id],
    );
    await runWinback({ db: t.db, appUrl: APP });
    const m = await member(id, "funded_elsewhere");
    expect(m).toHaveLength(1);
    expect(m[0]?.status).toBe("active"); // offered 100 days ago, term 180 → workable at day 90
    await t.db.withUser(rep, (q) =>
      q.query("select opt_out($1, 'email', 'unsubscribe', 'footer link')", [id]),
    );
    await runWinback({ db: t.db, appUrl: APP });
    expect((await member(id, "funded_elsewhere"))[0]).toMatchObject({
      status: "stopped",
      stop_reason: "opted_out",
    });
    await runWinback({ db: t.db, appUrl: APP });
    expect(await member(id, "funded_elsewhere")).toHaveLength(1);
  });
  it("paid off: in the pool the same day; the sequence runs out and does not restart; a new payoff is a new membership", async () => {
    const id = await merchant("Paid Off Pizza", "p@p.com");
    await t.pool.query(
      "insert into fundings (user_id, client_id, funded_on, funder_name, amount_cents, factor_rate, payment_cents, frequency, status) values ($1, $2, current_date - 200, 'Pearl', 3000000, 1.3, 30000, 'daily', 'paid_off')",
      [rep, id],
    );
    await runWinback({ db: t.db, appUrl: APP });
    expect((await member(id, "paid_off"))[0]).toMatchObject({ status: "active" });
    // walk the two-step sequence to its end: day 0 went; day 14 goes when due; then the sequence is done
    await t.pool.query(
      "update winback_members set next_due_on = current_date where client_id = $1",
      [id],
    );
    await runWinback({ db: t.db, appUrl: APP });
    expect((await member(id, "paid_off"))[0]).toMatchObject({
      status: "stopped",
      stop_reason: "sequence_done",
    });
    expect(await outbox(id)).toHaveLength(2);
    // the clocks roll twice more: still one membership, no third email
    await runWinback({ db: t.db, appUrl: APP });
    await runWinback({ db: t.db, appUrl: APP });
    expect(await member(id, "paid_off")).toHaveLength(1);
    expect(await outbox(id)).toHaveLength(2);
    // a second advance paid off is a genuinely new reason
    await t.pool.query(
      "insert into fundings (user_id, client_id, funded_on, funder_name, amount_cents, factor_rate, payment_cents, frequency, status) values ($1, $2, current_date - 10, 'Pearl', 4000000, 1.3, 40000, 'daily', 'paid_off')",
      [rep, id],
    );
    await runWinback({ db: t.db, appUrl: APP });
    expect(await member(id, "paid_off")).toHaveLength(2);
  });
  it("Cold → win-back: a merchant in the Cold bucket joins the cold pool once", async () => {
    const id = await merchant("Cold Cuts", "c@c.com");
    const cold = (await t.pool.query<{ id: string }>("select id from buckets where key = 'cold'"))
      .rows[0]!.id;
    await t.db.withUser(rep, (q) =>
      q.query("select enroll_in_bucket($1, $2, 'moved')", [id, cold]),
    );
    await runWinback({ db: t.db, appUrl: APP });
    await runWinback({ db: t.db, appUrl: APP });
    const m = await member(id, "cold");
    expect(m).toHaveLength(1);
    expect(m[0]?.status).toBe("active");
    expect((await outbox(id))[0]?.source).toBe("winback:cold:1");
  });
  // Stream 1 found refresh_winback_pools re-enrolling a finished member every night, for every pool; stream 3's
  // source_id guard (0524) closes it. The two pools the other tests do not walk to the end are walked here: the
  // clocks roll twice more after the last step and the merchant still has one membership and no extra email.
  it("approved, never funded: the five-step sequence runs out, and two more nights add nothing", async () => {
    const { id } = await approved("Finished Flowers", "finishedflowers@x.com", 40);
    await runWinback({ db: t.db, appUrl: APP });
    expect((await member(id, "approved_unfunded"))[0]?.status).toBe("active");
    for (let step = 2; step <= 5; step += 1) {
      await t.pool.query(
        "update winback_members set next_due_on = current_date where client_id = $1 and status = 'active'",
        [id],
      );
      await runWinback({ db: t.db, appUrl: APP });
    }
    expect((await member(id, "approved_unfunded"))[0]).toMatchObject({
      status: "stopped",
      stop_reason: "sequence_done",
    });
    expect(await outbox(id)).toHaveLength(5);
    await runWinback({ db: t.db, appUrl: APP });
    await runWinback({ db: t.db, appUrl: APP });
    expect(await member(id, "approved_unfunded")).toHaveLength(1);
    expect(await outbox(id)).toHaveLength(5);
  });
  it("Cold: when the pool's last nudge has gone the Cold enrolment ends too (0508), and two more nights add nothing", async () => {
    const id = await merchant("Cold Coffee", "coldcoffee@x.com");
    const cold = (await t.pool.query<{ id: string }>("select id from buckets where key = 'cold'"))
      .rows[0]!.id;
    await t.db.withUser(rep, (q) =>
      q.query("select enroll_in_bucket($1, $2, 'moved')", [id, cold]),
    );
    await runWinback({ db: t.db, appUrl: APP });
    for (let step = 2; step <= 3; step += 1) {
      await t.pool.query(
        "update winback_members set next_due_on = current_date where client_id = $1 and status = 'active'",
        [id],
      );
      await runWinback({ db: t.db, appUrl: APP });
    }
    expect((await member(id, "cold"))[0]).toMatchObject({
      status: "stopped",
      stop_reason: "sequence_done",
    });
    const enrolment = (
      await t.pool.query<{ stop_reason: string | null; live: boolean }>(
        "select stop_reason, stopped_at is null as live from enrollments where client_id = $1 and bucket_id = $2",
        [id, cold],
      )
    ).rows[0];
    expect(enrolment).toEqual({ stop_reason: "sequence_done", live: false });
    await runWinback({ db: t.db, appUrl: APP });
    await runWinback({ db: t.db, appUrl: APP });
    expect(await member(id, "cold")).toHaveLength(1);
    expect(await outbox(id)).toHaveLength(3);
  });
});

describe("S3-11 why-not-funded, the opener, the hot list, recovered money", () => {
  let wok: string;
  let wokMember: string;
  it("the pick-list answer lands on the member with a timeline line; an unknown reason is refused", async () => {
    wok = (await approved("Golden Wok", "wok@x.com", 40)).id;
    await runWinback({ db: t.db, appUrl: APP });
    const m = await member(wok, "approved_unfunded");
    expect(m[0]?.status).toBe("active");
    wokMember = m[0]!.id;
    expect((await t.db.withUser(rep, listWinbackReasons)).map((r) => r.key)).toContain("terms");
    await t.db.withUser(rep, (q) =>
      setWinbackReason(q, { memberId: wokMember, reason: "terms", note: "wanted 1.25" }),
    );
    expect((await member(wok))[0]?.why_not_funded).toBe("terms");
    const act = await t.pool.query(
      "select body from activities where client_id = $1 and body like 'Why it did not fund%'",
      [wok],
    );
    expect(act.rows[0]?.body).toBe("Why it did not fund: Terms were too high — wanted 1.25");
    await expect(
      t.db.withUser(rep, (q) => setWinbackReason(q, { memberId: wokMember, reason: "aliens" })),
    ).rejects.toThrow(/unknown reason/);
    expect(
      (await t.db.withUser(rep, listWinback)).find((r) => r.client_id === wok)?.why_not_funded,
    ).toBe("terms");
  });
  it("auto mode: the drafted line is checked, logged in ai_runs and merged into step 1 as {opener}", async () => {
    await t.pool.query("update shop_settings set winback_opener_mode = 'auto'");
    const { id } = await approved("Auto Autos", "a@a.com", 40);
    const drafter = fakeDrafter(
      (i) =>
        `${i.bestOffer?.funderName} approved ${i.businessName} for $${i.bestOffer?.amountDollars.toLocaleString("en-US")} and that file is still on my desk.`,
    );
    const s = await runWinback({ db: t.db, appUrl: APP, drafter });
    expect(s.drafted).toBe(1);
    const m = (await member(id, "approved_unfunded"))[0];
    expect(m).toMatchObject({
      opener_status: "approved",
      opener: "Pearl approved Auto Autos for $80,000 and that file is still on my desk.",
    });
    const ob = await outbox(id);
    expect(ob).toHaveLength(1);
    expect(ob[0]?.text_body).toContain(
      "Hi Mike,\n\nPearl approved Auto Autos for $80,000 and that file is still on my desk.\n\nAuto Autos was approved",
    );
    const runs = (
      await t.pool.query(
        "select purpose, prompt_version, cost_cents::text as cost from ai_runs where purpose = 'draft_winback'",
      )
    ).rows;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ prompt_version: "winback-opener-v1" });
    expect(Number(runs[0]?.cost)).toBeGreaterThan(0);
  });
  it("a line that fails the checks is kept as rejected and the email goes without it", async () => {
    const { id } = await approved("Bad Draft Bakery", "b@b.com", 40);
    const drafter = fakeDrafter(() => "Pearl can do $95,000 now, guaranteed.");
    const s = await runWinback({ db: t.db, appUrl: APP, drafter });
    expect(s.drafted).toBe(0);
    expect((await member(id, "approved_unfunded"))[0]).toMatchObject({
      opener_status: "rejected",
      opener: "Pearl can do $95,000 now, guaranteed.",
    });
    const ob = await outbox(id);
    expect(ob).toHaveLength(1);
    expect(ob[0]?.text_body).not.toContain("95,000");
    expect(ob[0]?.text_body).toContain("Hi Mike,\n\nBad Draft Bakery was approved");
  });
  it("review mode: step 1 waits for a manager, who approves an edited line; the kill switch drafts nothing", async () => {
    await t.pool.query("update shop_settings set winback_opener_mode = 'review'");
    const { id } = await approved("Review Roofing", "r@r.com", 40);
    const drafter = fakeDrafter(
      (i) =>
        `The ${i.bestOffer?.funderName} approval for ${i.businessName} is still open on my side.`,
    );
    const s = await runWinback({ db: t.db, appUrl: APP, drafter });
    expect(s.drafted).toBe(1);
    expect((await member(id, "approved_unfunded"))[0]?.opener_status).toBe("drafted");
    expect(await outbox(id)).toEqual([]); // held
    const mid = (await member(id, "approved_unfunded"))[0]!.id;
    await expect(
      t.db.withUser(rep, (q) =>
        reviewWinbackOpener(q, { memberId: mid, text: "x", approve: true }),
      ),
    ).rejects.toThrow(/only a manager/);
    await t.db.withUser(manager, (q) =>
      reviewWinbackOpener(q, {
        memberId: mid,
        text: "Your Pearl approval for Review Roofing is still open, and I kept it warm.",
        approve: true,
      }),
    );
    await runWinback({ db: t.db, appUrl: APP, drafter });
    const ob = await outbox(id);
    expect(ob).toHaveLength(1);
    expect(ob[0]?.text_body).toContain(
      "Your Pearl approval for Review Roofing is still open, and I kept it warm.",
    );
    // after two days unreviewed the step goes without the line
    const { id: late } = await approved("Late Review", "lr@x.com", 40);
    await runWinback({ db: t.db, appUrl: APP, drafter });
    expect(await outbox(late)).toEqual([]);
    await t.pool.query(
      "update winback_members set opener_drafted_at = now() - interval '3 days' where client_id = $1",
      [late],
    );
    await runWinback({ db: t.db, appUrl: APP, drafter });
    expect((await outbox(late))[0]?.text_body).not.toContain(
      "approval for Late Review is still open on my side",
    );
    // the kill switch
    await t.pool.query("update shop_settings set ai_enabled = false");
    const { id: off } = await approved("Switched Off", "so@x.com", 40);
    expect((await runWinback({ db: t.db, appUrl: APP, drafter })).drafted).toBe(0);
    expect((await member(off, "approved_unfunded"))[0]?.opener_status).toBe("none");
    expect((await outbox(off))[0]?.text_body).toContain("Hi Mike,\n\nSwitched Off was approved");
    await t.pool.query("update shop_settings set ai_enabled = true");
  });
  it("the merchant opening their upload link is the hot-list signal", async () => {
    await t.pool.query(
      "insert into upload_sessions (token, client_id, created_by, expires_at) values ('merchantopenedthelinktoken1234', $1, null, now() + interval '2 hours')",
      [wok],
    );
    const hot = await t.db.withUser(rep, (q) => hotList(q));
    expect(hot.map((h) => [h.client_id, h.signal])).toContainEqual([wok, "link_opened"]);
    expect(
      (await t.db.withUser(rep, listWinback)).find((r) => r.client_id === wok)?.link_opened_at,
    ).not.toBeNull();
  });
  it("recovered money: a funding after the member was worked counts for its pool and template", async () => {
    const fid = await t.db.withUser(rep, (q) =>
      proposeFunding(
        q,
        fundSchema.parse({
          clientId: wok,
          funderId: pearl,
          amount: "80000",
          sellRate: "1.3",
          buyRate: null,
          points: "5",
          psf: "0",
          payment: "800",
          frequency: "daily",
        }),
        t.today,
      ),
    );
    await t.db.withUser(manager, (q) => confirmFunding(q, fid));
    await runWinback({ db: t.db, appUrl: APP });
    expect((await member(wok, "approved_unfunded"))[0]).toMatchObject({
      status: "recovered",
      stop_reason: "funded",
    });
    const rows = await t.db.withUser(manager, (q) => winbackRecovered(q));
    expect(rows).toEqual([
      {
        pool: "approved_unfunded",
        pool_name: "Approved, never funded",
        template: "winback:approved_unfunded:1",
        recovered: 1,
        funded_cents: 8_000_000,
        commission_cents: 400_000,
      },
    ]);
  });
});

describe("S3-11 rescue nudges while an approval is live", () => {
  it("days 20, 25 and 29, once each; nothing after a reply, a funding or an opt-out", async () => {
    const { id, sub } = await approved("Rescue Ramen", "rr@x.com", 20);
    const deal = (
      await t.pool.query<{ d: string }>("select deal_id as d from submissions where id = $1", [sub])
    ).rows[0]!.d;
    expect(await runRescueNudges({ db: t.db, appUrl: APP })).toMatchObject({ emailed: 1 });
    expect(await runRescueNudges({ db: t.db, appUrl: APP })).toMatchObject({ emailed: 0 });
    let ob = await outbox(id);
    expect(ob).toHaveLength(1);
    expect(ob[0]).toMatchObject({
      source: `rescue:${deal}:20`,
      subject: "Your approval for Rescue Ramen is still open",
    });
    expect(ob[0]?.text_body).toContain("Pearl approved Rescue Ramen for $80,000");
    await t.pool.query(
      "update submissions set responded_at = now() - interval '25 days' where id = $1",
      [sub],
    );
    expect(await runRescueNudges({ db: t.db, appUrl: APP })).toMatchObject({ emailed: 1 });
    await t.pool.query(
      "update submissions set responded_at = now() - interval '29 days' where id = $1",
      [sub],
    );
    expect(await runRescueNudges({ db: t.db, appUrl: APP })).toMatchObject({ emailed: 1 });
    ob = await outbox(id);
    expect(ob.map((o) => o.source)).toEqual([
      `rescue:${deal}:20`,
      `rescue:${deal}:25`,
      `rescue:${deal}:29`,
    ]);
    expect(
      (
        await t.pool.query("select day from rescue_nudges where deal_id = $1 order by day", [deal])
      ).rows.map((r) => r.day),
    ).toEqual([20, 25, 29]);
    // an expired approval is not live
    await t.pool.query(
      "update submissions set approval_expires_on = current_date - 1 where id = $1",
      [sub],
    );
    await t.pool.query("delete from rescue_nudges where deal_id = $1", [deal]);
    expect(await runRescueNudges({ db: t.db, appUrl: APP })).toMatchObject({ emailed: 0 });
    expect(
      (
        await t.pool.query("select count(*)::int as n from rescue_nudges where deal_id = $1", [
          deal,
        ])
      ).rows[0]?.n,
    ).toBe(0);
    expect(await outbox(id)).toHaveLength(3);

    // a reply stops it
    const replied = await approved("Replied Rugs", "rg@x.com", 21);
    await t.pool.query("select record_merchant_reply($1, 'Re: approval', 'thinking', 'rg@x.com')", [
      replied.id,
    ]);
    expect(await runRescueNudges({ db: t.db, appUrl: APP })).toMatchObject({ emailed: 0 });
    expect(await outbox(replied.id)).toEqual([]);
    // a funding stops it
    const funded = await approved("Funded Fish", "ff@x.com", 21);
    const fid = await t.db.withUser(rep, (q) =>
      proposeFunding(
        q,
        fundSchema.parse({
          clientId: funded.id,
          funderId: pearl,
          amount: "80000",
          sellRate: "1.3",
          buyRate: null,
          points: "5",
          psf: "0",
          payment: "800",
          frequency: "daily",
        }),
        t.today,
      ),
    );
    await t.db.withUser(manager, (q) => confirmFunding(q, fid));
    expect(await runRescueNudges({ db: t.db, appUrl: APP })).toMatchObject({ emailed: 0 });
    // an opt-out stops it
    const out = await approved("Opted Out", "oo@x.com", 21);
    await t.db.withUser(rep, (q) =>
      q.query("select opt_out($1, 'email', 'unsubscribe')", [out.id]),
    );
    expect(await runRescueNudges({ db: t.db, appUrl: APP })).toMatchObject({ emailed: 0 });
    expect(await outbox(out.id)).toEqual([]);
  });
});
