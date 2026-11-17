// New lead: a lead typed into the sheet lands as a merchant, in the bucket, and a known phone makes no second one.
// Run: pnpm e2e crm-intake
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);

export default async function intakeFlow({ email }) {
  await setRole(email, "manager");
  const { browser, page } = await openBrowser(email);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  // the Lead Intake page is now a sheet over whatever page you are on, opened by the sidebar's New lead button
  await page
    .locator("aside")
    .getByRole("button", { name: /^New lead/ })
    .click();
  const sheet = page.getByRole("dialog", { name: "Bring a merchant in" });
  await sheet.waitFor({ timeout: 10000 });
  check(
    "New lead opens the intake sheet on its One lead tab",
    (await sheet.getByRole("heading", { name: "Bring a merchant in" }).isVisible()) &&
      (await sheet.getByRole("tab", { name: "One lead" }).getAttribute("aria-selected")) === "true",
  );
  await sheet.getByPlaceholder("(305) 555-0100").fill("3055550199");
  await sheet.getByPlaceholder("owner@business.com").fill("rosa@e2e-cafe.test");
  await sheet.getByPlaceholder("Mike", { exact: true }).fill("Rosa");
  await sheet.getByPlaceholder("Ross", { exact: true }).fill("Lind");
  await sheet.getByPlaceholder("Mike's Pizza").fill("E2E Cafe");
  await sheet.getByPlaceholder("Restaurant").fill("Cafe");
  await sheet.getByPlaceholder("FL", { exact: true }).fill("FL");
  await sheet.getByPlaceholder("50k").fill("45k");
  await sheet
    .getByLabel("What are they looking for")
    .fill("New espresso machines before the season");
  const submit = sheet.getByRole("button", { name: /Submit to Interested/ });
  check(
    "the button names the bucket",
    (await submit.isVisible()) &&
      (await sheet
        .getByRole("radiogroup", { name: "Bucket" })
        .getByRole("radio", { name: /^Interested/ })
        .getAttribute("aria-checked")) === "true",
  );
  await submit.click();
  await sheet.getByText(/E2E Cafe is in/).waitFor({ timeout: 10000 });
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
  await sheet.getByRole("button", { name: "Add another" }).click();
  await sheet.getByPlaceholder("(305) 555-0100").fill("3055550199");
  await sheet.getByPlaceholder("owner@business.com").click();
  await sheet.getByText(/already in the CRM/).waitFor({ timeout: 8000 });
  check("a known phone warns before submit", true);
  await sheet.getByRole("button", { name: /Submit to Interested|Add lead/ }).click();
  await sheet.getByText(/was already here/).waitFor({ timeout: 10000 });
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
