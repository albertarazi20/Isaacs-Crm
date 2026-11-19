// Open approvals in the browser: a rep marks a merchant approved (from the page's picker and from the merchant's page),
// the rep's own first email is recorded (nothing is sent for it), a follow-up queues once it is due, a reply puts the merchant at the top, and Pitched / Close / Pause /
// Reopen do what they say. Every check reads the DATABASE, not just the screen.
import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const one = (sql, params = []) => withDb((db) => db.query(sql, params)).then((r) => r.rows[0]);
const all = (sql, params = []) => withDb((db) => db.query(sql, params)).then((r) => r.rows);
const HOLD = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const design = (title) => `<!DOCTYPE html><html><head><title>${title}</title></head><body>
<h1>Congrats, {{first_name}}.</h1><p>{{business_name}} is approved for {{offer_amount}}.</p>
<a href="tel:{{rep_phone}}">{{rep_phone}}</a> {{rep_name}} {{rep_email}}
<p>Hold until {{offer_expiry}}. <a href="{{unsubscribe_link}}">Unsubscribe</a></p></body></html>`;

export default async function approvalsFlow({ email }) {
  // the shop's designs are shared: keep whatever is there and put it back after
  const saved = await all(
    "select step, subject, html, file_name, delay_hours from approval_emails order by step",
  );
  const shop = await one("select postal_address, approval_emails_on from shop_settings");
  await withDb(async (db) => {
    await db.query("delete from approval_emails");
    for (let step = 1; step <= 4; step += 1)
      await db.query(
        "insert into approval_emails (step, subject, html, delay_hours) values ($1, $2, $3, $4)",
        [
          step,
          step === 1 ? "Congrats {{first_name}}" : `Follow-up ${step - 1}`,
          design("x"),
          step === 1 ? 0 : 24 * (step - 1),
        ],
      );
    await db.query(
      "update shop_settings set approval_emails_on = true, postal_address = case when postal_address = '' then '1 Main St, Miami FL 33101' else postal_address end",
    );
    await db.query("update app_users set phone = '' where email = $1", [email]);
  });
  const merchants = await all(
    `select c.id, c.business_name from clients c join app_users u on u.id = c.user_id
      where u.email = $1 and btrim(c.email) <> '' and c.contact_status = 'ok' and not c.email_opt_out
        and not exists (select 1 from trashed_clients t where t.client_id = c.id)
      order by c.business_name limit 3`,
    [email],
  );
  const [a, b, c] = merchants;
  const approvalOf = (clientId) =>
    one(
      "select id, status, emails, emails_note, first_sent_at, amount_cents::float8 as amount, funder, closed_reason from approvals where client_id = $1 order by created_at desc limit 1",
      [clientId],
    );
  const outbox = (clientId) =>
    all(
      "select source, status, skip_reason, html_body from outbox where client_id = $1 and lane = 'approval' order by created_at",
      [clientId],
    );

  // the rep's first email went three days ago: follow-up 1 (24 hours after it) is due
  const backdate = (clientId) =>
    withDb((db) =>
      db.query(
        "update approvals set first_sent_at = now() - interval '3 days', emails_since = now() - interval '3 days' where client_id = $1 and status = 'open'",
        [clientId],
      ),
    );

  const { browser, page } = await openBrowser(email);
  try {
    await page.goto(`${BASE}/approvals`, { waitUntil: "networkidle" });
    check(
      "the sidebar has Open approvals",
      (await page.getByRole("link", { name: /^Open approvals/ }).count()) >= 1,
    );
    check(
      "an empty page says what to do",
      await page.getByText("No approvals waiting").isVisible(),
    );
    check(
      "a rep without a phone number is told the emails wait for it",
      await page.getByText(/wait for your phone number/).isVisible(),
    );

    // 1. from the page, with the picker
    await page.getByRole("button", { name: "Add an approval" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("searchbox", { name: "Merchant" }).fill(a.business_name.slice(0, 8));
    await dialog
      .getByRole("button", { name: new RegExp(esc(a.business_name)) })
      .first()
      .click();
    await dialog.getByRole("textbox", { name: /^Approved amount/ }).fill("85k");
    check(
      "the hold date starts empty and says which email quotes it",
      (await dialog.getByLabel("Funder holds it until").inputValue()) === "" &&
        (await dialog.getByText(/quotes? it, so that email waits/).count()) === 1,
    );
    await dialog.getByLabel("Funder holds it until").fill(HOLD);
    check(
      "the amount is read back as it will appear",
      await dialog.getByText("Goes in the emails as $85,000.").isVisible(),
    );
    await dialog.getByRole("textbox", { name: /^Funder For you/ }).fill("Velocity Capital");
    await dialog.getByRole("button", { name: "Mark approved" }).click();
    await page.getByText(new RegExp(`${esc(a.business_name)} is on Open approvals`)).waitFor();
    let ap = await approvalOf(a.id);
    check(
      "the approval is saved open with the amount and funder (database)",
      ap?.status === "open" && ap.amount === 8_500_000 && ap.funder === "Velocity Capital",
      JSON.stringify(ap),
    );
    check(
      "the form records the rep's own first email and puts nothing on the outbox (database)",
      ap.first_sent_at !== null && ap.emails === "running" && (await outbox(a.id)).length === 0,
      JSON.stringify(ap),
    );
    const row = page.getByRole("listitem").filter({ hasText: a.business_name });
    // follow-up 1 comes due: with no phone for the rep, nothing is queued and the reason is stored
    await backdate(a.id);
    await row.getByRole("button", { name: new RegExp(`More for ${esc(a.business_name)}`) }).click();
    await page.getByRole("button", { name: "Pause the emails" }).click();
    await page.waitForTimeout(600);
    await row.getByRole("button", { name: new RegExp(`More for ${esc(a.business_name)}`) }).click();
    await page.getByRole("button", { name: "Resume the emails" }).click();
    await page.waitForTimeout(800);
    ap = await approvalOf(a.id);
    check(
      "with no phone for the rep, nothing is queued and the reason is stored (database)",
      (await outbox(a.id)).length === 0 && ap.emails_note === "missing:rep_phone",
      JSON.stringify(ap),
    );
    check(
      "the row says it is waiting on the rep's phone",
      await row
        .getByText(/rep's phone number/)
        .waitFor({ timeout: 5000 })
        .then(() => true)
        .catch(() => false),
    );

    // the rep adds a phone: the next pass of the engine queues it (the page re-checks on Resume too)
    await withDb((db) =>
      db.query("update app_users set phone = '(561) 555-0142' where email = $1", [email]),
    );
    await row.getByRole("button", { name: new RegExp(`More for ${esc(a.business_name)}`) }).click();
    await page.getByRole("button", { name: "Pause the emails" }).click();
    await page.waitForTimeout(600);
    check("Pause stores paused (database)", (await approvalOf(a.id))?.emails === "paused");
    await row.getByRole("button", { name: new RegExp(`More for ${esc(a.business_name)}`) }).click();
    await page.getByRole("button", { name: "Resume the emails" }).click();
    await page.getByText(/^Resumed\. Follow-up 1 goes out/).waitFor();
    const queued = await outbox(a.id);
    check(
      "Resume queues follow-up 1, filled in for the merchant (database)",
      queued.length === 1 &&
        queued[0].status === "queued" &&
        queued[0].html_body.includes("$85,000") &&
        queued[0].html_body.includes("tel:+15615550142"),
      JSON.stringify(queued.map((q) => q.status)),
    );
    await page.reload({ waitUntil: "networkidle" });
    check(
      "the row now shows the email on its way",
      await page
        .getByRole("listitem")
        .filter({ hasText: a.business_name })
        .getByText("Sending")
        .isVisible(),
    );

    // 2. from the merchant's page
    await withDb((db) =>
      db.query("update clients set brought_in_at = now() where id = $1", [b.id]),
    );
    await page.goto(`${BASE}/clients/${b.id}`, { waitUntil: "networkidle" });
    await page
      .getByRole("region", { name: "Approval" })
      .getByRole("button", { name: "Mark approved" })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("textbox", { name: /^Approved amount/ })
      .fill("120,000");
    await page.getByRole("dialog").getByLabel("Funder holds it until").fill(HOLD);
    await page.getByRole("dialog").getByRole("button", { name: "Mark approved" }).click();
    await page.getByRole("region", { name: "Open approval" }).waitFor();
    check(
      "marking from the merchant's page records the rep's first email and queues nothing (database)",
      (await outbox(b.id)).length === 0 &&
        (await approvalOf(b.id))?.amount === 12_000_000 &&
        (await approvalOf(b.id))?.first_sent_at !== null,
    );
    // follow-up 1 comes due: pausing and resuming makes the engine queue it
    await backdate(b.id);
    await page.goto(`${BASE}/approvals`, { waitUntil: "networkidle" });
    const brow = page.getByRole("listitem").filter({ hasText: b.business_name });
    await brow
      .getByRole("button", { name: new RegExp(`More for ${esc(b.business_name)}`) })
      .click();
    await page.getByRole("button", { name: "Pause the emails" }).click();
    await page.waitForTimeout(600);
    await brow
      .getByRole("button", { name: new RegExp(`More for ${esc(b.business_name)}`) })
      .click();
    await page.getByRole("button", { name: "Resume the emails" }).click();
    await page.getByText(/^Resumed\. Follow-up 1 goes out/).waitFor();
    check(
      "follow-up 1 is queued once it is due (database)",
      (await outbox(b.id)).map((o) => o.status).join() === "queued",
    );
    await page.goto(`${BASE}/clients/${b.id}`, { waitUntil: "networkidle" });
    check(
      "the merchant's page shows the open approval",
      await page.getByRole("region", { name: "Open approval" }).getByText("$120,000").isVisible(),
    );

    // 3. a reply: top of the list, and the queued email is taken back by the worker's check
    await withDb((db) =>
      db.query(
        "insert into inbound_emails (mailbox_user_id, gmail_id, from_address, subject, received_at, client_id, kind) select user_id, 'e2e-' || id, email, 'Re: approved', now(), id, 'merchant' from clients where id = $1",
        [b.id],
      ),
    );
    await page.goto(`${BASE}/approvals`, { waitUntil: "networkidle" });
    const first = page
      .getByRole("list", { name: "Waiting on a pitch" })
      .getByRole("listitem")
      .first();
    check(
      "a merchant who replied is first, marked Replied",
      (await first.textContent()).includes(b.business_name) &&
        (await first.getByText("Replied").first().isVisible()),
    );

    // the "more" menu works on a card that is not the last one (each card is its own layer)
    const firstRow = page
      .getByRole("list", { name: "Waiting on a pitch" })
      .getByRole("listitem")
      .first();
    await firstRow.getByRole("button", { name: /^More for/ }).click();
    await page.getByRole("button", { name: "Change the approval" }).click({ timeout: 5000 });
    const edit = page.getByRole("dialog");
    await edit.getByRole("textbox", { name: /^Approved amount/ }).fill("99,000");
    await edit.getByRole("button", { name: "Save" }).click();
    await edit.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    check(
      "the edit dialog closes after a save",
      (await page.getByRole("dialog").count()) === 0 ||
        !(await page.getByRole("dialog").first().isVisible()),
    );
    check(
      "the changed amount is stored (database)",
      (await one("select count(*)::int as n from approvals where amount_cents = 9900000")).n === 1,
    );

    // 4. Pitched, then Undo puts it back
    await first.getByRole("button", { name: "Pitched" }).click();
    await page.getByText(new RegExp(`${esc(b.business_name)}: pitched`)).waitFor();
    ap = await approvalOf(b.id);
    check(
      "Pitched stores pitched and stops the emails (database)",
      ap?.status === "pitched" && ap.emails === "stopped",
    );
    check(
      "the queued email is taken back (database)",
      (await outbox(b.id)).every((o) => o.status === "cancelled"),
    );
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByText("Back on Open approvals, the emails as they were").waitFor();
    await page.waitForTimeout(600);
    check(
      "Undo reopens it, and the reply it already had still keeps the emails stopped (database)",
      (await approvalOf(b.id))?.status === "open" &&
        (await approvalOf(b.id))?.emails === "stopped" &&
        (await approvalOf(b.id))?.emails_note === "replied",
    );

    // 5. Close with a reason
    await withDb((db) =>
      db.query("update clients set brought_in_at = now() where id = $1", [c.id]),
    );
    await page.goto(`${BASE}/clients/${c.id}`, { waitUntil: "networkidle" });
    await page
      .getByRole("region", { name: "Approval" })
      .getByRole("button", { name: "Mark approved" })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("textbox", { name: /^Approved amount/ })
      .fill("40000");
    await page.getByRole("dialog").getByLabel("Funder holds it until").fill(HOLD);
    await page.getByRole("dialog").getByRole("button", { name: "Mark approved" }).click();
    await page.getByRole("region", { name: "Open approval" }).waitFor();
    await page.goto(`${BASE}/approvals`, { waitUntil: "networkidle" });
    const crow = page.getByRole("listitem").filter({ hasText: c.business_name });
    await crow
      .getByRole("button", { name: new RegExp(`More for ${esc(c.business_name)}`) })
      .click();
    await page.getByRole("button", { name: "Close it (not going ahead)" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Went with another funder" })
      .click();
    await page.getByRole("dialog").getByRole("button", { name: "Close it" }).click();
    await page.getByText(new RegExp(`${esc(c.business_name)}: closed`)).waitFor();
    ap = await approvalOf(c.id);
    check(
      "Close stores the reason (database)",
      ap?.status === "closed" && ap.closed_reason === "Went with another funder",
    );
    await page.goto(`${BASE}/approvals?view=closed`, { waitUntil: "networkidle" });
    check(
      "it is under Closed with its reason",
      await page.getByText("Went with another funder").isVisible(),
    );

    // 6. a phone
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/approvals`, { waitUntil: "networkidle" });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check("no sideways scroll on a phone", overflow <= 1, `${overflow}px`);
  } finally {
    await browser.close();
    await withDb(async (db) => {
      await db.query("delete from approval_emails");
      for (const s of saved)
        await db.query(
          "insert into approval_emails (step, subject, html, file_name, delay_hours) values ($1, $2, $3, $4, $5)",
          [s.step, s.subject, s.html, s.file_name, s.delay_hours],
        );
      await db.query("update shop_settings set postal_address = $1, approval_emails_on = $2", [
        shop.postal_address,
        shop.approval_emails_on,
      ]);
    });
  }
}
