// The settings controls that finished backends were missing (docs/UI-WIRING.md, Settings): each one is driven in the
// browser, then the DATABASE is read — a toast or a 200 is not proof. Run:
//   CHROMIUM_PATH=... BASE_URL=http://localhost:3012 node e2e/run.mjs wire-settings
// Everything it seeds is removed again, and the shop_settings columns it touches are put back.
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

const q = (sql, params) => withDb((db) => db.query(sql, params).then((r) => r.rows));
const one = (sql, params) => q(sql, params).then((r) => r[0]);
const SHOP_COLS = [
  "automation_from",
  "dns_ok",
  "dns_checked_at",
  "dns_result",
  "send_on_holidays",
  "daily_cap",
  "ai_daily_cap_cents",
  "open_nudge",
  "open_nudge_since",
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
  const made = { templates: [] };

  try {
    // ---- Email: the shop fields --------------------------------------------------------------------------------
    await open("/settings/email");
    check(
      "the Email page has no lender, deal or win-back fields",
      !/lender|deal|chase|approval stays|double submission/i.test(
        await page.locator("main").innerText(),
      ),
    );
    await page.getByLabel("Daily cap").fill("1450");
    await page.getByLabel("Send on US holidays").check();
    await page.getByLabel("Nudge after an open").check();
    await page.getByRole("button", { name: "Save settings" }).click();
    await toast(/^Saved$/);
    await page.waitForTimeout(500);
    const saved = await shop();
    check(
      "the daily cap, the holiday switch and the open nudge reach the database",
      saved.daily_cap === 1450 &&
        saved.send_on_holidays === true &&
        saved.open_nudge === true &&
        saved.open_nudge_since !== null,
      JSON.stringify(saved),
    );

    await page.getByLabel("Daily cap").fill("10");
    await page.getByRole("button", { name: "Save settings" }).click();
    await toast(/Daily cap must be at least 50/);
    check(
      "a refused value shows the reason and leaves the database as it was",
      (await shop()).daily_cap === 1450,
    );

    // the form loads what is stored: a reload shows what was saved
    await open("/settings/email");
    check(
      "a reload shows the saved values",
      (await page.getByLabel("Daily cap").inputValue()) === "1450" &&
        (await page.getByLabel("Send on US holidays").isChecked()),
    );

    // ---- Email: the DNS check ------------------------------------------------------------------------
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

    // ---- Email: last synced per mailbox --------------------------------------------------------------
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
      (await prow.getByText("paused automatically: bounce spike").isVisible()) &&
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

    // ---- AI: the switches and the spend list -------------------------------------------------------------------
    await open("/settings/ai");
    await page.getByLabel("Daily spend cap (cents)").fill("1234");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await toast(/^Saved$/);
    await page.waitForTimeout(500);
    check(
      "the AI daily spend cap reaches the database",
      (await shop()).ai_daily_cap_cents === 1234,
    );
    await open("/settings/ai");
    check(
      "and the form loads it back",
      (await page.getByLabel("Daily spend cap (cents)").inputValue()) === "1234",
    );
    // the run history below the form is data (old purposes keep their names); the words above it are the app's
    const aiText = (await page.locator("main").innerText()).split("Spend by purpose")[0];
    check(
      "the AI page speaks of replies and lead lines, not lenders, deals or win-back",
      !/lender|deal|win-?back|offer/i.test(aiText),
      aiText.replace(/\s+/g, " ").slice(0, 200),
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

    // ---- Team: no trust, policy or deal columns; and the removed pages are really gone ---------------------------
    await open("/settings/team");
    const teamText = await page.locator("main").innerText();
    check(
      "the Team table has no Policy, Trust or Open deals column",
      teamText.includes("The team") && !/policy|trust|open deals|offboard/i.test(teamText),
    );
    const gone = [];
    for (const path of [
      "/policy",
      "/board",
      "/deals",
      "/funders",
      "/funded",
      "/winback",
      "/earnings",
      "/renewals",
      "/long-game",
      "/settings/plan",
      "/settings/lenders",
      "/settings/states",
    ]) {
      const status = (await page.request.get(`${BASE}${path}`, { maxRedirects: 0 })).status();
      if (status !== 404) gone.push(`${path}:${status}`);
    }
    check("the pages of the removed features answer 404", gone.length === 0, gone.join(", "));

    // ---- Me: the colour mode ------------------------------------------------------------------------------------
    await open("/settings");
    // a desktop user has the same switch in the sidebar's account panel; this is the one on the page
    const group = page.locator("main").getByRole("radiogroup", { name: "Color mode" });
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
      "/settings/team",
      "/settings/ai",
      "/settings/sheets",
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
    await tidy("delete from outbox where user_id = $1", [uid]);
    for (const id of made.templates) await tidy("delete from templates where id = $1", [id]);
    await tidy("delete from ai_runs where purpose = 'e2e_wire_check'");
    await tidy("delete from mail_sync_state where user_id = $1", [uid]);
    await tidy("delete from gmail_connections where user_id = $1", [uid]);
    // the sender first (changing it resets the DNS columns), then everything else the run touched
    await tidy("update shop_settings set automation_from = $1", [before.automation_from]);
    await tidy(
      `update shop_settings set dns_ok = $1, dns_checked_at = $2, dns_result = $3::jsonb, send_on_holidays = $4,
              daily_cap = $5, ai_daily_cap_cents = $6, open_nudge = $7, open_nudge_since = $8`,
      [
        before.dns_ok,
        before.dns_checked_at,
        JSON.stringify(before.dns_result),
        before.send_on_holidays,
        before.daily_cap,
        before.ai_daily_cap_cents,
        before.open_nudge,
        before.open_nudge_since,
      ],
    );
    await browser.close();
  }
}
