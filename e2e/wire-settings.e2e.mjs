// The settings controls that finished backends were missing (docs/UI-WIRING.md, Settings): each one is driven in the
// browser, then the DATABASE is read — a toast or a 200 is not proof. Run:
//   CHROMIUM_PATH=... BASE_URL=http://localhost:3006 node e2e/run.mjs wire-settings
// Everything it seeds is removed again, and the shop_settings columns it touches are put back.
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

// "2026-11-14" the way formatDate writes it: "Nov 14", and "Nov 14, 2025" when the year is not this one
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  const day = `${MONTHS[m - 1]} ${d}`;
  return y === new Date().getFullYear() ? day : `${day}, ${y}`;
};
const q = (sql, params) => withDb((db) => db.query(sql, params).then((r) => r.rows));
const one = (sql, params) => q(sql, params).then((r) => r[0]);
const SHOP_COLS = [
  "automation_from",
  "dns_ok",
  "dns_checked_at",
  "dns_result",
  "send_on_holidays",
  "approval_valid_days",
  "resubmit_block_days",
  "deals_inbox_address",
  "lender_chase_mode",
  "document_retention_days",
  "winback_opener_mode",
];

export default async function wireSettings({ email }) {
  await setRole(email, "manager");
  const uid = (await one("select id from app_users where email = $1", [email])).id;
  const stamp = Date.now();
  const before = await one(`select ${SHOP_COLS.join(", ")} from shop_settings`, []);
  const { browser, context, page } = await openBrowser(email);
  const toast = (re) => page.getByText(re).first().waitFor({ timeout: 10000 });
  const open = (path) => page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  const shop = () => one(`select ${SHOP_COLS.join(", ")} from shop_settings`, []);
  const made = {
    templates: [],
    funders: [],
    users: [],
    regState: null,
    regBefore: null,
    closePeriod: null,
  };

  try {
    // ---- Email & lenders: the shop fields ----------------------------------------------------------------------
    await open("/settings/email");
    await page.getByLabel("Deals inbox").fill(`e2e-deals-${stamp}@mail.example.com`);
    await page.getByLabel("Approval stays good for").fill("21");
    await page.getByLabel("Block a double submission for").fill("45");
    await page.getByLabel("Send on US holidays").check();
    await page.getByLabel("Auto-chase").selectOption("draft");
    await page.getByRole("button", { name: "Save settings" }).click();
    await toast(/^Saved$/);
    await page.waitForTimeout(500);
    const saved = await shop();
    check(
      "the deals inbox, both day counts, the holiday switch and chase mode draft reach the database",
      saved.deals_inbox_address === `e2e-deals-${stamp}@mail.example.com` &&
        saved.approval_valid_days === 21 &&
        saved.resubmit_block_days === 45 &&
        saved.send_on_holidays === true &&
        saved.lender_chase_mode === "draft",
      JSON.stringify(saved),
    );

    await page.getByLabel("Approval stays good for").fill("0");
    await page.getByRole("button", { name: "Save settings" }).click();
    await toast(/Approval validity is at least 1 day/);
    await page.waitForTimeout(400);
    check(
      "a refused value shows the reason and leaves the database as it was",
      (await shop()).approval_valid_days === 21,
    );

    // the form loads what is stored: a reload shows what was saved
    await open("/settings/email");
    check(
      "a reload shows the saved values",
      (await page.getByLabel("Approval stays good for").inputValue()) === "21" &&
        (await page.getByLabel("Send on US holidays").isChecked()) &&
        (await page.getByLabel("Auto-chase").inputValue()) === "draft",
    );

    // ---- Email & lenders: the DNS check ------------------------------------------------------------------------
    await page
      .getByLabel("Automation sender")
      .fill("Selective <hello@mail.example.com>", { timeout: 5000 });
    await page.getByRole("button", { name: "Save settings" }).click();
    await toast(/^Saved$/);
    await page.waitForTimeout(500);
    const cleared = await shop();
    check(
      "a new automation sender is stored and clears the old DNS result",
      cleared.automation_from === "Selective <hello@mail.example.com>" &&
        cleared.dns_checked_at === null &&
        cleared.dns_ok === false,
      JSON.stringify(cleared),
    );
    await open("/settings/email");
    check(
      "before any check the card says so",
      (await page.getByText("Not checked", { exact: true }).first().isVisible()) &&
        (await page.locator('[data-dns="domain"]').innerText()) === "mail.example.com",
    );
    await page.getByRole("button", { name: "Check DNS" }).click();
    await toast(/^mail\.example\.com: SPF/);
    await page.waitForTimeout(800);
    const dns = await shop();
    const r = dns.dns_result;
    check(
      "Check DNS stores the result: domain, time and the three records",
      dns.dns_checked_at !== null &&
        Date.now() - new Date(dns.dns_checked_at).getTime() < 60_000 &&
        r.domain === "mail.example.com" &&
        typeof r.spf?.ok === "boolean" &&
        typeof r.dkim?.ok === "boolean" &&
        typeof r.dmarc?.ok === "boolean" &&
        dns.dns_ok === (r.spf.ok && r.dkim.ok && r.dmarc.ok),
      JSON.stringify(dns.dns_result),
    );
    const card = page.locator("section", { hasText: "Automation domain check" }).first();
    const cardText = await card.innerText();
    check(
      "the card shows what the database stored: the badge, when, and SPF / DKIM / DMARC found or missing",
      cardText.includes(dns.dns_ok ? "Verified" : "Not verified") &&
        !cardText.includes("never") &&
        cardText.includes(`SPF ${r.spf.ok ? "found" : "missing"}`) &&
        cardText.includes(`DKIM ${r.dkim.ok ? "found" : "missing"}`) &&
        cardText.includes(`DMARC ${r.dmarc.ok ? "found" : "missing"}`),
      cardText.replace(/\s+/g, " ").slice(0, 300),
    );

    // ---- Email & lenders: last synced per mailbox --------------------------------------------------------------
    await q(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status, can_read_mail) values ($1, 'e2e-mailbox@example.com', 'x', 'mail', 'ok', true) on conflict (user_id) do update set can_read_mail = true, status = 'ok'",
      [uid],
    );
    await q(
      "insert into mail_sync_state (user_id, last_synced_at, messages_seen) values ($1, now() - interval '3 hours', 42) on conflict (user_id) do update set last_synced_at = excluded.last_synced_at, messages_seen = 42, last_error = null",
      [uid],
    );
    await open("/settings/email");
    const mb = await page.locator(`[data-mailbox="${email}"]`).innerText();
    check(
      "the mailbox sync list shows the last-synced time and messages seen from the database",
      /synced 3 hours ago · 42 seen/.test(mb) && mb.includes("e2e-mailbox@example.com"),
      mb.replace(/\s+/g, " "),
    );
    await q("update mail_sync_state set last_error = 'Google said no' where user_id = $1", [uid]);
    await open("/settings/email");
    check(
      "a failed read shows its error",
      (await page.locator(`[data-mailbox="${email}"]`).innerText()).includes("Google said no"),
    );
    await q("delete from mail_sync_state where user_id = $1", [uid]);
    await q("delete from gmail_connections where user_id = $1", [uid]);

    // ---- Lender form: blank approval days = the shop default ---------------------------------------------------
    const lender = `E2E Lender ${String(stamp).slice(-6)}`;
    const f = await one(
      "insert into funders (user_id, name, submission_email, approval_valid_days) values ($1, $2, 'subs@e2e-lender.example.com', 30) returning id",
      [uid, lender],
    );
    made.funders.push(f.id);
    await open("/funders");
    // the lender list is itself a card, so the innermost match is the lender's own section
    const lenderCard = () => page.locator("section", { hasText: lender }).last();
    await lenderCard().getByRole("button", { name: "Edit", exact: true }).click();
    const dlg = page.getByRole("dialog");
    await dlg.waitFor();
    check(
      "the lender form shows the stored days, and a placeholder for blank",
      (await dlg.getByLabel("Approval good for").inputValue()) === "30" &&
        (await dlg.getByLabel("Approval good for").getAttribute("placeholder")) === "shop default",
    );
    await dlg.getByLabel("Approval good for").fill("");
    await dlg.getByRole("button", { name: "Save", exact: true }).click();
    await toast(new RegExp(`Saved ${lender}`));
    await page.waitForTimeout(500);
    check(
      "a blank approval-days box stores null, so the shop's number applies",
      (await one("select approval_valid_days from funders where id = $1", [f.id]))
        .approval_valid_days === null,
    );
    await lenderCard().getByRole("button", { name: "Edit", exact: true }).click();
    await dlg.waitFor();
    check(
      "the next edit shows the box still blank",
      (await dlg.getByLabel("Approval good for").inputValue()) === "",
    );
    await dlg.getByLabel("Approval good for").fill("14");
    await dlg.getByRole("button", { name: "Save", exact: true }).click();
    await toast(new RegExp(`Saved ${lender}`));
    await page.waitForTimeout(500);
    check(
      "a number still sets this lender's own",
      (await one("select approval_valid_days from funders where id = $1", [f.id]))
        .approval_valid_days === 14,
    );

    // ---- Buckets & templates: the claim checker's reasons ------------------------------------------------------
    const bad = `E2E claim ${stamp}`;
    const t1 = await one(
      "insert into templates (owner_id, name, subject, body, approved, created_by) values ($1, $2, 'You are approved', 'Guaranteed approved loan, no fees on this one.', false, $1) returning id",
      [uid, bad],
    );
    made.templates.push(t1.id);
    await open("/settings/buckets");
    const row = () => page.locator(`[data-template="${t1.id}"]`);
    await row().getByRole("button", { name: "Approve", exact: true }).click();
    await toast(/cannot be approved as written/);
    const reasons = page.locator(`[data-claim-reasons="${t1.id}"]`);
    await reasons.waitFor();
    const rt = await reasons.innerText();
    check(
      "a refused approval keeps the claim checker's reasons on the page",
      rt.includes('Says "approved"') &&
        rt.includes('Says "guaranteed"') &&
        rt.includes("Promises no fees") &&
        rt.includes('Says "loan"'),
      rt.replace(/\s+/g, " "),
    );
    check(
      "and the template is still unapproved in the database",
      (await one("select approved from templates where id = $1", [t1.id])).approved === false,
    );
    await q(
      "update templates set subject = 'Your statements', body = 'Hi {first_name}, upload your statements here: {upload_link}' where id = $1",
      [t1.id],
    );
    await open("/settings/buckets");
    await row().getByRole("button", { name: "Approve", exact: true }).click();
    await toast(/^Approved$/);
    await page.waitForTimeout(500);
    const ok1 = await one("select approved, approved_by from templates where id = $1", [t1.id]);
    check(
      "once the wording is fixed the same button approves it, by this manager",
      ok1.approved === true && ok1.approved_by === uid,
      JSON.stringify(ok1),
    );

    // ---- Buckets & templates: a template that paused itself ----------------------------------------------------
    const paused = `E2E paused ${stamp}`;
    const t2 = await one(
      "insert into templates (owner_id, name, subject, body, approved, auto_paused_at, auto_pause_reason, created_by) values (null, $1, 'Your statements', 'Hi {first_name}, upload your statements here: {upload_link}', true, now(), '6 of the last 20 emails bounced', $2) returning id",
      [paused, uid],
    );
    made.templates.push(t2.id);
    await open("/settings/buckets");
    const prow = page.locator(`[data-template="${t2.id}"]`);
    check(
      "a template the engine paused shows the bounce-spike badge and the reason",
      (await prow.getByText("paused automatically — bounce spike").isVisible()) &&
        (await prow.innerText()).includes("6 of the last 20 emails bounced"),
    );
    await prow.getByRole("button", { name: "Approve again" }).click();
    await toast(/Approved again/);
    await page.waitForTimeout(500);
    const unp = await one(
      "select auto_paused_at, auto_pause_reason, approved from templates where id = $1",
      [t2.id],
    );
    check(
      "Approve again clears the pause in the database",
      unp.auto_paused_at === null && unp.auto_pause_reason === "" && unp.approved === true,
      JSON.stringify(unp),
    );
    await open("/settings/buckets");
    check(
      "and the badge is gone",
      (await page
        .locator("li", { hasText: paused })
        .first()
        .getByText("paused automatically")
        .count()) === 0,
    );

    // ---- Buckets & templates: the score tables -----------------------------------------------------------------
    const interested = await one("select id from buckets where key = 'interested'", []);
    for (const bounced of [false, false, false, true])
      await q(
        "insert into outbox (user_id, lane, source, to_address, subject, text_body, status, sent_at, template_id, delivery_status) values ($1, 'sequence', $2, 'merchant@example.com', 'Hi', 'Hi', 'sent', now() - interval '1 day', $3, $4)",
        [uid, `bucket:${interested.id}:step:1`, t1.id, bounced ? "bounced" : "delivered"],
      );
    await open("/settings/buckets");
    const tcells = await page.locator(`[data-score="template-${t1.id}"] td`).allInnerTexts();
    check(
      "a template's score row counts its sends and bounces from the outbox",
      tcells[1] === "4" && tcells[2] === "0%" && tcells[4] === "25%",
      JSON.stringify(tcells),
    );
    const expectBucket = await one(
      "select count(*)::int as n from outbox where status = 'sent' and lane in ('sequence', 'blast') and sent_at > now() - interval '90 days' and source like $1",
      [`bucket:${interested.id}:%`],
    );
    const bcells = await page.locator(`[data-score="bucket-${interested.id}"] td`).allInnerTexts();
    check(
      "the bucket's score row sends match the database's count",
      Number(bcells[2]) === expectBucket.n && expectBucket.n >= 4,
      `${JSON.stringify(bcells)} vs ${expectBucket.n}`,
    );
    await q("delete from outbox where template_id = $1", [t1.id]);

    // ---- Commission plan: document retention -------------------------------------------------------------------
    await open("/settings/plan");
    await page.getByLabel("Keep documents of dead deals for").fill("400");
    await page.getByRole("button", { name: "Save retention" }).click();
    await toast(/Retention saved/);
    await page.waitForTimeout(500);
    check(
      "document retention days reach the database",
      (await shop()).document_retention_days === 400,
    );
    await page.getByLabel("Keep documents of dead deals for").fill("10");
    await page.getByRole("button", { name: "Save retention" }).click();
    await toast(/Keep documents at least 30 days/);
    await page.waitForTimeout(400);
    check(
      "a number below 30 is refused and nothing changes",
      (await shop()).document_retention_days === 400,
    );

    // ---- Commission plan: the month-end statements and the printable page ---------------------------------------
    const period = "2024-02-01";
    const closeIns = await q(
      "insert into commission_closes (period, closed_by, line_count, gross_cents, rep_cents, house_cents) values ($1, $2, 2, 500000, 250000, 250000) on conflict (period) do nothing returning period",
      [period, uid],
    );
    if (closeIns.length) made.closePeriod = period;
    const lines = [
      {
        id: 1,
        funding_id: "f1",
        kind: "expected",
        gross_cents: 400000,
        rep_cents: 200000,
        house_cents: 200000,
        note: "",
        business: "E2E Pizza & <Grill>",
        funder: "Pearl",
        funded_on: "2024-02-09",
      },
      {
        id: 2,
        funding_id: "f2",
        kind: "correction",
        gross_cents: 100000,
        rep_cents: 50000,
        house_cents: 50000,
        note: "terms fixed",
        business: "E2E Deli",
        funder: "Fora",
        funded_on: "2024-02-20",
      },
    ];
    const st = await one(
      "insert into commission_statements (period, user_id, line_count, gross_cents, rep_cents, house_cents, lines) values ($1, $2, 2, 500000, 250000, 250000, $3::jsonb) returning id",
      [period, uid, JSON.stringify(lines)],
    );
    await open("/settings/plan");
    const strow = page.locator(`[data-statement="${st.id}"]`);
    const stText = await strow.innerText();
    check(
      "the statements list shows the closed month and the person's statement totals",
      (await page.locator(`[data-month="${period}"]`).innerText()).includes("February 2024") &&
        stText.includes("$5,000.00") &&
        stText.includes("$2,500.00"),
      stText.replace(/\s+/g, " "),
    );
    const href = await strow
      .getByRole("link", { name: /Printable statement/ })
      .getAttribute("href");
    const res = await context.request.get(`${BASE}${href}`);
    const html = await res.text();
    check(
      "the printable page is plain HTML with every line, the totals and the lines' text escaped",
      res.status() === 200 &&
        (res.headers()["content-type"] ?? "").startsWith("text/html") &&
        html.includes("Commission statement — February 2024") &&
        html.includes("E2E Pizza &amp; &lt;Grill&gt;") &&
        html.includes("terms fixed") &&
        html.includes("$2,500.00") &&
        html.includes("2 lines") &&
        !html.includes("<Grill>"),
    );
    await page.goto(`${BASE}${href}`, { waitUntil: "networkidle" });
    check(
      "opened in the browser it shows the statement and a Print button",
      (await page.getByRole("button", { name: "Print" }).isVisible()) &&
        (await page.getByText("E2E Deli").isVisible()),
    );
    check(
      "a statement id that is not a statement is a 404",
      (
        await context.request.get(
          `${BASE}/settings/plan/statements/00000000-0000-4000-8000-000000000000`,
        )
      ).status() === 404,
    );
    await q("delete from commission_statements where id = $1", [st.id]);

    // ---- Team & trust --------------------------------------------------------------------------------------------
    const lenderX = await one(
      "insert into funders (user_id, name, submission_email) values ($1, $2, 'subs@e2e-x.example.com') returning id",
      [uid, `E2E Backdoor ${String(stamp).slice(-6)}`],
    );
    made.funders.push(lenderX.id);
    const cl = await q("select id from clients where user_id = $1 order by created_at limit 2", [
      uid,
    ]);
    for (const c of cl)
      await q(
        "insert into submissions (user_id, client_id, funder_id, sent_on) values ($1, $2, $3, current_date)",
        [uid, c.id, lenderX.id],
      );
    await q(
      "insert into backdoor_reports (client_id, reported_by, lender_ids) values ($1, $2, $3::uuid[])",
      [cl[0].id, uid, [lenderX.id]],
    );
    // a teammate who has not accepted the policy (the signed-in manager is sent to /policy until they have)
    const mate = await one(
      "insert into app_users (email, name, role, active, policy_accepted_at) values ($1, 'E2E Policy', 'rep', true, null) returning id",
      [`e2e-policy-${stamp}@example.com`],
    );
    made.users.push(mate.id);
    await open("/settings/team");
    check(
      "a person who has not accepted the policy reads 'not yet'",
      (await page.locator(`[data-policy="${mate.id}"]`).innerText()).includes("not yet"),
    );
    const acceptedAt = await one(
      `update app_users set policy_accepted_at = (date_trunc('day', now() at time zone 'UTC') - interval '2 days' + interval '12 hours') at time zone 'UTC'
        where id = $1
        returning to_char(policy_accepted_at at time zone $2, 'YYYY-MM-DD') as d`,
      [mate.id, (await one("select timezone from app_users where id = $1", [uid])).timezone],
    );
    await open("/settings/team");
    check(
      "and once the database has a time it shows that date",
      (await page.locator(`[data-policy="${mate.id}"]`).innerText()).includes(
        `accepted ${shortDate(acceptedAt.d)}`,
      ),
      await page.locator(`[data-policy="${mate.id}"]`).innerText(),
    );
    const bd = page.locator(`[data-lender-score="${lenderX.id}"]`);
    check(
      "the lender's backdoor score is reports per hundred files from the database (1 report, 2 files = 50)",
      (await bd.count()) === 1 &&
        (await bd.innerText()).replace(/\s+/g, " ").includes("2 1 50 per 100"),
      (await bd.count()) ? await bd.innerText() : "row missing",
    );
    const kinds = await page.locator("[data-trust-kind]").allInnerTexts();
    check(
      "each trust alert kind has its explanation line",
      kinds.length === 4 &&
        kinds.some((k) => k.includes("Canary touched") && k.includes("fake merchant")) &&
        kinds.some((k) => k.includes("Another rep's lead")) &&
        kinds.some((k) => k.includes("Burst of copies") && k.includes("20 or more")) &&
        kinds.some((k) => k.includes("after hours")),
      JSON.stringify(kinds.map((k) => k.slice(0, 30))),
    );
    await q(
      "insert into user_alerts (user_id, kind, title, href, dedupe_key) values ($1, 'trust', $2, '/settings/team', $3)",
      [uid, `E2E canary alert ${stamp}`, `trust:canary:e2e:${stamp}`],
    );
    await open("/settings/team");
    check(
      "a trust alert the hourly job wrote shows with its pattern's name",
      (await page.locator("section", { hasText: "Trust alerts" }).first().innerText()).includes(
        `E2E canary alert ${stamp}`,
      ),
    );
    await q("delete from user_alerts where user_id = $1 and dedupe_key like 'trust:canary:e2e:%'", [
      uid,
    ]);
    await q("delete from backdoor_reports where client_id = $1", [cl[0].id]);
    await q("delete from submissions where funder_id = $1", [lenderX.id]);

    // ---- AI: the opener mode and the spend list ----------------------------------------------------------------
    await open("/settings/ai");
    await page.getByLabel("Win-back opening line").selectOption("auto");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await toast(/^Saved$/);
    await page.waitForTimeout(500);
    check(
      "the win-back opener mode reaches the database",
      (await shop()).winback_opener_mode === "auto",
    );
    await open("/settings/ai");
    check(
      "and the form loads it back",
      (await page.getByLabel("Win-back opening line").inputValue()) === "auto",
    );
    await q(
      "insert into ai_runs (purpose, model, prompt_version, input_hash, cost_cents, created_at) values ('e2e_wire_check', 'm', 'v', 'h', 12.5, now()), ('e2e_wire_check', 'm', 'v', 'h', 7.5, now()), ('e2e_wire_check', 'm', 'v', 'h', 80, now() - interval '10 days')",
    );
    await open("/settings/ai");
    const spend = await page.locator('[data-purpose="e2e_wire_check"] td').allInnerTexts();
    check(
      "the spend list shows a purpose's runs and cost, today and over 30 days",
      spend[0] === "E2e wire check" &&
        spend[1] === "2" &&
        spend[2] === "20.00¢" &&
        spend[3] === "3" &&
        spend[4] === "$1.00",
      JSON.stringify(spend),
    );
    await q("delete from ai_runs where purpose = 'e2e_wire_check'");

    // ---- State rules and registrations ---------------------------------------------------------------------------
    const pick = await one(
      "select r.state::text as state from state_rules r where not exists (select 1 from shop_registrations g where g.state = r.state) order by r.state limit 1",
      [],
    );
    let state = pick?.state;
    if (!state) {
      state = (await one("select state::text as state from state_rules order by state limit 1", []))
        .state;
      made.regBefore = await one("select * from shop_registrations where state = $1", [state]);
    }
    made.regState = state;
    await open("/settings/states");
    check(
      "the page says the shop's lawyer maintains the rules",
      await page.getByText("The shop's lawyer maintains the rules").isVisible(),
    );
    const in20 = (await one("select (current_date + 20)::text as d", [])).d;
    const in200 = (await one("select (current_date + 200)::text as d", [])).d;
    if (made.regBefore) {
      await page.getByRole("button", { name: `Edit ${state} registration` }).click();
    } else {
      await page.getByRole("button", { name: "+ Registration" }).click();
    }
    const sd = page.getByRole("dialog");
    await sd.waitFor();
    if (!made.regBefore) await sd.locator("select").first().selectOption(state); // the State box is the first select
    await sd.getByLabel("Status").selectOption("registered");
    await sd.getByLabel("Registration number").fill("E2E-77");
    await sd.getByLabel("Renews on").fill(in20);
    await sd.getByRole("button", { name: "Save registration" }).click();
    await toast(/Registration saved/);
    await page.waitForTimeout(500);
    const reg1 = await one(
      "select status, registration_no, renews_on::text as renews_on from shop_registrations where state = $1",
      [state],
    );
    check(
      "a new registration is in the table with its status, number and renewal date",
      reg1?.status === "registered" && reg1.registration_no === "E2E-77" && reg1.renews_on === in20,
      JSON.stringify(reg1),
    );
    const srow = page.locator(`[data-state-row="${state}"]`);
    check(
      "the list shows it, with how close the renewal is",
      (await srow.innerText()).includes("renews in 20 days"),
      (await srow.innerText()).replace(/\s+/g, " "),
    );
    await page.getByRole("button", { name: `Edit ${state} registration` }).click();
    await sd.waitFor();
    await sd.getByLabel("Renews on").fill(in200);
    await sd.getByRole("button", { name: "Save registration" }).click();
    await toast(/Registration saved/);
    await page.waitForTimeout(500);
    const reg2 = await q(
      "select renews_on::text as renews_on, registration_no from shop_registrations where state = $1",
      [state],
    );
    check(
      "editing the renewal date changes that row, not a copy",
      reg2.length === 1 && reg2[0].renews_on === in200 && reg2[0].registration_no === "E2E-77",
      JSON.stringify(reg2),
    );
    await page.getByRole("button", { name: `Edit ${state} registration` }).click();
    await sd.waitFor();
    await sd.getByLabel("Renews on").fill("");
    await sd.getByRole("button", { name: "Save registration" }).click();
    await toast(/Registration saved/);
    await page.waitForTimeout(500);
    check(
      "emptying the date clears it",
      (await one("select renews_on from shop_registrations where state = $1", [state]))
        .renews_on === null,
    );

    // ---- Me: the colour mode ------------------------------------------------------------------------------------
    await open("/settings");
    const group = page.getByRole("radiogroup", { name: "Color mode" });
    await group.getByRole("radio", { name: "Dark" }).click();
    await page.waitForFunction(
      () => document.documentElement.getAttribute("data-theme") === "dark",
    );
    await page.waitForTimeout(600);
    check(
      "the switch on the Me page sets the theme cookie",
      (await context.cookies()).find((c) => c.name === "theme")?.value === "dark",
    );
    await open("/settings");
    check(
      "and the page comes back dark with Dark selected",
      (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "dark" &&
        (await group.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")) === "true",
    );
    await group.getByRole("radio", { name: "Light" }).click();
    await page.waitForTimeout(600);

    // ---- no page scrolls sideways on a phone ---------------------------------------------------------------------
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of [
      "/settings",
      "/settings/email",
      "/settings/buckets",
      "/settings/buckets?tab=winback",
      "/settings/team",
      "/settings/plan",
      "/settings/ai",
      "/settings/states",
    ]) {
      await open(path);
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      check(`${path} does not scroll sideways at 390px`, !wide);
    }
  } finally {
    // each step on its own, so one that fails never hides the error that got us here
    const tidy = async (sql, params) => {
      try {
        await q(sql, params);
      } catch (e) {
        console.log(`cleanup: ${sql.slice(0, 40)}… — ${e.message.split("\n")[0]}`);
      }
    };
    await tidy("delete from commission_statements where user_id = $1", [uid]);
    if (made.closePeriod)
      await tidy("delete from commission_closes where period = $1", [made.closePeriod]);
    await tidy("delete from outbox where user_id = $1", [uid]);
    await tidy(
      "delete from user_alerts where user_id = $1 and dedupe_key like 'trust:canary:e2e:%'",
      [uid],
    );
    await tidy("delete from backdoor_reports where reported_by = $1", [uid]);
    for (const id of made.templates) await tidy("delete from templates where id = $1", [id]);
    for (const id of made.funders) {
      await tidy("delete from submissions where funder_id = $1", [id]);
      await tidy("delete from funders where id = $1", [id]);
    }
    for (const id of made.users) await tidy("delete from app_users where id = $1", [id]);
    await tidy("delete from ai_runs where purpose = 'e2e_wire_check'");
    await tidy("delete from mail_sync_state where user_id = $1", [uid]);
    await tidy("delete from gmail_connections where user_id = $1", [uid]);
    if (made.regState) {
      await tidy("delete from shop_registrations where state = $1", [made.regState]);
      const b = made.regBefore;
      if (b)
        await tidy(
          "insert into shop_registrations (state, registration_no, status, renews_on, note) values ($1, $2, $3, $4, $5)",
          [b.state, b.registration_no, b.status, b.renews_on, b.note],
        );
    }
    // the sender first (changing it resets the DNS columns), then everything else the run touched
    await tidy("update shop_settings set automation_from = $1", [before.automation_from]);
    await tidy(
      `update shop_settings set dns_ok = $1, dns_checked_at = $2, dns_result = $3::jsonb, send_on_holidays = $4,
              approval_valid_days = $5, resubmit_block_days = $6, deals_inbox_address = $7, lender_chase_mode = $8,
              document_retention_days = $9, winback_opener_mode = $10`,
      [
        before.dns_ok,
        before.dns_checked_at,
        JSON.stringify(before.dns_result),
        before.send_on_holidays,
        before.approval_valid_days,
        before.resubmit_block_days,
        before.deals_inbox_address,
        before.lender_chase_mode,
        before.document_retention_days,
        before.winback_opener_mode,
      ],
    );
    await browser.close();
  }
}
