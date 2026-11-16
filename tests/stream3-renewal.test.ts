import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confirmFunding, fundSchema, proposeFunding } from "@/lib/money/fund";
import { runRenewals, startRenewal } from "@/lib/money/renewals";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let rep2: string;
let manager: string;
let pearl: string;
let pizza: string;
let fid: string;

const NOW = new Date("2026-11-16T15:00:00Z");
const outbox = async (clientId: string) =>
  (
    await t.pool.query<{ source: string; subject: string; text_body: string; status: string }>(
      "select source, subject, text_body, status from outbox where client_id = $1 order by created_at",
      [clientId],
    )
  ).rows;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  rep2 = await insertUser(t.pool, "rep2@x.com", "America/New_York");
  manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager' where id = $1", [manager]);
  await t.pool.query("update app_users set name = 'Josh Reps' where id = $1", [rep]);
  pearl = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email, renewal_paydown_pct) values ($1, 'Pearl', 'subs@pearl.com', 50) returning id",
      [manager],
    )
  ).rows[0]!.id;
  pizza = await insertClient(t.db, rep, "Pizza Palace");
  await t.pool.query(
    "update clients set state = 'NY', email = 'mike@pizza.com', contact_name = 'Mike Ross' where id = $1",
    [pizza],
  );
  await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [pizza]));
  fid = await t.db.withUser(rep, (q) =>
    proposeFunding(
      q,
      fundSchema.parse({
        clientId: pizza,
        funderId: pearl,
        amount: "50000",
        sellRate: "1.35",
        buyRate: "1.28",
        psf: "0",
        payment: "506.25",
        frequency: "daily",
        termDays: 120,
      }),
      t.today,
    ),
  );
  await t.db.withUser(manager, (q) => confirmFunding(q, fid));
});
afterAll(async () => {
  await t.drop();
});

describe("S3-4 the renewal engine", () => {
  it("the warm-up email goes once when the 40% date passes", async () => {
    await t.pool.query(
      "update fundings set renewal_warm_on = '2026-11-15', renewal_eligible_on = '2026-12-10' where id = $1",
      [fid],
    );
    const s = await runRenewals({ db: t.db, appUrl: "https://crm.test", now: NOW });
    expect(s).toEqual({ warmed: 1, eligible: 0, skipped: 0 });
    const ob = await outbox(pizza);
    expect(ob).toHaveLength(1);
    expect(ob[0]).toMatchObject({ source: `renewal:warm:${fid}`, status: "queued" });
    expect(ob[0]?.subject).toBe("Good progress on Pizza Palace's advance");
    expect(ob[0]?.text_body).toContain("Hi Mike,");
    expect(ob[0]?.text_body).toContain("about 40% of the way through the advance for Pizza Palace");
    expect(ob[0]?.text_body).toMatch(/Thanks,\nJosh/);
    const f = (
      await t.pool.query(
        "select renewal_warm_sent_at, renewal_eligible_sent_at from fundings where id = $1",
        [fid],
      )
    ).rows[0];
    expect(f.renewal_warm_sent_at).not.toBeNull();
    expect(f.renewal_eligible_sent_at).toBeNull();
    // the next run sends nothing
    expect(await runRenewals({ db: t.db, appUrl: "https://crm.test", now: NOW })).toEqual({
      warmed: 0,
      eligible: 0,
      skipped: 0,
    });
    expect(await outbox(pizza)).toHaveLength(1);
  });

  it("the eligibility email carries the merchant's upload link and the rep gets the alert", async () => {
    await t.pool.query("update fundings set renewal_eligible_on = '2026-12-01' where id = $1", [
      fid,
    ]);
    const later = new Date("2026-12-02T15:00:00Z");
    const s = await runRenewals({ db: t.db, appUrl: "https://crm.test", now: later });
    expect(s).toEqual({ warmed: 0, eligible: 1, skipped: 0 });
    const token = (
      await t.pool.query<{ u: string }>("select upload_token as u from clients where id = $1", [
        pizza,
      ])
    ).rows[0]!.u;
    const ob = await outbox(pizza);
    expect(ob).toHaveLength(2);
    expect(ob[1]).toMatchObject({ source: `renewal:eligible:${fid}` });
    expect(ob[1]?.subject).toBe("Pizza Palace is eligible for more funds");
    expect(ob[1]?.text_body).toContain(`https://crm.test/upload/${token}`);
    const alert = (
      await t.pool.query(
        "select kind, title, body, client_id, dedupe_key from user_alerts where user_id = $1",
        [rep],
      )
    ).rows;
    expect(alert).toHaveLength(1);
    expect(alert[0]).toMatchObject({
      kind: "renewal_eligible",
      title: "Pizza Palace is eligible for more funds",
      client_id: pizza,
      dedupe_key: `renewal_eligible:${fid}`,
    });
    expect(alert[0]?.body).toContain("The merchant was emailed for the newest statement");
    expect(
      (await t.pool.query("select renewal_eligible_sent_at from fundings where id = $1", [fid]))
        .rows[0]?.renewal_eligible_sent_at,
    ).not.toBeNull();
    // once
    expect(await runRenewals({ db: t.db, appUrl: "https://crm.test", now: later })).toEqual({
      warmed: 0,
      eligible: 0,
      skipped: 0,
    });
  });

  it("an opted-out merchant gets no email but the funding is still stamped so it is not retried forever", async () => {
    const quiet = await insertClient(t.db, rep, "Quiet Co");
    await t.pool.query(
      "update clients set state = 'NY', email = 'q@q.com', email_opt_out = true where id = $1",
      [quiet],
    );
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [quiet]));
    const qf = await t.db.withUser(rep, (q) =>
      proposeFunding(
        q,
        fundSchema.parse({
          clientId: quiet,
          funderId: pearl,
          amount: "20000",
          sellRate: "1.3",
          buyRate: null,
          points: "5",
          psf: "0",
          payment: "200",
          frequency: "daily",
        }),
        t.today,
      ),
    );
    await t.db.withUser(manager, (q) => confirmFunding(q, qf));
    await t.pool.query("update fundings set renewal_warm_on = '2026-11-01' where id = $1", [qf]);
    const s = await runRenewals({ db: t.db, appUrl: "https://crm.test", now: NOW });
    expect(s).toEqual({ warmed: 0, eligible: 0, skipped: 1 });
    expect(await outbox(quiet)).toEqual([]);
    expect(
      (await t.pool.query("select renewal_warm_sent_at from fundings where id = $1", [qf])).rows[0]
        ?.renewal_warm_sent_at,
    ).not.toBeNull();
  });

  it("start_renewal opens the renewal deal pre-filled from the funding and asks for the newest statement", async () => {
    // the funded deal closed at confirm; the renewal is the merchant's next open deal
    const d = await t.db.withUser(rep, (q) => startRenewal(q, fid));
    expect(d.kind).toBe("renewal");
    expect(Number(d.requested_cents)).toBe(5_000_000);
    const fundedLabel = (
      await t.pool.query<{ d: string }>("select to_char(current_date, 'Mon DD, YYYY') as d")
    ).rows[0]!.d;
    expect(d.rep_note).toBe(
      `Renewal of $50,000 at 1.35 funded ${fundedLabel}, daily $506.25, 120 days`,
    );
    expect(d.blocker).toBe("Waiting on the newest bank statement");
    const deal = (
      await t.pool.query(
        "select kind, ops_status, outcome, use_of_funds from deals where id = $1",
        [d.id],
      )
    ).rows[0];
    expect(deal).toEqual({
      kind: "renewal",
      ops_status: "queued",
      outcome: "open",
      use_of_funds: "Renewal of the Pearl advance",
    });
    const enrol = (
      await t.pool.query(
        "select b.key, e.stopped_at from enrollments e join buckets b on b.id = e.bucket_id where e.client_id = $1 and e.stopped_at is null",
        [pizza],
      )
    ).rows;
    expect(enrol).toEqual([{ key: "missing_newest", stopped_at: null }]);
    const stip = (
      await t.pool.query(
        "select kind, required, received_at, period::text as period from stips where client_id = $1 and kind = 'bank_statement'",
        [pizza],
      )
    ).rows;
    expect(stip).toHaveLength(1);
    expect(stip[0]).toMatchObject({ required: true, received_at: null });
    const act = await t.pool.query(
      "select body from activities where client_id = $1 and body like 'Renewal started%'",
      [pizza],
    );
    expect(act.rows[0]?.body).toMatch(/^Renewal started from the Pearl advance as deal D-\d+$/);
    // the renewal task the clocks opened is done: the deal is the work now
    expect(
      (
        await t.pool.query(
          "select count(*)::int as n from timers where client_id = $1 and kind = 'renewal' and done_at is null",
          [pizza],
        )
      ).rows[0]?.n,
    ).toBe(0);
    // one open deal per merchant; someone else's merchant is refused
    await expect(t.db.withUser(rep, (q) => startRenewal(q, fid))).rejects.toThrow(
      /already has an open deal/,
    );
    await expect(t.db.withUser(rep2, (q) => startRenewal(q, fid))).rejects.toThrow(/not yours/);
  });
});
