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
    await db.query(
      "insert into submissions (user_id, client_id, funder_id, deal_id, sent_on, status) values ($1, $2, $3, $4, current_date - 40, 'declined')",
      [userId, reshopClient.id, funder.id, reshopDeal.id],
    );
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
    );
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
    out.recovered = { client: recClient, memberId: recMember.id };

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
    await db.query(
      "insert into offers (user_id, client_id, deal_id, submission_id, amount_cents, factor_rate, received_on) values ($1, $2, $3, $4, 2000000, 1.3, current_date)",
      [userId, speedClient.id, speedDeal.id, speedSub.id],
    );
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
    await db.query("delete from offers where user_id = $1", [u.id]);
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

/** Polls the database until `fn` returns something truthy (the action finished) or 8 seconds pass. */
async function until(fn) {
  for (let i = 0; i < 40; i += 1) {
    const v = await withDb(fn);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

const compact = (cents) => {
  const d = cents / 100;
  const trim = (n) => String(Math.round(n * 10) / 10).replace(/\.0$/, "");
  if (Math.abs(d) >= 1_000_000) return `$${trim(d / 1_000_000)}M`;
  if (Math.abs(d) >= 1_000) return `$${trim(d / 1_000)}k`;
  return `$${Math.round(d)}`;
};

async function run(email, ids) {
  await setRole(email, "manager");
  const { browser, page } = await openBrowser(email);
  const toast = (text) => page.getByText(text).first().waitFor({ timeout: 8000 });

  // ================= Winback =================
  await page.goto(`${BASE}/winback`, { waitUntil: "networkidle" });
  check("Winback opens", await page.getByRole("heading", { name: "Winback" }).isVisible());

  // --- rescue nudges on the member row ---
  const rescueRow = page.locator("li", { hasText: ids.rescue.client.business_name }).first();
  const days = await withDb((db) =>
    one(
      db,
      "select array_agg(r.day order by r.day) as d from rescue_nudges r join winback_members m on m.deal_id = r.deal_id where m.id = $1",
      [ids.rescue.memberId],
    ),
  );
  check(
    "the rescue nudges are in the database (days 20 and 25)",
    days.d.join(",") === "20,25",
    JSON.stringify(days),
  );
  check(
    "the member row shows the rescue nudges that went out",
    (await rescueRow.innerText()).includes("Rescue nudges sent: day 20 · day 25"),
  );

  // --- why didn't it fund ---
  const whyRow = () => page.locator("li", { hasText: ids.why.client.business_name }).first();
  await whyRow().getByRole("button", { name: "Why not funded" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Save reason" }).click();
  check(
    "the pick-list refuses an empty answer, below the field",
    await dialog.getByText("Pick the closest reason").isVisible(),
  );
  const untouched = await withDb((db) =>
    one(db, "select why_not_funded from winback_members where id = $1", [ids.why.memberId]),
  );
  check("nothing was written for the empty answer", untouched.why_not_funded === null);
  await dialog.getByLabel("Reason").selectOption({ label: "Terms were too high" });
  await dialog.getByLabel("Note (optional)").fill("Wanted a 1.25 factor");
  await dialog.getByRole("button", { name: "Save reason" }).click();
  await toast("Reason saved");
  const why = await until((db) =>
    one(
      db,
      "select why_not_funded, why_note from winback_members where id = $1 and why_not_funded is not null",
      [ids.why.memberId],
    ),
  );
  check(
    "the reason reaches the database",
    why?.why_not_funded === "terms" && why?.why_note === "Wanted a 1.25 factor",
    JSON.stringify(why),
  );
  const act = await withDb((db) =>
    one(
      db,
      "select body from activities where client_id = $1 and body like 'Why it did not fund%' order by occurred_at desc limit 1",
      [ids.why.client.id],
    ),
  );
  check(
    "the reason is on the merchant's timeline",
    act?.body === "Why it did not fund: Terms were too high — Wanted a 1.25 factor",
    act?.body,
  );
  await page.waitForTimeout(600);
  check(
    "the row now reads the reason back",
    (await whyRow().innerText()).includes("Why it did not fund: Terms were too high"),
  );

  // --- reshop for a merchant who came back ---
  const reshopRow = page.locator("li", { hasText: ids.reshop.client.business_name }).first();
  check(
    "Reshop shows for the merchant who replied on a fully declined deal",
    await reshopRow.getByRole("button", { name: "Reshop" }).isVisible(),
  );
  check(
    "no Reshop where there is nothing to reshop",
    (await whyRow().getByRole("button", { name: "Reshop" }).count()) === 0,
  );
  await reshopRow.getByRole("button", { name: "Reshop" }).click();
  await page.waitForURL(/\/deals\//, { timeout: 10000 });
  const reshop = await withDb(async (db) => ({
    old: await one(db, "select outcome from deals where id = $1", [ids.reshop.dealId]),
    fresh: await one(
      db,
      "select id, kind, outcome from deals where client_id = $1 and kind = 'reshop'",
      [ids.reshop.client.id],
    ),
  }));
  check(
    "the declined deal closed and a reshop deal opened",
    reshop.old.outcome === "declined" && reshop.fresh?.outcome === "open",
    JSON.stringify(reshop),
  );
  check(
    "the page opened the new deal",
    page.url().endsWith(`/deals/${reshop.fresh?.id}`),
    page.url(),
  );

  // --- the opener review tray ---
  await page.goto(`${BASE}/winback`, { waitUntil: "networkidle" });
  const [d1, d2, d3, d4] = ids.drafted;
  const lineBox = (d) => page.getByLabel(`Opening line for ${d.client.business_name}`);
  check(
    "all four drafted lines wait in the tray",
    (await page.getByRole("button", { name: "Send all (4)" }).count()) === 1,
  );
  const edited = "Edited by the manager: how did the spring rush go?";
  await lineBox(d1).fill(edited);
  await lineBox(d1)
    .locator("xpath=ancestor::li")
    .getByRole("button", { name: "Send", exact: true })
    .click();
  await toast("Line approved");
  const a1 = await until((db) =>
    one(
      db,
      "select opener, opener_status from winback_members where id = $1 and opener_status = 'approved'",
      [d1.memberId],
    ),
  );
  check("Send approves the edited line in the database", a1?.opener === edited, JSON.stringify(a1));
  await page.waitForTimeout(700);
  await lineBox(d2).locator("xpath=ancestor::li").getByRole("button", { name: "Skip" }).click();
  await toast("Skipped");
  const a2 = await until((db) =>
    one(
      db,
      "select opener, opener_status from winback_members where id = $1 and opener_status = 'rejected'",
      [d2.memberId],
    ),
  );
  check(
    "Skip rejects the line and keeps what Claude wrote",
    a2?.opener === d2.line,
    JSON.stringify(a2),
  );
  await page.waitForTimeout(700);
  check(
    "an emptied line cannot be sent",
    await (async () => {
      await lineBox(d3).fill("");
      return lineBox(d3)
        .locator("xpath=ancestor::li")
        .getByRole("button", { name: "Send", exact: true })
        .isDisabled();
    })(),
  );
  check(
    "Send all waits while a line is empty",
    await page.getByRole("button", { name: /Send all/ }).isDisabled(),
  );
  const editedAll = "Third line, edited before Send all.";
  await lineBox(d3).fill(editedAll);
  await page.getByRole("button", { name: "Send all (2)" }).click();
  await toast("2 lines approved");
  const rest = await until((db) =>
    db
      .query(
        "select id, opener, opener_status from winback_members where id = any($1::uuid[]) and opener_status = 'approved'",
        [[d3.memberId, d4.memberId]],
      )
      .then((r) => (r.rows.length === 2 ? r.rows : null)),
  );
  const byId = Object.fromEntries((rest ?? []).map((r) => [r.id, r]));
  check(
    "Send all approves every remaining line, with the text in its box",
    byId[d3.memberId]?.opener === editedAll && byId[d4.memberId]?.opener === d4.line,
    JSON.stringify(rest),
  );
  await page.waitForTimeout(800);
  check("the tray is empty afterwards", await page.getByText("No lines are waiting").isVisible());

  // --- recovered money per pool and per template ---
  const rec = await withDb((db) =>
    one(
      db,
      `select count(*)::int as n, coalesce(sum(f.amount_cents), 0)::bigint as funded, coalesce(sum(f.commission_cents), 0)::bigint as commission
         from winback_members m join outbox o on o.id = m.last_outbox_id
         join lateral (select f.amount_cents, f.commission_cents from fundings f where f.client_id = m.client_id and f.funded_on >= m.created_at::date and f.confirmed_at is not null order by f.funded_on limit 1) f on true
        where m.status = 'recovered' and m.pool = 'approved_unfunded' and o.source = 'winback:approved_unfunded:2' and m.created_at > now() - interval '12 months'`,
      [],
    ),
  );
  const recCard = page.locator("section", { hasText: "Recovered money" }).first();
  const stepRow = recCard.locator("tr", { hasText: "Step 2 email" }).first();
  const stepText = await stepRow.innerText();
  check(
    "recovered money for the pool's step 2 email matches the database",
    stepText.includes(compact(Number(rec.funded))) &&
      stepText.includes(compact(Number(rec.commission))) &&
      stepText.replace(/\s+/g, " ").includes(`${rec.n} `),
    `${stepText.replace(/\s+/g, " ")} vs ${JSON.stringify(rec)}`,
  );

  // ================= Funded =================
  await page.goto(`${BASE}/funded`, { waitUntil: "networkidle" });
  const fundedRow = (c) => page.locator("tr", { hasText: c.business_name }).first();

  // --- late lender payouts ---
  const late = await withDb((db) =>
    one(
      db,
      "select (current_date - commission_expected_on)::int as d from fundings where id = $1",
      [ids.late.fundingId],
    ),
  );
  check(
    "the late funding is 12 days past the lender's date in the database",
    late.d === 12,
    JSON.stringify(late),
  );
  check(
    "the sheet flags the late lender with its days",
    (await fundedRow(ids.late.client).innerText()).includes("Lender late · 12d"),
  );
  check(
    "the page says how many lenders are late",
    await page.getByRole("status").filter({ hasText: "late paying commission" }).isVisible(),
  );

  // --- eligible for more funds + start renewal ---
  const eligText = await fundedRow(ids.eligible.client).innerText();
  check("the eligible funding carries the marker", eligText.includes("Eligible for more funds"));
  check(
    "a funding that is not eligible carries none",
    !(await fundedRow(ids.correct.client).innerText()).includes("Eligible for more funds"),
  );
  await fundedRow(ids.eligible.client).getByRole("button", { name: "Start renewal" }).click();
  await page.waitForURL(/\/deals\//, { timeout: 10000 });
  const ren = await until((db) =>
    one(
      db,
      "select id, kind, outcome, requested_cents from deals where client_id = $1 and kind = 'renewal' and outcome = 'open'",
      [ids.eligible.client.id],
    ),
  );
  check(
    "Start renewal opened a renewal deal pre-filled from the funding",
    ren?.kind === "renewal" && Number(ren?.requested_cents) === 5_000_000,
    JSON.stringify(ren),
  );
  const stip = await withDb((db) =>
    one(
      db,
      "select count(*)::int as n from stips where client_id = $1 and kind = 'bank_statement' and required",
      [ids.eligible.client.id],
    ),
  );
  check("the newest statement was asked for", stip.n >= 1);
  await page.goto(`${BASE}/funded`, { waitUntil: "networkidle" });
  const afterRenew = await fundedRow(ids.eligible.client).innerText();
  check(
    "the row now points at the open deal instead of offering another renewal",
    afterRenew.includes("open") && !afterRenew.includes("Start renewal"),
  );

  // --- correct this funding ---
  const corrRow = fundedRow(ids.correct.client);
  await corrRow
    .getByRole("button", { name: `Details for ${ids.correct.client.business_name}` })
    .click();
  await page.getByRole("button", { name: "Correct this funding" }).click();
  const cd = page.getByRole("dialog");
  await cd.getByRole("button", { name: "Post correction" }).click();
  check(
    "a correction without a reason is refused, below the field",
    await cd.getByText("Say why the funding is being corrected").isVisible(),
  );
  await cd.getByLabel("Why is it being corrected?").fill("The lender's statement shows 6 points");
  await cd.getByRole("button", { name: "Post correction" }).click();
  check(
    "a correction that changes nothing is refused",
    await cd.getByText("Change at least one term").isVisible(),
  );
  check(
    "points are not editable while a buy and a sell rate set them",
    await cd.locator("label", { hasText: "Points" }).locator("input").isDisabled(),
  );
  await cd.getByLabel("Buy rate", { exact: true }).fill("1.29");
  await cd.getByRole("button", { name: "Post correction" }).click();
  await toast("Funding corrected");
  const fix = await until((db) =>
    one(
      db,
      `select f.buy_rate::float as buy_rate, f.commission_cents, c.reason, l.kind, l.gross_cents, l.rep_cents, l.period::text as period
         from fundings f join fundings_corrections c on c.funding_id = f.id join commission_ledger l on l.id = c.ledger_line_id where f.id = $1`,
      [ids.correct.fundingId],
    ),
  );
  check(
    "the funding changed and the correction is kept with its reason",
    Number(fix?.buy_rate) === 1.29 &&
      Number(fix?.commission_cents) === 300_000 &&
      fix?.reason === "The lender's statement shows 6 points",
    JSON.stringify(fix),
  );
  const thisMonth = (
    await withDb((db) => one(db, "select to_char(current_date, 'YYYY-MM-01') as p", []))
  ).p;
  check(
    "the difference posted as a dated correction line in the current month",
    fix?.kind === "correction" && Number(fix?.gross_cents) === -50_000 && fix?.period === thisMonth,
    JSON.stringify(fix),
  );
  await page.waitForTimeout(800);
  const detail = await page.locator("tr", { hasText: "Corrections" }).last().innerText();
  check(
    "the row's detail shows the correction line with its reason and the change",
    detail.includes("The lender's statement shows 6 points") &&
      detail.includes("Buy rate 1.28 → 1.29") &&
      detail.includes("−$500"),
    detail.replace(/\s+/g, " "),
  );
  check("the row is marked Corrected", (await corrRow.innerText()).includes("Corrected"));

  // --- statements: close a month, open it, print it ---
  const closeLabel = "Close February 2024";
  await page.getByRole("button", { name: closeLabel }).click();
  await toast("February 2024 closed");
  const closed = await until((db) =>
    one(
      db,
      `select (select count(*)::int from commission_closes where period = '2024-02-01') as closes,
              (select gross_cents from commission_statements where period = '2024-02-01' and user_id = $1) as gross,
              (select count(*)::int from commission_ledger where period = '2024-02-01' and user_id = $1 and locked_at is not null) as locked`,
      [ids.userId],
    ).then((r) => (r.closes === 1 ? r : null)),
  );
  check(
    "Close month locked the lines and built the statement",
    closed?.closes === 1 && Number(closed?.gross) === 350_000 && closed?.locked === 1,
    JSON.stringify(closed),
  );
  await page.waitForTimeout(800);
  check(
    "the month now lists as closed",
    (await page.locator("tr", { hasText: "February 2024" }).first().innerText()).includes("Closed"),
  );
  await page.getByRole("link", { name: "Open the February 2024 statement" }).click();
  await page.waitForURL(/\/funded\/statements\/2024-02/);
  const stmt = await page.locator("main").innerText();
  check(
    "the statement page shows the month, the merchant and the money",
    stmt.includes("February 2024 statement") &&
      stmt.includes(ids.old.client.business_name) &&
      stmt.includes("$3,500") &&
      stmt.includes("$1,750"),
    stmt.replace(/\s+/g, " ").slice(0, 200),
  );
  await page.emulateMedia({ media: "print" });
  check(
    "printing hides the app's header and the buttons",
    (await page.locator("[data-app-header]").isHidden()) &&
      (await page.getByRole("button", { name: "Print" }).isHidden()),
  );
  check(
    "printing keeps the statement",
    await page.getByRole("heading", { name: "February 2024 statement" }).isVisible(),
  );
  await page.emulateMedia({ media: "screen" });
  const badPeriod = await page.goto(`${BASE}/funded/statements/2024-13`);
  check("a made-up month is a 404", badPeriod?.status() === 404);

  // ================= Dashboard =================
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const speed = await withDb((db) =>
    one(
      db,
      `select (select round(extract(epoch from (d.sent_at - c.created_at)) / 86400)::int from deals d join clients c on c.id = d.client_id where d.id = $1) as lead_to_sub,
              (select (o.received_on - d.sent_at::date) from deals d join offers o on o.deal_id = d.id where d.id = $1 limit 1) as sub_to_offer,
              (select count(*)::int from deals where user_id = $2 and to_char(queued_at, 'YYYY-MM') = to_char(current_date, 'YYYY-MM') and kickback_count > 0) as kicked,
              (select count(*)::int from deals where user_id = $2 and to_char(queued_at, 'YYYY-MM') = to_char(current_date, 'YYYY-MM')) as filed`,
      [ids.speed.dealId, ids.userId],
    ),
  );
  const teamRow = page.locator("tr", { hasText: "Wire Tester" }).first();
  const cells = (await teamRow.locator("td").allInnerTexts()).map((t) => t.trim());
  const header = (await page.locator("th", { hasText: "Lead to sub" }).first().innerText()).trim();
  check(
    "the Team table has the speed and kickback columns",
    header.toLowerCase() === "lead to sub" &&
      (await page.locator("th", { hasText: "Kickbacks" }).count()) === 1,
  );
  check(
    "the rep's lead to sub is what the database says",
    cells[9] === `${speed.lead_to_sub}d`,
    `${cells[9]} vs ${speed.lead_to_sub}`,
  );
  check(
    "the rep's sub to first offer is what the database says",
    cells[10] === `${speed.sub_to_offer}d`,
    `${cells[10]} vs ${speed.sub_to_offer}`,
  );
  const rate = Math.round((100 * speed.kicked) / speed.filed);
  check(
    "the rep's kickback rate is what the database says",
    cells[12].startsWith(`${rate}%`),
    `${cells[12]} vs ${speed.kicked}/${speed.filed}`,
  );
  const shop = await withDb((db) =>
    one(
      db,
      `select round(percentile_cont(0.5) within group (order by extract(epoch from (d.sent_at - c.created_at)) / 86400)::numeric, 1)::float as lead_to_sub
         from deals d join clients c on c.id = d.client_id where d.sent_at is not null and to_char(d.sent_at, 'YYYY-MM') = to_char(current_date, 'YYYY-MM')`,
      [],
    ),
  );
  const speedCard = page
    .locator("section", { has: page.getByRole("heading", { name: "Speed" }) })
    .first();
  const speedText = (await speedCard.innerText()).replace(/\s+/g, " ");
  check(
    "the speed card shows the shop's median lead to sub",
    speedText.includes(`Lead to sub ${shop.lead_to_sub}d`),
    `${speedText} vs ${shop.lead_to_sub}`,
  );

  await browser.close();

  // --- the same dashboard as the rep: their own speed card, and the alert kinds in Do this now ---
  await setRole(email, "rep");
  const asRep = await openBrowser(email);
  const rp = asRep.page;
  await rp.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const mine = (
    await rp
      .locator("section", { has: rp.getByRole("heading", { name: "My speed", exact: true }) })
      .first()
      .innerText()
  ).replace(/\s+/g, " ");
  check(
    "a rep sees their own speed card",
    mine.includes(`Lead to sub ${speed.lead_to_sub}d`) &&
      mine.includes(`Sub to first offer ${speed.sub_to_offer}d`),
    mine,
  );
  check("a rep's card carries their kickback rate", mine.includes(`Kicked back ${rate}%`), mine);
  const nowText = await rp.locator("main").innerText();
  check(
    "a late lender payout is in Do this now",
    nowText.includes("Late payout") &&
      nowText.includes(`Chase ${ids.funderName} for the commission`),
  );
  check(
    "an unread trust alert is in Do this now",
    nowText.includes("Wire Tester copied contact details 31 times in the last hour"),
  );
  await rp
    .getByRole("link", { name: /copied contact details 31 times/ })
    .first()
    .click();
  await rp.waitForURL(/\/settings|\/\?denied/, { timeout: 10000 });
  check(
    "the trust item opens where the alert pointed",
    rp.url().includes("/settings") || rp.url().includes("denied=settings"),
    rp.url(),
  );
  await withDb((db) =>
    db.query("update user_alerts set read_at = now() where user_id = $1 and kind = 'trust'", [
      ids.userId,
    ]),
  );
  await rp.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check(
    "a trust alert that was read leaves the list",
    !(await rp.locator("main").innerText()).includes("copied contact details 31 times"),
  );
  const lateItem = () =>
    rp.locator("li", { hasText: "Late payout" }).filter({ hasText: ids.late.client.business_name });
  check("the late payout is still listed while the lender owes", (await lateItem().count()) === 1);
  await withDb((db) =>
    db.query(
      "update fundings set commission_received_cents = commission_cents, commission_received_on = current_date where id = $1",
      [ids.late.fundingId],
    ),
  );
  await rp.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check("a late payout the lender then paid leaves the list", (await lateItem().count()) === 0);
  await asRep.browser.close();
}
