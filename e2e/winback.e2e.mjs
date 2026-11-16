// Winback: the pools page with a member, stop and resume. Run: pnpm e2e winback
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);

export default async function winbackFlow({ email }) {
  const userId = await withDb((db) =>
    one(db, "select id from app_users where email = $1", [email]),
  ).then((r) => r.id);
  const merchant = await withDb((db) =>
    one(
      db,
      "select id, business_name from clients where user_id = $1 and true order by (stage in ('declined', 'dead', 'not_interested', 'lost')) desc, business_name limit 1",
      [userId],
    ),
  );
  const member = await withDb((db) =>
    one(
      db,
      "insert into winback_members (user_id, client_id, pool, reason, workable_on, status, next_due_on) values ($1, $2, 'declined_curable', 'NSFs cleared', current_date, 'active', current_date) returning id",
      [userId, merchant.id],
    ),
  );
  await setRole(email, "manager");
  const { browser, page } = await openBrowser(email);
  await page.goto(`${BASE}/winback`, { waitUntil: "networkidle" });
  check("Winback heading", await page.getByRole("heading", { name: "Winback" }).isVisible());
  const text = await page.locator("main").innerText();
  check(
    "the pool lists the merchant with its reason",
    text.includes(merchant.business_name) && text.includes("NSFs cleared"),
  );
  const row = page.locator("li", { hasText: merchant.business_name }).first();
  await row.getByRole("button", { name: "Stop" }).click();
  await page
    .getByText(/^Stopped$/)
    .first()
    .waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
  const stopped = await withDb((db) =>
    one(db, "select status from winback_members where id = $1", [member.id]),
  );
  check("stop reaches the database", stopped?.status === "stopped", JSON.stringify(stopped));
  await page
    .locator("li", { hasText: merchant.business_name })
    .first()
    .getByRole("button", { name: "Resume" })
    .click();
  await page
    .getByText(/Back on/)
    .first()
    .waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
  const back = await withDb((db) =>
    one(db, "select status from winback_members where id = $1", [member.id]),
  );
  check("resume reaches the database", back?.status === "active", JSON.stringify(back));
  await browser.close();
}
