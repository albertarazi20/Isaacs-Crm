import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);

export default async function contactFlow({ email }) {
  const { browser, page } = await openBrowser(email);
  const client = await withDb((db) =>
    one(
      db,
      "select c.id, c.business_name from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = 'Rivera Auto Repair'",
      [email],
    ),
  );
  await page.goto(`${BASE}/clients/${client.id}`, { waitUntil: "networkidle" });

  // Before: the buttons work.
  const callBtn = page.getByRole("button", { name: /^Call Rivera/ }).first();
  check("Call is enabled for a normal merchant", await callBtn.isEnabled());

  // Mark do-not-contact.
  await page.getByRole("button", { name: "Contact status" }).click();
  await page.getByText("Do not contact", { exact: true }).click();
  await page
    .getByLabel("What they said (kept on the record)")
    .fill("Asked us to stop calling on Oct 3");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await page.getByText(/all reminders cancelled/).waitFor({ timeout: 8000 });

  const row = await withDb((db) =>
    one(db, "select contact_status, contact_status_note from clients where id = $1", [client.id]),
  );
  check(
    "status and the merchant's words are stored",
    row.contact_status === "dnc" && row.contact_status_note.includes("Oct 3"),
  );
  const timers = await withDb((db) =>
    db.query(
      "select kind, (due_on - current_date)::int days from timers where client_id = $1 and done_at is null",
      [client.id],
    ),
  ).then((r) => r.rows);
  check(
    "every timer was cancelled except ONE review reminder ~36 months out",
    timers.length === 1 && timers[0].days >= 1090,
    JSON.stringify(timers),
  );

  await page.reload({ waitUntil: "networkidle" });
  for (const name of ["Call", "Text", "Email"]) {
    const b = page.getByRole("button", { name: new RegExp(`^${name} Rivera`) }).first();
    check(
      `${name} is disabled and says why`,
      (await b.isDisabled()) && (await b.getAttribute("title")) === "Marked do-not-contact",
    );
  }
  check(
    "a red 'Do not contact' label is shown",
    (await page.getByText("Do not contact").count()) > 0,
  );

  // They disappear from Today and from the board's call buttons.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check(
    "Today does not list them",
    (await page.getByRole("link", { name: "Rivera Auto Repair" }).count()) === 0,
  );

  // Lift it.
  await page.goto(`${BASE}/clients/${client.id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Contact status" }).click();
  await page.getByText("OK to contact", { exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await page.getByText("Contact status saved").waitFor({ timeout: 8000 });
  await page.reload({ waitUntil: "networkidle" });
  check(
    "lifting it re-enables Call",
    await page
      .getByRole("button", { name: /^Call Rivera/ })
      .first()
      .isEnabled(),
  );
  await browser.close();
}
