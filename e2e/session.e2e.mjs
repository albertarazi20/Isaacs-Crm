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
  // Now the real button: Settings -> Sign out of all devices.
  const epochBefore = await withDb((db) =>
    db
      .query("select session_epoch from app_users where email = $1", [email])
      .then((r) => r.rows[0].session_epoch),
  );
  await phone.goto(`${BASE}/api/dev-login?email=${encodeURIComponent(email)}`);
  await phone.goto(`${BASE}/clients`, { waitUntil: "networkidle" });
  check("second device is signed in again", !phone.url().includes("/login"));
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Sign out of all devices" }).click();
  check(
    "one click alone does not sign anyone out",
    (await withDb((db) =>
      db
        .query("select session_epoch from app_users where email = $1", [email])
        .then((r) => r.rows[0].session_epoch),
    )) === epochBefore,
  );
  await page.getByRole("button", { name: "Yes, sign out everywhere" }).click();
  await page.waitForURL("**/login", { timeout: 8000 });
  const epochAfter = await withDb((db) =>
    db
      .query("select session_epoch from app_users where email = $1", [email])
      .then((r) => r.rows[0].session_epoch),
  );
  check(
    "DB: the session epoch went up by one",
    epochAfter === epochBefore + 1,
    `${epochBefore} -> ${epochAfter}`,
  );
  await phone.goto(`${BASE}/clients`, { waitUntil: "networkidle" });
  check("the other device is signed out too", phone.url().includes("/login"), phone.url());
  await other.close();
  await browser.close();
}
