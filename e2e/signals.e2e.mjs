// Hot signals in the browser: a merchant who keeps their upload link or application on screen for a few seconds is
// recorded (a glance shorter than that is not), and the rep's Overview puts them in "do this now" as "Opened link".
// Every check reads the DATABASE.
import { chromium } from "playwright-core";
import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const one = (sql, params = []) => withDb((db) => db.query(sql, params)).then((r) => r.rows[0]);
const opens = async (id) =>
  (await one("select count(*)::int as n from link_opens where client_id = $1", [id])).n;

export default async function signalsFlow({ email }) {
  const m = await one(
    `select c.id, c.business_name, c.upload_token, c.application_token from clients c join app_users u on u.id = c.user_id
      where u.email = $1 and c.brought_in_at is null
        and not exists (select 1 from trashed_clients t where t.client_id = c.id)
      order by c.business_name limit 1`,
    [email],
  );
  // the merchant: a plain browser, no sign-in
  const merchant = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await (await merchant.newContext()).newPage();
  try {
    await page.goto(`${BASE}/upload/${m.upload_token}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    check("a glance shorter than three seconds records nothing", (await opens(m.id)) === 0);
    await page.waitForTimeout(3000);
    check("keeping the upload page open records one open (database)", (await opens(m.id)) === 1);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(4000);
    check("opening it again within half an hour adds nothing", (await opens(m.id)) === 1);
    const line = await one(
      "select count(*)::int as n from activities where client_id = $1 and body = 'Opened the upload link'",
      [m.id],
    );
    check("the timeline gets one line", line.n === 1);
  } finally {
    await merchant.close();
  }

  // the rep
  const { browser, page: rep } = await openBrowser(email);
  try {
    await rep.goto(`${BASE}/`, { waitUntil: "networkidle" });
    const row = rep
      .getByRole("link", {
        name: new RegExp(m.business_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      })
      .filter({
        hasText: "Opened the upload link, nothing sent yet",
      });
    check(
      "the Overview's do-this-now list shows the merchant as Opened link",
      (await row.count()) >= 1,
      m.business_name,
    );
    const card = rep
      .getByRole("region", { name: "Recommended next" })
      .getByText(/who just opened their link/);
    check("and a recommendation says to call them", await card.isVisible());
  } finally {
    await browser.close();
  }
}
