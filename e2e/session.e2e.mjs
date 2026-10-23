import { BASE, check, openBrowser, withDb } from "./lib.mjs";

export default async function sessionFlow({ email }) {
  const { browser, context, page } = await openBrowser(email);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check("signed in: Today loads", !page.url().includes("/login"));

  // A second device, signed in the same way.
  const other = await context.browser().newContext();
  const phone = await other.newPage();
  await phone.goto(`${BASE}/api/dev-login?email=${encodeURIComponent(email)}`);
  await phone.goto(`${BASE}/clients`, { waitUntil: "networkidle" });
  check("second device is signed in too", !phone.url().includes("/login"));

  // "Log out everywhere" is exactly this row changing.
  await withDb((db) =>
    db.query("update app_users set session_epoch = session_epoch + 1 where email = $1", [email]),
  );

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check("first device is sent to the login page", page.url().includes("/login"), page.url());
  await phone.goto(`${BASE}/clients`, { waitUntil: "networkidle" });
  check("second device is sent to the login page", phone.url().includes("/login"), phone.url());

  // Signing in again works and gets a token for the new epoch.
  await page.goto(`${BASE}/api/dev-login?email=${encodeURIComponent(email)}`);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check("signing back in works", !page.url().includes("/login"), page.url());
  await other.close();
  await browser.close();
}
