// The four Selective Capital approval designs and the hard stop, in the browser. A manager loads the designs from
// Settings > Approval emails; a rep marks a merchant approved with "I sent it already" (nothing goes on the outbox);
// "Stop emails for good" stops everything for that merchant and a manager turns it back on. Every check reads the DATABASE.
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

const one = (sql, params = []) => withDb((db) => db.query(sql, params)).then((r) => r.rows[0]);
const all = (sql, params = []) => withDb((db) => db.query(sql, params)).then((r) => r.rows);
const HOLD = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default async function stockDesignsFlow({ email }) {
  // the shop's designs are shared: keep whatever is there and put it back after
  const saved = await all(
    "select step, subject, html, file_name, delay_hours from approval_emails order by step",
  );
  const shop = await one("select postal_address, approval_emails_on from shop_settings");
  await withDb(async (db) => {
    await db.query("delete from approval_emails");
    await db.query(
      "insert into approval_emails (step, delay_hours) values (1, 0), (2, 24), (3, 48), (4, 72)",
    );
    await db.query(
      "update shop_settings set approval_emails_on = true, postal_address = case when postal_address = '' then '1 Main St, Miami FL 33101' else postal_address end",
    );
    await db.query("update app_users set phone = '(561) 555-0142' where email = $1", [email]);
  });
  const a = await one(
    `select c.id, c.business_name from clients c join app_users u on u.id = c.user_id
      where u.email = $1 and btrim(c.email) <> '' and c.contact_status = 'ok' and not c.email_opt_out
        and not exists (select 1 from trashed_clients t where t.client_id = c.id)
        and not exists (select 1 from approvals x where x.client_id = c.id)
      order by c.business_name limit 1`,
    [email],
  );
  // a rep sees only their own merchants: the approval steps run as the rep, the settings and turn-back-on as a manager
  let { browser, page } = await openBrowser(email);
  try {
    // 2. mark a merchant approved, "I sent it already": nothing is queued
    await page.goto(`${BASE}/approvals`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Add an approval" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("searchbox", { name: "Merchant" }).fill(a.business_name.slice(0, 8));
    await dialog
      .getByRole("button", { name: new RegExp(esc(a.business_name)) })
      .first()
      .click();
    await dialog.getByRole("textbox", { name: /^Approved amount/ }).fill("85k");
    await dialog.getByLabel("Funder holds it until").fill(HOLD);
    await dialog.getByRole("textbox", { name: /^Funder For you/ }).fill("Velocity Capital");
    await dialog.getByText("I sent it already").click();
    await dialog.getByRole("button", { name: "Mark approved" }).click();
    await page.getByText(new RegExp(`${esc(a.business_name)} is on Open approvals`)).waitFor();
    const ap = await one(
      "select id, status, first_sent_at, next_step, next_email_at from approvals where client_id = $1 order by created_at desc limit 1",
      [a.id],
    );
    const queued = await all("select 1 from outbox where client_id = $1 and lane = 'approval'", [
      a.id,
    ]);
    check(
      "'I sent it already' records the first email as sent and puts nothing on the outbox (database)",
      ap?.status === "open" && ap.first_sent_at !== null && queued.length === 0,
      JSON.stringify({ ap, queued: queued.length }),
    );

    // 3. Stop emails for good
    const row = page.getByRole("listitem").filter({ hasText: a.business_name });
    await row.getByRole("button", { name: new RegExp(`More for ${esc(a.business_name)}`) }).click();
    await page.getByRole("button", { name: "Stop emails for good" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Stop emails for good" }).click();
    await page.waitForTimeout(1500);
    const stopped = await one(
      `select c.email_opt_out, c.emails_stopped_at, a.emails, a.emails_note,
              (select count(*)::int from suppressions s where s.client_id = c.id and s.reason = 'manual') as sup,
              (select count(*)::int from activities t where t.client_id = c.id and t.body like 'Emails stopped by%') as notes
         from clients c join approvals a on a.client_id = c.id where c.id = $1 order by a.created_at desc limit 1`,
      [a.id],
    );
    check(
      "Stop emails for good stops the merchant's emails everywhere (database)",
      stopped.email_opt_out === true &&
        stopped.emails_stopped_at !== null &&
        stopped.emails === "stopped" &&
        stopped.emails_note === "manual_stop" &&
        stopped.sup === 1 &&
        stopped.notes === 1,
      JSON.stringify(stopped),
    );
  } finally {
    await browser.close();
  }
  await setRole(email, "manager");
  ({ browser, page } = await openBrowser(email));
  try {
    // 1. load the four designs
    await page.goto(`${BASE}/settings/approvals`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Load the Selective Capital designs" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Load the designs" }).click();
    await page.waitForTimeout(1500);
    const rows = await all(
      "select step, subject, html, delay_hours from approval_emails order by step limit 4",
    );
    check(
      "Load the designs saves the four emails in order with the right subjects and waits (database)",
      rows.length === 4 &&
        rows[0].subject === "{{business_name}}: Approved for Funding" &&
        rows[0].html.includes("Great news.") &&
        rows[1].subject === "Did you see your approval, {{first_name}}?" &&
        rows[2].subject === "Your offer is time-sensitive" &&
        rows[3].subject === "Should I keep your offer open, {{first_name}}?" &&
        rows.map((r) => r.delay_hours).join() === "0,24,48,48" &&
        rows.every((r) => r.html.includes("{{unsubscribe_link}}")),
      JSON.stringify(rows.map((r) => [r.step, r.subject, r.delay_hours])),
    );

    // 4. a manager turns them back on from the merchant's page
    await page.goto(`${BASE}/clients/${a.id}`, { waitUntil: "networkidle" });
    check(
      "the merchant's page says emails are stopped",
      (await page.getByText("Emails stopped").count()) > 0,
    );
    await page.getByRole("button", { name: "Turn emails back on" }).first().click();
    const confirm = page.getByRole("dialog").getByRole("button", { name: /Turn emails back on/ });
    if (await confirm.count()) await confirm.first().click();
    await page.waitForTimeout(1500);
    const back = await one("select email_opt_out, emails_stopped_at from clients where id = $1", [
      a.id,
    ]);
    check(
      "Turn emails back on clears the stop (database)",
      back.email_opt_out === false && back.emails_stopped_at === null,
      JSON.stringify(back),
    );
  } finally {
    await browser.close();
    await withDb(async (db) => {
      await db.query("delete from approval_emails");
      for (const s of saved)
        await db.query(
          "insert into approval_emails (step, subject, html, file_name, delay_hours) values ($1, $2, $3, $4, $5)",
          [s.step, s.subject, s.html, s.file_name, s.delay_hours],
        );
      await db.query("update shop_settings set approval_emails_on = $1, postal_address = $2", [
        shop.approval_emails_on,
        shop.postal_address,
      ]);
    });
  }
}
