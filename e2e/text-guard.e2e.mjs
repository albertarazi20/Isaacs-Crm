import { BASE, check, openBrowser, withDb } from "./lib.mjs";

export default async function textGuardFlow({ email }) {
  const { browser, page } = await openBrowser(email);
  const id = await withDb((db) =>
    db
      .query(
        "select c.id from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = 'Rivera Auto Repair'",
        [email],
      )
      .then((r) => r.rows[0].id),
  );
  await page.goto(`${BASE}/clients/${id}`, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: /^Text Rivera/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  const box = dialog.locator("#text-message");
  const sentBtn = dialog.getByRole("button", { name: /I sent it/ });

  await box.fill("Hi, here is the link to apply: {application_link}");
  check("an unfilled {field} is called out", await dialog.getByRole("alert").isVisible());
  check("'I sent it' is disabled while a field is unfilled", await sentBtn.isDisabled());
  const off = await dialog.locator('span[aria-disabled="true"]').allInnerTexts();
  check(
    "both ways of opening the message are switched off",
    off.length === 2 &&
      off.some((t) => /Messages/.test(t)) &&
      off.some((t) => /Google Voice/.test(t)) &&
      (await dialog.getByRole("link", { name: /Open in Messages|Open Google Voice/ }).count()) ===
        0,
    JSON.stringify(off),
  );

  await box.fill("Hi Tony, checking in on the funding you asked about.");
  check("a finished message enables 'I sent it'", await sentBtn.isEnabled());
  check(
    "and the links come back",
    (await dialog.getByRole("link", { name: /Open in Messages/ }).count()) === 1 &&
      (await dialog.getByRole("link", { name: /Open Google Voice/ }).count()) === 1,
  );
  await browser.close();
}
