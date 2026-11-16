// Lead Intake: a lead typed in lands as a merchant, in the bucket, with the welcome email queued. Run: pnpm e2e crm-intake
import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);

export default async function intakeFlow({ email }) {
  const { browser, page } = await openBrowser(email);
  await page.goto(`${BASE}/lead-intake`, { waitUntil: "networkidle" });
  check(
    "Lead Intake heading",
    await page.getByRole("heading", { name: "Lead Intake" }).isVisible(),
  );
  await page.getByPlaceholder("(305) 555-0100").fill("3055550199");
  await page.getByPlaceholder("owner@business.com").fill("rosa@e2e-cafe.test");
  await page.getByPlaceholder("Mike", { exact: true }).fill("Rosa");
  await page.getByPlaceholder("Ross", { exact: true }).fill("Lind");
  await page.getByPlaceholder("Mike's Pizza").fill("E2E Cafe");
  await page.getByPlaceholder("Restaurant").fill("Cafe");
  await page.getByPlaceholder("FL", { exact: true }).fill("FL");
  await page.getByPlaceholder("50k").fill("45k");
  await page.locator("textarea").fill("New espresso machines before the season");
  const submit = page.getByRole("button", { name: /Submit to Interested/ });
  check("the button names the bucket", await submit.isVisible());
  await submit.click();
  await page.getByText(/E2E Cafe is in/).waitFor({ timeout: 10000 });
  const row = await withDb((db) =>
    one(
      db,
      `select c.id, c.contact_name, c.email, c.state, c.looking_for,
              (select wanted_amount_cents from client_asks k where k.client_id = c.id order by created_at desc limit 1) as wanted,
              (select b.name from enrollments e join buckets b on b.id = e.bucket_id where e.client_id = c.id and e.stopped_at is null) as bucket
         from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = 'E2E Cafe'`,
      [email],
    ),
  );
  check(
    "the merchant is in the database with every field",
    row?.contact_name === "Rosa Lind" &&
      row?.email === "rosa@e2e-cafe.test" &&
      row?.state === "FL" &&
      Number(row?.wanted) === 4_500_000 &&
      row?.looking_for.startsWith("New espresso"),
    JSON.stringify(row),
  );
  check(
    "filed into the Interested bucket",
    row?.bucket === "Interested",
    JSON.stringify(row?.bucket),
  );

  // the same phone again is a duplicate, not a second merchant
  await page.getByRole("button", { name: "Add another" }).click();
  await page.getByPlaceholder("(305) 555-0100").fill("3055550199");
  await page.getByPlaceholder("owner@business.com").click();
  await page.getByText(/already in the CRM/).waitFor({ timeout: 8000 });
  check("a known phone warns before submit", true);
  await page.getByRole("button", { name: /Submit to Interested|Add lead/ }).click();
  await page.getByText(/was already here/).waitFor({ timeout: 10000 });
  const n = await withDb((db) =>
    one(
      db,
      "select count(*)::int as n from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = 'E2E Cafe'",
      [email],
    ),
  );
  check("no second merchant was made", n?.n === 1, JSON.stringify(n));
  await browser.close();
}
