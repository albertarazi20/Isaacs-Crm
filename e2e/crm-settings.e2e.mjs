// Settings: add a teammate, change the cap, write a template, set a bucket's sequence. Run: pnpm e2e crm-settings
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);

export default async function settingsFlow({ email }) {
  await setRole(email, "manager");
  const { browser, page } = await openBrowser(email);
  const stamp = Date.now();

  // team
  await page.goto(`${BASE}/settings/team`, { waitUntil: "networkidle" });
  check("Team & trust page", await page.getByText("The team").isVisible());
  await page.getByPlaceholder("Sam Rivera").fill("E2E Ops");
  await page.getByPlaceholder("sam@selectivecap.com").fill(`e2e-ops-${stamp}@selectivecap.com`);
  await page.getByLabel("Role").selectOption("ops");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText(/Added — they sign in/).waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
  const member = await withDb((db) =>
    one(db, "select role, active from app_users where email = $1", [
      `e2e-ops-${stamp}@selectivecap.com`,
    ]),
  );
  check(
    "the teammate is in the database as ops",
    member?.role === "ops" && member?.active === true,
    JSON.stringify(member),
  );
  await withDb((db) =>
    db.query("delete from app_users where email = $1", [`e2e-ops-${stamp}@selectivecap.com`]),
  );

  // email & lenders: the cap
  await page.goto(`${BASE}/settings/email`, { waitUntil: "networkidle" });
  const before = await withDb((db) => one(db, "select daily_cap from shop_settings", []));
  const capField = page.getByLabel("Daily cap");
  await capField.fill("1400");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page
    .getByText(/^Saved$/)
    .first()
    .waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
  const after = await withDb((db) => one(db, "select daily_cap from shop_settings", []));
  check("the cap reaches the database", after?.daily_cap === 1400, JSON.stringify(after));
  await withDb((db) => db.query("update shop_settings set daily_cap = $1", [before.daily_cap]));

  // buckets & templates: a template, then the Interested sequence uses it
  await page.goto(`${BASE}/settings/buckets`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "+ Template" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByPlaceholder("Interested — follow up").fill(`E2E welcome ${stamp}`);
  await dialog
    .getByPlaceholder(/your statements for/)
    .fill("{first_name}, quick one about {business}");
  await dialog
    .locator("textarea")
    .fill("Hi {first_name},\n\nUpload here: {upload_link}\n\n{sender}");
  await dialog.getByRole("button", { name: "Create" }).click();
  await page.getByText(/Template made/).waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
  const tpl = await withDb((db) =>
    one(db, "select id, approved, owner_id from templates where name = $1", [
      `E2E welcome ${stamp}`,
    ]),
  );
  check(
    "a manager's template is approved and shared on creation",
    tpl?.approved === true && tpl?.owner_id === null,
    JSON.stringify(tpl),
  );

  const card = page.locator('[data-sequence="Interested"]');
  await card.getByRole("button", { name: "+ Step" }).click();
  await card
    .locator("select")
    .last()
    .selectOption({ label: `E2E welcome ${stamp}` });
  await card.getByRole("button", { name: "Save sequence" }).click();
  await page.getByText(/Sequence saved/).waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
  const step = await withDb((db) =>
    one(
      db,
      "select s.step_no, s.day_offset from bucket_steps s join buckets b on b.id = s.bucket_id where b.key = 'interested' and s.template_id = $1",
      [tpl.id],
    ),
  );
  check("the new step is on the Interested sequence", Boolean(step), JSON.stringify(step));
  await withDb((db) => db.query("delete from bucket_steps where template_id = $1", [tpl.id]));
  await withDb((db) => db.query("delete from templates where id = $1", [tpl.id]));
  await browser.close();
}
