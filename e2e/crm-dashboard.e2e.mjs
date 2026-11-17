// Overview (/): this month's New leads and Brought in, the "Right now" overdue figure, the Do this now list and the
// Team table, each read against the database with the definitions in src/lib/followup/overview.ts.
// Run: pnpm e2e crm-dashboard
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);
const q1 = (sql, params) => withDb((db) => one(db, sql, params));

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// The user's calendar month and day, the way the page works them out (app_users.timezone).
const TODAY = "(now() at time zone (select timezone from app_users where id = $1))::date";
const LIVE = "not exists (select 1 from trashed_clients t where t.client_id = c.id)";

/** What the Overview should show a rep, straight from the database: their own book only. */
const expected = (userId) =>
  q1(
    `select
       (select count(*)::int from clients c where c.user_id = $1 and ${LIVE}
          and to_char(c.created_at, 'YYYY-MM') = to_char(${TODAY}, 'YYYY-MM')) as new_leads,
       (select count(*)::int from clients c where c.user_id = $1 and ${LIVE}
          and to_char(c.brought_in_at, 'YYYY-MM') = to_char(${TODAY}, 'YYYY-MM')) as brought_in,
       (select count(*)::int from timers t join clients c on c.id = t.client_id
         where c.user_id = $1 and ${LIVE} and t.done_at is null and t.due_on < ${TODAY}) as overdue`,
    [userId],
  );

/** The big number on a hero card ("Brought in", "New leads"), once its count-up has settled. */
const heroValue = (page, label) =>
  page
    .locator("main p.eyebrow", { hasText: new RegExp(`^${label}$`) })
    .first()
    .locator("xpath=../following-sibling::div[1]/p[1]")
    .innerText()
    .then((t) => Number(t.replace(/[^\d]/g, "")));

const heroIs = (page, label, want) => until(async () => (await heroValue(page, label)) === want);

export default async function overviewFlow({ email }) {
  // Every seeded user is called Isaac; a name of its own lets the Team table's row for this rep be found.
  const me = await q1("update app_users set name = $2 where email = $1 returning id, name", [
    email,
    `Rep ${Date.now()}`,
  ]);
  // A merchant with a follow-up past due (one already called, so the Do this now line is the overdue one when
  // nothing more urgent is waiting), and a different one to hand off.
  const late = await q1(
    `select c.id, c.business_name from clients c
       join timers t on t.client_id = c.id and t.done_at is null and t.due_on < ${TODAY}
      where c.user_id = $1 and c.brought_in_at is null and ${LIVE}
      order by exists (select 1 from activities a where a.client_id = c.id and a.kind = 'call') desc, t.due_on
      limit 1`,
    [me.id],
  );
  const handMe = await q1(
    `select c.id, c.business_name from clients c
      where c.user_id = $1 and c.brought_in_at is null and ${LIVE} and c.id <> $2
      order by c.business_name limit 1`,
    [me.id, late?.id ?? "00000000-0000-0000-0000-000000000000"],
  );
  check(
    "setup: the seeded rep has an overdue merchant and one to hand off",
    !!late && !!handMe,
    JSON.stringify({ late, handMe }),
  );

  // The seeded user is a rep: their Overview is their own book, so every figure can be compared exactly.
  const { browser, page } = await openBrowser(email);
  const nav = page.locator("aside").getByRole("navigation", { name: "Main" });

  // ---- Brought in: hand one merchant off on its page (the real flow), then read the figure back
  await page.goto(`${BASE}/clients/${handMe.id}`, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: /^Hand off/ })
    .first()
    .click();
  await page
    .getByRole("dialog", { name: `Hand off ${handMe.business_name}?` })
    .getByRole("button", { name: "Hand off", exact: true })
    .click();
  check(
    "setup: Hand off on the merchant page reaches the database",
    await until(
      async () =>
        (await q1("select brought_in_at from clients where id = $1", [handMe.id]))?.brought_in_at !=
        null,
      10000,
    ),
  );

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check(
    "the Overview is the sidebar's current page and greets the rep",
    (await nav.getByRole("link", { name: /^Overview/ }).getAttribute("aria-current")) === "page" &&
      /^(Good morning|Good afternoon|Good evening|Working late)/.test(
        await page.locator("main h1").first().innerText(),
      ),
  );
  check(
    "the sidebar has Follow Up, Merchants and Settings",
    (await nav.getByRole("button", { name: /^Follow Up/ }).isVisible()) &&
      (await nav.getByRole("button", { name: /^Merchants/ }).isVisible()) &&
      (await nav.getByRole("button", { name: /^Settings/ }).isVisible()),
  );
  check(
    "the month figures show Brought in, New leads, Replied and Docs in",
    (await page
      .locator("main p.eyebrow", { hasText: /^Brought in$/ })
      .first()
      .isVisible()) &&
      (await page
        .locator("main p.eyebrow", { hasText: /^New leads$/ })
        .first()
        .isVisible()) &&
      (await page
        .locator("main p.eyebrow", { hasText: /^Replied$/ })
        .first()
        .isVisible()) &&
      (await page
        .locator("main p.eyebrow", { hasText: /^Docs in$/ })
        .first()
        .isVisible()),
  );

  const want = await expected(me.id);
  check(
    "New leads equals this rep's merchants added this month (database)",
    want.new_leads > 0 && (await heroIs(page, "New leads", want.new_leads)),
    `db ${JSON.stringify(want)}, screen ${await heroValue(page, "New leads").catch(() => "?")}`,
  );
  check(
    "Brought in equals this rep's merchants handed off this month, the one just handed off included (database)",
    want.brought_in > 0 && (await heroIs(page, "Brought in", want.brought_in)),
    `db ${want.brought_in}, screen ${await heroValue(page, "Brought in").catch(() => "?")}`,
  );

  // ---- Right now: Follow-ups overdue
  const rightNow = page.getByRole("region", { name: "Right now" });
  const overdueLink = rightNow.getByRole("link", { name: /Follow-ups overdue/ });
  const overdueOnScreen = Number(
    /Follow-ups overdue\s+(\d+)/.exec(await overdueLink.innerText())?.[1] ?? NaN,
  );
  check(
    "Right now: Follow-ups overdue equals the open timers past due in the database",
    want.overdue > 0 && overdueOnScreen === want.overdue,
    `db ${want.overdue}, screen ${overdueOnScreen}`,
  );

  // ---- Do this now
  const queue = page.locator("section", {
    has: page.getByRole("heading", { name: "Do this now", exact: true }),
  });
  check("Do this now is on the Overview", await queue.isVisible());
  check(
    "Do this now lists the merchant the database says is overdue",
    (await queue.locator(`a[href="/clients/${late.id}"]`).count()) === 1 &&
      (await queue.locator(`a[href="/clients/${late.id}"]`).innerText()).includes(
        late.business_name,
      ),
    late.business_name,
  );
  check(
    "the merchant just handed off is no longer in Do this now",
    (await queue.locator(`a[href="/clients/${handMe.id}"]`).count()) === 0,
  );

  check(
    "a rep does not see the Team table",
    (await page.getByRole("heading", { name: "Team", exact: true }).count()) === 0,
  );
  const body = await page.locator("main").innerText();
  check(
    "nothing about the removed money, lender or funnel blocks is left on the Overview",
    !/funnel|money on the table|lender|commission|funded|goal/i.test(body),
  );

  // the overdue figure opens the call list
  await overdueLink.click();
  await page.waitForURL(/\/today/, { timeout: 10000 }).catch(() => {});
  check(
    "Follow-ups overdue opens the call list",
    new URL(page.url()).pathname === "/today",
    page.url(),
  );

  // ---- a manager sees the Team table, with this rep's row matching the database (the role is read at sign-in)
  await setRole(email, "manager");
  await page.goto(`${BASE}/api/dev-login?email=${encodeURIComponent(email)}`);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const team = page.locator("section", {
    has: page.getByRole("heading", { name: "Team", exact: true }),
  });
  check("a manager sees the Team table", await team.isVisible());
  const row = team.locator("tbody tr", { hasText: me.name });
  const cells = (await row.first().locator("td").allInnerTexts()).map((t) => t.trim());
  const now = await expected(me.id);
  check(
    "the Team row for this rep shows their leads, brought in and overdue from the database",
    (await row.count()) === 1 &&
      Number(cells[1]) === now.new_leads &&
      Number(cells[4]) === now.brought_in &&
      Number(cells[5]) === now.overdue,
    `db ${JSON.stringify(now)}, screen ${JSON.stringify(cells)}`,
  );
  await browser.close();
}
