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

  // New lead. The quick "+ Add client" dialog is gone: adding a merchant is the New lead sheet, which takes no
  // follow-up date. A new lead is a call to make today.
  const sheet = page.getByRole("dialog", { name: "Bring a merchant in" });
  await page
    .locator("aside")
    .getByRole("button", { name: /^New lead/ })
    .click();
  await sheet.getByLabel("Phone", { exact: true }).fill("(305) 555-0999");
  await sheet.getByLabel("First name").fill("Pat");
  await sheet.getByLabel("Last name").fill("Baker");
  await sheet.getByLabel("Business", { exact: true }).fill("E2E Test Bakery");
  await sheet.getByLabel("Amount they want").fill("45k");
  await sheet.getByRole("button", { name: /^(Submit to|Add lead)/ }).click();
  await sheet.getByText("E2E Test Bakery is in").waitFor({ timeout: 12000 });
  const row = await withDb((db) =>
    one(
      db,
      "select c.stage, c.contact_name, c.wanted_amount_cents::int w, (c.next_due_on - (now() at time zone 'America/New_York')::date)::int d from client_cards c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = 'E2E Test Bakery'",
      [email],
    ),
  );
  check(
    "New lead stores the stage, the name, the ask and a call-today timer",
    row?.stage === "name_in" &&
      row?.contact_name === "Pat Baker" &&
      row?.w === 4_500_000 &&
      row?.d === 0,
    JSON.stringify(row),
  );

  // Adding someone who is already in the CRM warns as soon as the number is typed, and never makes a second card.
  await sheet.getByRole("button", { name: "Add another" }).click();
  await sheet.getByLabel("Phone", { exact: true }).fill("305-555-0999");
  await sheet.getByLabel("Business", { exact: true }).fill("Totally Different Name");
  const warning = sheet.getByRole("status").filter({ hasText: "already in the CRM" });
  await warning.waitFor({ timeout: 8000 });
  check(
    "duplicate phone is flagged by name",
    (await warning.innerText()).includes("E2E Test Bakery"),
    await warning.innerText(),
  );
  const dupeCount = () =>
    withDb((db) =>
      one(
        db,
        "select count(*) filter (where c.business_name = 'Totally Different Name')::int n, count(*) filter (where right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = '3055550999')::int same_phone from clients c join app_users u on u.id = c.user_id where u.email = $1",
        [email],
      ),
    );
  check("nothing was created while the warning is up", (await dupeCount()).n === 0);
  // The old dialog had "Add as a new client anyway". The sheet has no such button for your own merchant: submitting
  // points at the one already there.
  await sheet.getByRole("button", { name: /^(Submit to|Add lead)/ }).click();
  await sheet.getByText("E2E Test Bakery was already here").waitFor({ timeout: 12000 });
  const afterDupe = await dupeCount();
  check(
    "submitting the duplicate makes no second merchant (database)",
    afterDupe.n === 0 && afterDupe.same_phone === 1,
    JSON.stringify(afterDupe),
  );
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden", timeout: 5000 });

  // Clients search by phone digits.
  await page.goto(`${BASE}/clients`, { waitUntil: "networkidle" });
  await page.getByLabel("Search merchants").fill("0999");
  const found = await page
    .getByRole("table", { name: "Merchants" })
    .getByRole("row")
    .filter({ has: page.getByRole("cell") })
    .allInnerTexts();
  check(
    "clients search finds merchants by phone digits",
    found.length === 1 && found[0].includes("E2E Test Bakery"),
    `${found.length} rows`,
  );

  // Settings persist.
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  const reminders = page.locator("section", { has: page.getByLabel("Send at") });
  await reminders.getByLabel("Send at").selectOption("7");
  await reminders.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Settings saved").waitFor({ timeout: 8000 });
  const hour = await withDb((db) =>
    one(db, "select digest_hour from app_users where email = $1", [email]),
  );
  check("settings persist", hour?.digest_hour === 7);

  // The sidebar shows how many follow-ups are due, on Overview and on Call list.
  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  const nav = page.locator("aside").getByRole("navigation", { name: "Main" });
  const countOn = async (name) =>
    Number((await nav.getByRole("link", { name }).innerText()).match(/(\d+)\s*$/)?.[1] ?? 0);
  const badge = { callList: await countOn(/^Call list/), overview: await countOn(/^Overview/) };
  const due = await withDb((db) =>
    one(
      db,
      "select count(distinct t.client_id)::int n from timers t join app_users u on u.id = t.user_id where u.email = $1 and t.done_at is null and t.due_on <= (now() at time zone 'America/New_York')::date",
      [email],
    ),
  );
  check(
    "the sidebar's Call list and Overview counts equal clients due or overdue",
    badge.callList === due.n && badge.overview === due.n,
    `${JSON.stringify(badge)} vs db ${due.n}`,
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
