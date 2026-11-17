// The shell every page sits in: the dropdown sidebar, the New lead sheet (a button, never a page), search, the
// colour mode, the phone menu, and the finish line (Hand off). Every write is read back from the DATABASE.
// Run: pnpm e2e shell
import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const rows = (sql, params = []) => withDb((db) => db.query(sql, params)).then((r) => r.rows);
const one = async (sql, params = []) => (await rows(sql, params))[0];
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
};

export default async function shellFlow({ email }) {
  const { browser, page, context } = await openBrowser(email);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const rail = page.locator("aside");
  const nav = rail.getByRole("navigation", { name: "Main" });

  // ---- the sidebar: four places, each a dropdown
  check(
    "dark is the default colour mode",
    (await page.locator("html").getAttribute("data-theme")) === "dark",
  );
  check(
    "the sidebar shows Overview, Follow Up, Merchants and Settings, and no Lead Intake page",
    (await nav.getByRole("link", { name: /^Overview/ }).isVisible()) &&
      (await nav.getByRole("button", { name: /^Follow Up/ }).isVisible()) &&
      (await nav.getByRole("button", { name: /^Merchants/ }).isVisible()) &&
      (await nav.getByRole("button", { name: /^Settings/ }).isVisible()) &&
      (await nav.getByText(/lead intake/i).count()) === 0,
  );
  const buckets = await rows(
    "select id, name from buckets where active and owner_id is null order by sort",
  );
  const firstBucket = buckets[0];
  check(
    "Follow Up is open and lists the buckets",
    (await nav.getByRole("button", { name: /^Follow Up/ }).getAttribute("aria-expanded")) ===
      "true" &&
      (await nav.getByRole("link", { name: new RegExp(`^${firstBucket.name}`) }).isVisible()),
    firstBucket.name,
  );
  await nav.getByRole("link", { name: new RegExp(`^${firstBucket.name}`) }).click();
  await page.waitForURL(new RegExp(`/follow-up\\?b=${firstBucket.id}`));
  check("a bucket in the dropdown opens that bucket", page.url().includes(`b=${firstBucket.id}`));

  const merchants = nav.getByRole("button", { name: /^Merchants/ });
  check("Merchants starts closed", (await merchants.getAttribute("aria-expanded")) === "false");
  await merchants.click();
  check(
    "opening Merchants shows its five views",
    (await merchants.getAttribute("aria-expanded")) === "true" &&
      (await nav.getByRole("link", { name: /^All merchants/ }).isVisible()) &&
      (await nav.getByRole("link", { name: /^Call list/ }).isVisible()) &&
      (await nav.getByRole("link", { name: /^Power dial/ }).isVisible()) &&
      (await nav.getByRole("link", { name: /^Import a file/ }).isVisible()) &&
      (await nav.getByRole("link", { name: /^Trash/ }).isVisible()),
  );
  await nav.getByRole("link", { name: /^All merchants/ }).click();
  await page.waitForURL(/\/clients$/);
  check(
    "All merchants opens the list and is marked current",
    (await nav.getByRole("link", { name: /^All merchants/ }).getAttribute("aria-current")) ===
      "page",
  );

  // ---- search
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Find a merchant" });
  check("Ctrl+K opens the search palette", await until(() => palette.isVisible()));
  await page.keyboard.press("Escape");
  await rail.getByRole("button", { name: "Find a merchant" }).click();
  check(
    "the sidebar's search field opens the same palette",
    await until(() => palette.isVisible()),
  );
  await page.keyboard.press("Escape");

  // ---- New lead: a sheet over the page, opened by the button, by N, and by the old address
  const sheet = page.getByRole("dialog", { name: "Bring a merchant in" });
  await rail.getByRole("button", { name: /^New lead/ }).click();
  check(
    "New lead opens a sheet over the page (the address does not change)",
    (await until(() => sheet.isVisible())) && /\/clients$/.test(page.url()),
  );
  await page.keyboard.press("Escape");
  await until(async () => !(await sheet.isVisible()));
  await page.keyboard.press("n");
  check("pressing N opens it too", await until(() => sheet.isVisible()));

  const phone = `305555${String(Date.now()).slice(-4)}`;
  const business = `Shell Check ${Date.now()}`;
  await sheet.getByLabel("Phone", { exact: true }).fill(phone);
  await sheet.getByLabel("First name").fill("Shelly");
  await sheet.getByLabel("Last name").fill("Check");
  await sheet.getByLabel("Business", { exact: true }).fill(business);
  await sheet.getByRole("button", { name: /^(Submit to|Add lead)/ }).click();
  const made = await until(
    async () => Boolean(await one("select 1 from clients where business_name = $1", [business])),
    12000,
  );
  const lead = await one(
    `select c.id, (select count(*)::int from enrollments e where e.client_id = c.id and e.stopped_at is null) as live
       from clients c where c.business_name = $1`,
    [business],
  );
  check(
    "submitting the sheet makes the merchant and files it in a bucket (database)",
    made && lead?.live === 1,
    JSON.stringify(lead ?? null),
  );
  await page.keyboard.press("Escape");

  await page.goto(`${BASE}/lead-intake`, { waitUntil: "networkidle" });
  check(
    "the old Lead Intake address lands on the Overview with the sheet open",
    /\/\?new-lead=1$/.test(page.url()) && (await until(() => sheet.isVisible())),
    page.url(),
  );
  await page.keyboard.press("Escape");
  check(
    "closing it clears the address",
    await until(() => Promise.resolve(new URL(page.url()).search === "")),
    page.url(),
  );

  // ---- Overview
  check(
    "the Overview has the brought-in figure, the right-now strip and the queue",
    (await page.getByText("Brought in", { exact: true }).first().isVisible()) &&
      (await page.getByRole("region", { name: "Right now" }).isVisible()) &&
      (await page.getByRole("heading", { name: "Do this now" }).isVisible()),
  );

  // ---- the finish line: Hand off on the merchant page, read back from the database
  await page.goto(`${BASE}/clients/${lead.id}`, { waitUntil: "networkidle" });
  const handOff = page.getByRole("button", { name: /^Hand off/ }).first();
  if (check("the merchant page has a Hand off button", await until(() => handOff.isVisible()))) {
    await handOff.click();
    // a confirmation, if the page asks for one
    const confirm = page.getByRole("dialog").getByRole("button", { name: /^Hand off/ });
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    const done = await until(
      async () =>
        (await one("select brought_in_at from clients where id = $1", [lead.id]))?.brought_in_at !=
        null,
      10000,
    );
    const after = await one(
      `select (select count(*)::int from enrollments e where e.client_id = c.id and e.stopped_at is null) as live,
              (select stop_reason from enrollments e where e.client_id = c.id order by stopped_at desc nulls last limit 1) as reason
         from clients c where c.id = $1`,
      [lead.id],
    );
    check(
      "Hand off marks the merchant brought in and ends the chase (database)",
      done && after.live === 0 && after.reason === "brought_in",
      JSON.stringify(after),
    );
    check(
      "the page then says Brought in",
      await until(() =>
        page
          .getByText(/Brought in/)
          .first()
          .isVisible(),
      ),
    );
  }

  // ---- colour mode sticks
  await rail.getByRole("button", { name: "Account" }).click();
  await rail.getByRole("radio", { name: "Light" }).click();
  check(
    "choosing Light flips the page and is remembered in the cookie",
    (await page.locator("html").getAttribute("data-theme")) === "light" &&
      (await until(async () =>
        (await context.cookies()).some((c) => c.name === "theme" && c.value === "light"),
      )),
  );
  await browser.close();

  // ---- a phone: a top bar, the same rail behind the menu button, nothing scrolls sideways
  const phoneView = await openBrowser(email, { width: 390, height: 844 });
  const p = phoneView.page;
  await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check(
    "on a phone the Overview does not scroll sideways",
    (await p.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )) <= 0,
  );
  await p.getByRole("button", { name: "Menu" }).click();
  const menu = p.getByRole("dialog", { name: "Menu" });
  check(
    "the menu button slides the same navigation in",
    (await until(() => menu.isVisible())) &&
      (await menu.getByRole("button", { name: /^Merchants/ }).isVisible()),
  );
  await menu.getByRole("link", { name: /^Overview/ }).click();
  check("choosing a place closes the menu", await until(async () => !(await menu.isVisible())));
  await p.getByRole("banner").getByRole("button", { name: "New lead" }).click();
  check(
    "the phone bar's plus opens the New lead sheet",
    await until(() => p.getByRole("dialog", { name: "Bring a merchant in" }).isVisible()),
  );
  await phoneView.browser.close();
}
