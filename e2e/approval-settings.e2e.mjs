// Settings → Approval emails and the rep's phone, in the browser: a manager uploads a design (a broken one is refused
// before it is saved), changes a wait, adds and removes a follow-up, and sets the daytime window; a rep saves a phone
// and cannot open the manager's page. Every check reads the DATABASE.
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

const one = (sql, params = []) => withDb((db) => db.query(sql, params)).then((r) => r.rows[0]);
const all = (sql, params = []) => withDb((db) => db.query(sql, params)).then((r) => r.rows);

const good = `<!DOCTYPE html><html><head><title>Congrats {{first_name}}, you're approved</title></head><body>
<h1>Congrats, {{first_name}}.</h1><p>{{business_name}}: {{offer_amount}}.</p>
<a href="tel:{{rep_phone}}">{{rep_phone}}</a> <a href="{{unsubscribe_link}}">Unsubscribe</a></body></html>`;
const broken = `<!DOCTYPE html><html><head><title>Hi</title></head><body><p>Hi {{firstname}}</p></body></html>`;

export default async function approvalSettingsFlow({ email }) {
  const saved = await all(
    "select step, subject, html, file_name, delay_hours from approval_emails order by step",
  );
  const shop = await one(
    "select approval_emails_on, approval_window_start, approval_window_end, approval_weekends from shop_settings",
  );
  await withDb(async (db) => {
    await db.query("delete from approval_emails");
    await db.query(
      "insert into approval_emails (step, delay_hours) values (1, 0), (2, 24), (3, 48), (4, 72)",
    );
  });
  const me = await one("select id from app_users where email = $1", [email]);

  // a rep first: their phone, and the manager page is not theirs
  let { browser, page } = await openBrowser(email);
  try {
    await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
    await page.getByLabel("Phone", { exact: true }).fill("561 555 0142");
    await page.getByRole("button", { name: "Save phone" }).click();
    await page.getByRole("button", { name: "Save phone" }).isDisabled();
    await page.waitForTimeout(800);
    check(
      "a rep saves their phone (database)",
      (await one("select phone from app_users where id = $1", [me.id])).phone === "561 555 0142",
    );
    await page.goto(`${BASE}/settings/approvals`, { waitUntil: "networkidle" });
    check(
      "a rep cannot open Approval emails",
      !page.url().includes("/settings/approvals"),
      page.url(),
    );
  } finally {
    await browser.close();
  }

  await setRole(email, "manager");
  ({ browser, page } = await openBrowser(email));
  try {
    await page.goto(`${BASE}/settings/approvals`, { waitUntil: "networkidle" });
    check(
      "with no designs the page says approvals wait",
      (await page.getByText(/no design/i).count()) > 0,
    );
    const file = page.locator('input[type="file"]').first();
    await file.setInputFiles({
      name: "broken.html",
      mimeType: "text/html",
      buffer: Buffer.from(broken),
    });
    const save1 = page.getByRole("button", { name: "Save Email 1" });
    await page
      .getByText(/\{\{firstname\}\}/)
      .first()
      .waitFor();
    check("a broken design shows why and cannot be saved", await save1.isDisabled());
    check(
      "nothing is saved for it (database)",
      (await one("select html from approval_emails where step = 1")).html === "",
    );
    await page.getByRole("button", { name: "Discard changes" }).first().click();
    await file.setInputFiles({
      name: "approved.html",
      mimeType: "text/html",
      buffer: Buffer.from(good),
    });
    await save1.waitFor();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll("button")].find((b) => b.textContent === "Save Email 1")
          ?.disabled,
    );
    await save1.click();
    await page.waitForTimeout(1200);
    const row = await one(
      "select subject, html, file_name, updated_by from approval_emails where step = 1",
    );
    check(
      "a good design is saved with the subject from its <title> (database)",
      row.subject === "Congrats {{first_name}}, you're approved" &&
        row.html.includes("{{unsubscribe_link}}") &&
        row.file_name === "approved.html" &&
        row.updated_by === me.id,
      JSON.stringify({ subject: row.subject, file: row.file_name }),
    );

    // a wait
    await page.getByLabel("Wait before Follow-up 1", { exact: true }).fill("36");
    await page.getByLabel("Unit for the wait before Follow-up 1").selectOption("hours");
    await page.getByLabel("Wait before Follow-up 1", { exact: true }).fill("36");
    await page
      .getByRole("list", { name: "When each email goes" })
      .getByRole("button", { name: "Save" })
      .click();
    await page.waitForTimeout(1000);
    check(
      "a changed wait is saved in hours (database)",
      (await one("select delay_hours from approval_emails where step = 2")).delay_hours === 36,
    );

    // add one, take it off
    await page.getByRole("button", { name: "Add a follow-up" }).click();
    await page.waitForTimeout(1200);
    check(
      "Add a follow-up adds a fifth email (database)",
      (await all("select step from approval_emails")).length === 5,
    );
    await page.getByRole("button", { name: "Remove the last follow-up" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove it" }).click();
    await page.waitForTimeout(1200);
    check(
      "Remove takes the last one off (database)",
      (await all("select step from approval_emails")).length === 4,
    );

    // the window
    await page.getByLabel("Latest", { exact: false }).first().selectOption({ label: "5 PM" });
    await page.getByRole("switch", { name: /Weekends too/ }).check();
    await page.getByRole("button", { name: "Save", exact: true }).last().click();
    await page.waitForTimeout(1000);
    const s = await one("select approval_window_end, approval_weekends from shop_settings");
    check(
      "the daytime window is saved (database)",
      s.approval_window_end === 17 && s.approval_weekends === true,
      JSON.stringify(s),
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/settings/approvals`, { waitUntil: "networkidle" });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check("no sideways scroll on a phone", overflow <= 1, `${overflow}px`);
  } finally {
    await browser.close();
    await withDb(async (db) => {
      await db.query("delete from approval_emails");
      for (const r of saved)
        await db.query(
          "insert into approval_emails (step, subject, html, file_name, delay_hours) values ($1, $2, $3, $4, $5)",
          [r.step, r.subject, r.html, r.file_name, r.delay_hours],
        );
      await db.query(
        "update shop_settings set approval_emails_on = $1, approval_window_start = $2, approval_window_end = $3, approval_weekends = $4",
        [
          shop.approval_emails_on,
          shop.approval_window_start,
          shop.approval_window_end,
          shop.approval_weekends,
        ],
      );
    });
  }
}
