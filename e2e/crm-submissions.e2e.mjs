// Submission Board: the ops queue, mark sent, kick back with a reason the rep sees. Run: pnpm e2e crm-submissions
import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);

export default async function submissionsFlow({ email }) {
  const userId = await withDb((db) =>
    one(db, "select id from app_users where email = $1", [email]),
  ).then((r) => r.id);
  const names = await withDb((db) =>
    db
      .query(
        "select id, business_name from clients where user_id = $1 and stage in ('application_in', 'stips', 'interested') order by business_name limit 2",
        [userId],
      )
      .then((r) => r.rows),
  );
  await withDb(async (db) => {
    await db.query("select set_config('app.user_id', $1, false)", [userId]);
    for (const c of names) await db.query("select submit_to_ops($1)", [c.id]);
  });
  const [first, second] = names;

  const { browser, page } = await openBrowser(email);
  await page.goto(`${BASE}/board`, { waitUntil: "networkidle" });
  check(
    "Submission Board heading",
    await page.getByRole("heading", { name: "Submission Board" }).isVisible(),
  );
  const text = await page.locator("main").innerText();
  check(
    "both files sit in the Queued lane",
    text.includes(first.business_name) && text.includes(second.business_name),
  );

  // mark the first sent
  const row1 = page.locator("li", { hasText: first.business_name }).first();
  await row1.getByRole("button", { name: "Sent to lenders" }).click();
  await page.getByText(/Marked sent to lenders/).waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
  const d1 = await withDb((db) =>
    one(db, "select ops_status, sent_at is not null as sent from deals where client_id = $1", [
      first.id,
    ]),
  );
  check(
    "mark sent reaches the database",
    d1?.ops_status === "sent" && d1?.sent,
    JSON.stringify(d1),
  );

  // kick the second back with a reason
  const row2 = page.locator("li", { hasText: second.business_name }).first();
  await row2.getByRole("button", { name: "Kick back" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByLabel("What is wrong").selectOption("illegible_id");
  await dialog.getByPlaceholder(/Exactly what is missing/).fill("The license photo is blurry");
  await dialog.getByRole("button", { name: "Kick back" }).click();
  await page.getByText(/Sent back to the rep/).waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
  const d2 = await withDb((db) =>
    one(db, "select ops_status, kickback_reason, kickback_note from deals where client_id = $1", [
      second.id,
    ]),
  );
  check(
    "kick back reaches the database with the reason and note",
    d2?.ops_status === "kicked_back" &&
      d2?.kickback_reason === "illegible_id" &&
      d2?.kickback_note === "The license photo is blurry",
    JSON.stringify(d2),
  );
  await page.goto(`${BASE}/board?lane=kicked_back`, { waitUntil: "networkidle" });
  check(
    "the Kicked back lane shows it with the note",
    (await page.locator("main").innerText()).includes("The license photo is blurry"),
  );

  // the rep's deal page carries the kickback as the next step
  const deal = await withDb((db) =>
    one(db, "select id from deals where client_id = $1", [second.id]),
  );
  await page.goto(`${BASE}/deals/${deal.id}`, { waitUntil: "networkidle" });
  check(
    "deal page says Fix the file",
    (await page.locator("main").innerText()).includes("Fix the file"),
  );
  await browser.close();
}
