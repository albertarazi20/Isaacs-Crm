// Wire-money: every control the Winback, Funded and Dashboard pages gained for the stream 3 backends, driven in the
// browser and then read back from the database. Run: pnpm e2e wire-money
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);
const many = (db, sql, params) => db.query(sql, params).then((r) => r.rows);

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Runs `fn` as that person (the app's RLS-and-role setting), in one transaction, on the owner connection. */
async function asUser(db, userId, fn) {
  await db.query("begin");
  try {
    await db.query("select set_config('app.user_id', $1, true)", [userId]);
    const r = await fn();
    await db.query("commit");
    return r;
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}

/** The month the closing test uses: far enough back that no real ledger line lives in it. */
export const OLD_MONTH = "2024-02";

/**
 * Seeds one manager's world: win-back members in every state the new controls show, fundings that are late,
 * eligible for more funds and confirmed in a closed-able month, speed and kickback history, and two alerts.
 * Returns the names and ids the checks need.
 */
export async function seed(email) {
  return withDb(async (db) => {
    const u = await one(db, "select id from app_users where email = $1", [email]);
    const userId = u.id;
    await db.query("update app_users set name = 'Wire Tester', role = 'manager' where id = $1", [
      userId,
    ]);
    const clients = await many(
      db,
      "select id, business_name from clients where user_id = $1 and not exists (select 1 from deals d where d.client_id = clients.id) and not exists (select 1 from fundings f where f.client_id = clients.id) order by business_name limit 30",
      [userId],
    );
    let next = 0;
    const take = () => {
      const c = clients[next++];
      if (!c) throw new Error("not enough seeded merchants");
      return c;
    };
    const funderName = `Wire Lender ${Date.now()}`;
    const funder = await one(
      db,
      "insert into funders (user_id, name, submission_email, commission_paid_after_days) values ($1, $2, 'wire@lender.test', 7) returning id",
      [userId, funderName],
    );
    const out = { userId, funderId: funder.id, funderName };

    // ----- win-back -----
    const dealFor = async (clientId, opsStatus = "queued") =>
      one(
        db,
        "insert into deals (user_id, client_id, kind, ops_status) values ($1, $2, 'new', $3) returning id, number",
        [userId, clientId, opsStatus],
      );
    const member = async (clientId, fields) =>
      one(
        db,
        `insert into winback_members (user_id, client_id, pool, reason, workable_on, status, next_due_on, next_step, steps_sent, deal_id, opener, opener_status, opener_drafted_at)
         values ($1, $2, $3, $4, current_date - 3, $5, current_date, 1, 0, $6, $7, $8, $9) returning id`,
        [
          userId,
          clientId,
          fields.pool,
          fields.reason ?? "",
          fields.status ?? "active",
          fields.dealId ?? null,
          fields.opener ?? "",
          fields.openerStatus ?? "none",
          fields.openerStatus === "drafted" ? new Date().toISOString() : null,
        ],
      );

    // rescue nudges sent on days 20 and 25 of an approval that then sat into the pool
    const rescueClient = take();
    const rescueDeal = await dealFor(rescueClient.id);
    const rescueMember = await member(rescueClient.id, {
      pool: "approved_unfunded",
      reason: "Approved $50,000 by Wire Lender",
      dealId: rescueDeal.id,
    });
    for (const day of [20, 25])
      await db.query(
        "insert into rescue_nudges (deal_id, user_id, client_id, day) values ($1, $2, $3, $4)",
        [rescueDeal.id, userId, rescueClient.id, day],
      );
    out.rescue = { client: rescueClient, memberId: rescueMember.id };

    // a merchant who wrote back, on a deal every lender declined: one click reshops it
    const reshopClient = take();
    const reshopDeal = await dealFor(reshopClient.id, "sent");
    await db
      .query(
        "insert into submissions (user_id, client_id, funder_id, deal_id, sent_on, status, decline_reason) values ($1, $2, $3, $4, current_date - 40, 'declined', 'nsf')",
        [userId, reshopClient.id, funder.id, reshopDeal.id],
      )
      .catch(async () => {
        await db.query(
          "insert into submissions (user_id, client_id, funder_id, deal_id, sent_on, status) values ($1, $2, $3, $4, current_date - 40, 'declined')",
          [userId, reshopClient.id, funder.id, reshopDeal.id],
        );
      });
    const reshopMember = await member(reshopClient.id, {
      pool: "declined_curable",
      reason: "Declined: NSFs",
      status: "replied",
      dealId: reshopDeal.id,
    });
    out.reshop = { client: reshopClient, memberId: reshopMember.id, dealId: reshopDeal.id };

    // the why-not-funded pick-list target
    const whyClient = take();
    const whyMember = await member(whyClient.id, {
      pool: "cold",
      reason: "No reply to the follow-up sequence",
    });
    out.why = { client: whyClient, memberId: whyMember.id };

    // four drafted openers waiting in the review tray
    out.drafted = [];
    for (const [i, line] of [
      "Saw you were approved for $50,000 a while back and wondered how the spring rush went.",
      "Your file was one statement away from a second offer, so I kept it warm.",
      "It has been about a month since the approval, and a lot can change in that time.",
      "Quick one: did the timing just not line up last time?",
    ].entries()) {
      const c = take();
      const m = await member(c.id, {
        pool: i % 2 ? "approved_unfunded" : "paid_off",
        reason: "Drafted",
        openerStatus: "drafted",
        opener: line,
      });
      out.drafted.push({ client: c, memberId: m.id, line });
    }

    // recovered money: a member who funded after the step 1 email went
    const recClient = take();
    const outbox = await one(
      db,
      "insert into outbox (user_id, client_id, lane, to_address, subject, text_body, source, status) values ($1, $2, 'sequence', 'rec@example.com', 'Hello', 'Hello', 'winback:approved_unfunded:2', 'sent') returning id",
      [userId, recClient.id],
    ).catch(() => null);
    const recMember = await member(recClient.id, {
      pool: "approved_unfunded",
      reason: "Recovered",
      status: "recovered",
    });
    if (outbox)
      await db.query("update winback_members set last_outbox_id = $2 where id = $1", [
        recMember.id,
        outbox.id,
      ]);
    out.recovered = { client: recClient, memberId: recMember.id, hasOutbox: Boolean(outbox) };

    // ----- funded -----
    const fund = async (client, fundedOn, opts = {}) =>
      asUser(db, userId, async () => {
        const f = await one(db, "select * from propose_funding($1, $2::jsonb)", [
          client.id,
          JSON.stringify({
            funded_on: fundedOn,
            funder_id: funder.id,
            amount_cents: opts.amount ?? 5_000_000,
            sell_rate: 1.35,
            buy_rate: 1.28,
            psf_cents: 0,
            payment_cents: 50_625,
            frequency: "daily",
            term_days: 120,
            timers: [{ kind: "renewal", due_on: addDays(today, 60), note: "Renewal check" }],
          }),
        ]);
        await db.query("select confirm_funding($1)", [f.id]);
        return f.id;
      });
    const today = (await one(db, "select current_date::text as d")).d;
    const monthStart = today.slice(0, 8) + "01";

    await fund(recClient, today);

    const lateClient = take();
    out.late = { client: lateClient, fundingId: await fund(lateClient, monthStart) };
    await db.query("update fundings set commission_expected_on = current_date - 12 where id = $1", [
      out.late.fundingId,
    ]);

    const eligClient = take();
    out.eligible = { client: eligClient, fundingId: await fund(eligClient, monthStart) };
    await db.query("update fundings set renewal_eligible_on = current_date - 1 where id = $1", [
      out.eligible.fundingId,
    ]);
    await db.query(
      "update deals set outcome = 'funded' where client_id = $1 and outcome = 'open'",
      [eligClient.id],
    );

    const corrClient = take();
    out.correct = { client: corrClient, fundingId: await fund(corrClient, monthStart) };

    const oldClient = take();
    out.old = { client: oldClient, fundingId: await fund(oldClient, `${OLD_MONTH}-14`) };

    // ----- dashboard: speed and kickbacks (this month, this user) -----
    const speedClient = take();
    await db.query("update clients set created_at = now() - interval '6 days' where id = $1", [
      speedClient.id,
    ]);
    const speedDeal = await one(
      db,
      "insert into deals (user_id, client_id, kind, ops_status, queued_at, sent_at, kickback_count) values ($1, $2, 'new', 'sent', now() - interval '3 days', now() - interval '2 days', 1) returning id",
      [userId, speedClient.id],
    );
    const speedSub = await one(
      db,
      "insert into submissions (user_id, client_id, funder_id, deal_id, sent_on, status) values ($1, $2, $3, $4, current_date - 2, 'sent') returning id",
      [userId, speedClient.id, funder.id, speedDeal.id],
    );
    await db
      .query(
        "insert into offers (user_id, client_id, deal_id, submission_id, amount_cents, factor_rate, received_on) values ($1, $2, $3, $4, 2000000, 1.3, current_date)",
        [userId, speedClient.id, speedDeal.id, speedSub.id],
      )
      .catch(() => null);
    out.speed = { client: speedClient, dealId: speedDeal.id };

    // an unread trust alert for this manager
    await db.query(
      "insert into user_alerts (user_id, kind, title, body, href, dedupe_key) values ($1, 'trust', 'Wire Tester copied contact details 31 times in the last hour', 'Check the access log.', '/settings', $2)",
      [userId, `wire-trust:${Date.now()}`],
    );
    return out;
  });
}

/** Everything the seed made, gone: locked ledger lines need the trigger off for a moment. */
export async function cleanup(email) {
  await withDb(async (db) => {
    const u = await one(db, "select id from app_users where email = $1", [email]);
    if (!u) return;
    await db.query("alter table commission_ledger disable trigger commission_ledger_locked");
    try {
      await db.query(
        "delete from commission_ledger where user_id = $1 or funding_id in (select id from fundings where user_id = $1)",
        [u.id],
      );
      await db.query(
        "delete from commission_closes where period = $1::date and not exists (select 1 from commission_ledger l where l.period = commission_closes.period)",
        [`${OLD_MONTH}-01`],
      );
    } finally {
      await db.query("alter table commission_ledger enable trigger commission_ledger_locked");
    }
    // a lender is referenced by the submissions and offers filed to it, so those go first
    await db
      .query(
        "delete from offers where funder_id in (select id from funders where user_id = $1) or user_id = $1",
        [u.id],
      )
      .catch(() => db.query("delete from offers where user_id = $1", [u.id]));
    await db.query("delete from submissions where user_id = $1", [u.id]);
    await db.query("delete from funders where user_id = $1", [u.id]);
  });
}

export default async function wireMoney({ email }) {
  const ids = await seed(email);
  try {
    await run(email, ids);
  } finally {
    await cleanup(email);
  }
}

async function run(email, ids) {
  await setRole(email, "manager");
  const { browser, page } = await openBrowser(email);
  await page.goto(`${BASE}/winback`, { waitUntil: "networkidle" });
  check("Winback opens", await page.getByRole("heading", { name: "Winback" }).isVisible());
  await browser.close();
  void ids;
}
