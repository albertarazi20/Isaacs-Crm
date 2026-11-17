import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);

export default async function todayFlow({ email }) {
  const { browser, context, page } = await openBrowser(email);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });

  const kpis = await page.locator("main >> text=Overdue").first().isVisible();
  check("Today shows the follow-up counts", kpis);

  // Snooze the first card by one month; the database must really move.
  const card = page.locator("article").first();
  const name = (await card.locator("a").first().innerText()).trim();
  const before = await withDb((db) =>
    one(
      db,
      "select next_due_on::text d from client_cards c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = $2",
      [email, name],
    ),
  );
  await card.locator("summary", { hasText: "Snooze" }).click(); // the snooze menu is a <details>
  await page.getByRole("button", { name: "1 month" }).first().click();
  // Snoozing a merchant whose application is in asks for a one-line reason first; give one if it shows.
  const ask = page.getByRole("button", { name: /^Snooze until/ });
  await ask
    .waitFor({ timeout: 1500 })
    .then(() => ask.click())
    .catch(() => undefined);
  await page.getByText(/snoozed until/i).waitFor({ timeout: 8000 });
  const after = await withDb((db) =>
    one(
      db,
      "select next_due_on::text d from client_cards c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = $2",
      [email, name],
    ),
  );
  check(
    "snooze moves the timer in the database",
    after.d > before.d,
    `${name}: ${before.d} → ${after.d}`,
  );
  await page.waitForTimeout(500);

  // Call → outcome prompt → "No answer" → logged, timer reset to tomorrow.
  const card2 = page.locator("article").first();
  const name2 = (await card2.locator("a").first().innerText()).trim();
  const [popup] = await Promise.all([
    context.waitForEvent("page", { timeout: 5000 }).catch(() => null),
    card2.getByRole("button", { name: /^Call/ }).click(),
  ]);
  if (popup) await popup.close();
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  check(
    "outcome prompt opens after Call",
    (await page.getByRole("dialog").innerText()).includes(`call with ${name2}`),
  );
  await page.getByRole("button", { name: "No answer" }).click();
  await page.getByRole("button", { name: "Log it" }).click();
  await page.getByText(/Logged — next follow-up/).waitFor({ timeout: 8000 });
  const act = await withDb((db) =>
    one(
      db,
      "select a.kind, a.outcome, (c.next_due_on - current_date)::int days from client_cards c join activities a on a.client_id = c.id join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = $2 and a.kind = 'call' order by a.occurred_at desc limit 1",
      [email, name2],
    ),
  );
  check(
    "call + no-answer logged and retry set for the next business day",
    act?.kind === "call" && act?.outcome === "no_answer" && act?.days <= 3,
    JSON.stringify(act),
  );

  // Text dialog: stage-aware template, then the outcome prompt.
  await page.waitForTimeout(500);
  const card3 = page.locator("article").first();
  await card3.getByRole("button", { name: /^Text/ }).click();
  await page.getByRole("dialog").waitFor();
  const msg = await page.getByRole("dialog").locator("textarea").inputValue();
  check(
    "text template greets the merchant and signs as Isaac",
    /^Hey [A-Z]/.test(msg) && /it's [A-Z]/.test(msg),
    msg.slice(0, 60),
  );
  await page.getByRole("button", { name: /I sent it/ }).click();
  await page.getByText(/How did the text with/).waitFor({ timeout: 5000 });
  check("outcome prompt opens after Text", true);
  await page.getByRole("button", { name: /Skip/ }).click();

  // Email without Gmail connected: connect + fallback, never a silent failure.
  await card3.getByRole("button", { name: /^Email/ }).click();
  await page.getByRole("dialog").waitFor();
  const dlg = await page.getByRole("dialog").innerText();
  check(
    "email dialog offers Connect Gmail and Open in Gmail",
    dlg.includes("Connect Gmail to send") && dlg.includes("Open in Gmail instead"),
  );
  await page.keyboard.press("Escape");

  // Quick add.
  await page.getByRole("button", { name: "+ Add client" }).click();
  await page.getByLabel("Business name *").fill("E2E Test Bakery");
  await page.getByLabel("Merchant's name", { exact: true }).fill("Pat Baker");
  await page.getByLabel("Phone", { exact: true }).fill("(305) 555-0999");
  await page.getByLabel("Funding they want").fill("45k");
  await page.getByRole("button", { name: "3m" }).first().click();
  await page.getByRole("button", { name: "Add client" }).last().click();
  await page.getByText(/Added E2E Test Bakery/).waitFor({ timeout: 8000 });
  const row = await withDb((db) =>
    one(
      db,
      "select c.stage, c.wanted_amount_cents::int w, (c.next_due_on - current_date)::int d from client_cards c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = 'E2E Test Bakery'",
      [email],
    ),
  );
  check(
    "quick add stores stage, ask and a 3-month timer",
    // "Name in" folds into Interested, so that is what quick add stores
    row?.stage === "interested" && row?.w === 4_500_000 && row?.d >= 89 && row?.d <= 92,
    JSON.stringify(row),
  );

  // Adding someone who is already in the CRM warns instead of quietly making a second card.
  await page.getByRole("button", { name: "+ Add client" }).click();
  await page.getByLabel("Business name *").fill("Totally Different Name");
  await page.getByLabel("Phone", { exact: true }).fill("305-555-0999");
  await page.getByRole("button", { name: "Add client" }).last().click();
  await page.getByText("This looks like someone you already have").waitFor({ timeout: 8000 });
  check(
    "duplicate phone is flagged by name",
    (await page.getByRole("alert").filter({ hasText: "looks like someone" }).innerText()).includes(
      "E2E Test Bakery",
    ),
  );
  const dupeCount = () =>
    withDb((db) =>
      one(
        db,
        "select count(*)::int n from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = 'Totally Different Name'",
        [email],
      ),
    );
  check("nothing was created while the warning is up", (await dupeCount()).n === 0);
  await page.getByRole("button", { name: "Add as a new client anyway" }).click();
  await page.getByText(/Added Totally Different Name/).waitFor({ timeout: 8000 });
  check("'add anyway' does create it", (await dupeCount()).n === 1);

  // Clients search by phone digits.
  await page.goto(`${BASE}/clients`, { waitUntil: "networkidle" });
  await page.getByLabel("Search clients").fill("0999");
  const found = await page.locator("tbody tr").allInnerTexts();
  check(
    "clients search finds merchants by phone digits",
    found.length === 2 && found.some((r) => r.includes("E2E Test Bakery")),
    `${found.length} rows`,
  );

  // Settings persist.
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.locator("select").first().selectOption("7");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await page.getByText("Settings saved").waitFor({ timeout: 8000 });
  const hour = await withDb((db) =>
    one(db, "select digest_hour from app_users where email = $1", [email]),
  );
  check("settings persist", hour?.digest_hour === 7);

  // The Today tab shows how many follow-ups are due.
  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  const badge = await page
    .locator("nav [aria-label$='follow-ups due']")
    .first()
    .innerText()
    .catch(() => "");
  const due = await withDb((db) =>
    one(
      db,
      "select count(distinct t.client_id)::int n from timers t join app_users u on u.id = t.user_id where u.email = $1 and t.done_at is null and t.due_on <= (now() at time zone 'America/New_York')::date",
      [email],
    ),
  );
  check(
    "Today tab badge equals clients due or overdue",
    Number(badge) === due.n,
    `badge ${badge} vs db ${due.n}`,
  );
  check(
    "browser tab title carries the count",
    (await page.title()).startsWith(`(${due.n})`),
    await page.title(),
  );

  await browser.close();

  // Mobile: nothing scrolls sideways.
  const m = await openBrowser(
    email,
    { width: 390, height: 800 },
    { hasTouch: true, isMobile: true },
  );
  for (const path of ["/", "/clients", "/follow-up", "/settings", "/import"]) {
    await m.page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    const overflow = await m.page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check(`mobile ${path} has no horizontal overflow`, overflow <= 1, `${overflow}px`);
  }
  await m.browser.close();
}
