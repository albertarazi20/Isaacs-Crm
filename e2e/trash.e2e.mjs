import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);

export default async function trashFlow({ email }) {
  const { browser, page } = await openBrowser(email);
  const client = await withDb((db) =>
    one(
      db,
      "select c.id, c.business_name from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = 'Rivera Auto Repair'",
      [email],
    ),
  );
  const state = () =>
    withDb(async (db) => ({
      trashed: (await db.query("select 1 from trashed_clients where client_id = $1", [client.id]))
        .rowCount,
      open: (
        await db.query(
          "select kind, (due_on - current_date)::int as days from timers where client_id = $1 and done_at is null",
          [client.id],
        )
      ).rows,
      exists: (await db.query("select 1 from clients where id = $1", [client.id])).rowCount,
    }));

  const before = (await state()).open;

  // Move to trash from the client page.
  await page.goto(`${BASE}/clients/${client.id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Move to trash" }).click();
  const dialog = page.getByRole("dialog");
  check("trash dialog says it can be restored", await dialog.getByText(/restore it/).isVisible());
  await dialog.getByRole("button", { name: "Move to trash" }).click();
  await page.waitForURL(`${BASE}/clients`, { timeout: 8000 });
  let s = await state();
  check("DB: client is in the trash with no open timers", s.trashed === 1 && s.open.length === 0);
  check("DB: the client row and its history still exist", s.exists === 1);

  await page.goto(`${BASE}/clients`, { waitUntil: "networkidle" });
  check("gone from the Clients list", (await page.getByText("Rivera Auto Repair").count()) === 0);
  await page.goto(`${BASE}/pipeline`, { waitUntil: "networkidle" });
  check("gone from the Board", (await page.getByText("Rivera Auto Repair").count()) === 0);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check("gone from Today", (await page.getByText("Rivera Auto Repair").count()) === 0);

  // Restore from the Trash page.
  await page.goto(`${BASE}/trash`, { waitUntil: "networkidle" });
  check("shows in the Trash", await page.getByText("Rivera Auto Repair").first().isVisible());
  await page.getByRole("button", { name: "Restore" }).first().click();
  await page.getByText(/Rivera Auto Repair restored/).waitFor({ timeout: 8000 });
  s = await state();
  const key = (rows) => JSON.stringify(rows.map((r) => `${r.kind}:${r.days}`).sort());
  // Future follow-ups come back as they were; anything already past due becomes one follow-up in a week.
  const expected = before.every((r) => r.days >= 0)
    ? key(before)
    : key([{ kind: "follow_up", days: 7 }]);
  check(
    "DB: restore gives back the follow-ups it closed (or one a week out if they were past due)",
    s.trashed === 0 && s.open.length >= 1 && key(s.open) === expected,
    `before=${key(before)} after=${key(s.open)}`,
  );
  await page.goto(`${BASE}/clients`, { waitUntil: "networkidle" });
  check("back in the Clients list", (await page.getByText("Rivera Auto Repair").count()) > 0);

  // Delete forever needs a second, explicit click.
  await page.goto(`${BASE}/clients/${client.id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Move to trash" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to trash" }).click();
  await page.waitForURL(`${BASE}/clients`, { timeout: 8000 });
  await page.goto(`${BASE}/trash`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Delete forever" }).first().click();
  s = await state();
  check("one click alone does not delete", s.exists === 1);
  await page.getByRole("button", { name: "Yes, delete for good" }).click();
  await page.getByText(/deleted for good/).waitFor({ timeout: 8000 });
  s = await state();
  check("DB: client row is gone after the confirmed delete", s.exists === 0 && s.trashed === 0);

  await page.screenshot({
    path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/trash.png` : "/tmp/trash.png",
  });
  await browser.close();
}
