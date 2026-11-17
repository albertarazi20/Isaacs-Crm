// Power dial, bulk reschedule, snooze guard, biggest-first ranking, global search and the phone's top bar and menu.
//   CHROMIUM_PATH=... DATABASE_URL=... pnpm e2e power
// Every check asserts on DATABASE ROWS (or on what the page really shows), never on "it returned 200".
import { mkdirSync } from "node:fs";
import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const SHOTS =
  process.env.SHOTS_DIR ??
  "/tmp/claude-0/-home-user-Isaac/17874b0e-83c6-5f06-8a6a-1bf11b991d45/scratchpad/power";
mkdirSync(SHOTS, { recursive: true });

const APPLICATION_IN = [
  "application_in",
  "stips",
  "submitted",
  "offers_in",
  "offer_presented",
  "contract_out",
];
const NY_TODAY = "(now() at time zone 'America/New_York')::date";

const rows = (sql, params = []) => withDb((db) => db.query(sql, params).then((r) => r.rows));
const one = async (sql, params) => (await rows(sql, params))[0];

const isBiz = (s) => {
  const dow = new Date(`${s}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
};
const addDays = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const slots = (today, days) => {
  let cur = today;
  while (!isBiz(cur)) cur = addDays(cur, 1);
  const out = [cur];
  while (out.length < days) {
    cur = addDays(cur, 1);
    if (isBiz(cur)) out.push(cur);
  }
  return out;
};

const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Poll until `fn` is truthy (a page re-render after a server action is not instant). */
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export default async function powerFlow({ email }) {
  const { browser, context, page } = await openBrowser(email);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const today = (await one(`select ${NY_TODAY}::text as d`)).d;
  const client = (name) =>
    one(
      "select c.id, c.business_name, c.stage from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = $2",
      [email, name],
    );
  const openTimers = (id) =>
    rows(
      "select kind, due_on::text as due, note from timers where client_id = $1 and done_at is null order by due_on, kind",
      [id],
    );
  const overdueSet = () =>
    rows(
      `select c.id, c.business_name, c.stage, c.contact_status, c.next_due_kind as kind
         from client_cards c join app_users u on u.id = c.user_id
        where u.email = $1 and c.next_due_on < ${NY_TODAY}`,
      [email],
    );
  const section = (name) =>
    page.locator("section", { has: page.getByRole("heading", { name: new RegExp(`^${name}`) }) });

  // ---------------------------------------------------------------------------------------------
  // 1. Biggest-first ranking on Today
  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  const articles = await page.locator("main article >> visible=true").count();
  const stakes = await page
    .locator('main article button[aria-expanded][title*="priority"] >> visible=true')
    .count();
  check(
    "every Today row shows its $ at stake",
    articles > 0 && stakes === articles,
    `${stakes}/${articles}`,
  );

  const scoreOf = (title) =>
    Number((/priority ([\d,]+)\./.exec(title ?? "") ?? [])[1]?.replace(/,/g, ""));
  const overdueScores = async () =>
    (
      await section("Overdue")
        .locator('article button[aria-expanded][title*="at stake"] >> visible=true')
        .evaluateAll((els) => els.map((e) => e.title))
    ).map(scoreOf);
  const overdueAges = async () =>
    await section("Overdue")
      .locator("article")
      .evaluateAll((els) =>
        els.map((e) => Number(/(\d+) days? overdue/.exec(e.textContent ?? "")?.[1] ?? 0)),
      );
  const nonIncreasing = (xs) => xs.every((x, i) => i === 0 || (xs[i - 1] ?? 0) >= x);

  const biggest = await overdueScores();
  check(
    "'Biggest first' orders Overdue by the score shown on each row",
    biggest.length > 2 && nonIncreasing(biggest),
    biggest.join(" > "),
  );
  const firstBiggest = (
    await section("Overdue").locator('article a[href^="/clients/"]').first().innerText()
  ).trim();
  await shot(page, "today-light");

  await page.getByRole("button", { name: "Oldest first" }).click();
  await page
    .getByRole("button", { name: "Oldest first" })
    .and(page.locator('[aria-pressed="true"]'))
    .waitFor();
  const ages = await overdueAges();
  check("'Oldest first' orders Overdue by days overdue", nonIncreasing(ages), ages.join(" >= "));
  check(
    "the choice is remembered in localStorage",
    (await page.evaluate(() => localStorage.getItem("isaac:today-sort"))) === "oldest",
  );
  await page.reload({ waitUntil: "networkidle" });
  check(
    "…and survives a reload",
    (await page.getByRole("button", { name: "Oldest first" }).getAttribute("aria-pressed")) ===
      "true" && nonIncreasing(await overdueAges()),
  );
  await page.getByRole("button", { name: "Biggest first" }).click();
  check(
    "switching back restores the biggest-first order",
    await until(
      async () =>
        (
          await section("Overdue").locator('article a[href^="/clients/"]').first().innerText()
        ).trim() === firstBiggest,
    ),
  );

  // The star: a small client pinned to the top, remembered, and removable.
  const firstOverdue = () =>
    section("Overdue")
      .locator('article a[href^="/clients/"]')
      .first()
      .innerText()
      .then((t) => t.trim());
  const last = section("Overdue").locator("article").last();
  const lastName = (await last.locator('a[href^="/clients/"]').first().innerText()).trim();
  await last.getByRole("button", { name: new RegExp(`^Star ${esc(lastName)}$`) }).click();
  await until(async () => (await firstOverdue()) === lastName);
  const starredInDb = () =>
    withDb((db) =>
      db
        .query(
          "select c.hot from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = $2",
          [email, lastName],
        )
        .then((r) => r.rows[0]?.hot),
    );
  check(
    "a starred client jumps to the top of its section and the star is stored on the merchant",
    !!(await until(async () => (await starredInDb()) === true)),
  );
  await page.reload({ waitUntil: "networkidle" });
  check("the star survives a reload", (await firstOverdue()) === lastName);
  // another device: a fresh browser with nothing saved sees the same star, first
  const other = await openBrowser(email);
  await other.page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  const otherFirst = await other.page
    .locator("section", { has: other.page.getByRole("heading", { name: /^Overdue/ }) })
    .locator('article a[href^="/clients/"]')
    .first()
    .innerText()
    .then((t) => t.trim());
  check(
    "a second browser with nothing saved shows the star first",
    otherFirst === lastName,
    otherFirst,
  );
  await other.browser.close();
  await section("Overdue")
    .locator("article")
    .first()
    .getByRole("button", { name: /^Unstar/ })
    .click();
  check(
    "unstarring puts it back where the score says",
    await until(async () => (await firstOverdue()) !== lastName),
  );
  check(
    "…and clears the star on the merchant",
    !!(await until(async () => (await starredInDb()) === false)),
  );

  // The explanation is on the page, not only in a tooltip.
  const stakeBtn = section("Overdue")
    .locator('article button[aria-expanded][title*="at stake"] >> visible=true')
    .first();
  const stakeArticle = stakeBtn.locator("xpath=ancestor::article[1]");
  // the note renders on the next paint; under load that took longer than 4s once, so poll for the words themselves.
  // A refresh that lands just after the tap re-renders the list and closes the note, so tap again if it is closed.
  // plain words, never the working ("counts x 0.6", "priority 150,000")
  const STAKE_WORDS = /at stake \(what they want\)\. .+, \d+ days? overdue\./;
  let stakeText = "";
  for (let attempt = 0; attempt < 4 && !STAKE_WORDS.test(stakeText); attempt++) {
    if ((await stakeBtn.getAttribute("aria-expanded")) !== "true") await stakeBtn.click();
    for (let i = 0; i < 8 && !STAKE_WORDS.test(stakeText); i++) {
      await page.waitForTimeout(300);
      stakeText = await stakeArticle.innerText();
    }
  }
  check(
    "tapping '$ at stake' explains the score in words",
    STAKE_WORDS.test(stakeText),
    JSON.stringify(stakeText.slice(0, 400)),
  );

  // Without localStorage the page still works and the toggle still flips for the session.
  {
    const blocked = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await blocked.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("storage blocked");
        },
      });
    });
    const p = await blocked.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(`${BASE}/api/dev-login?email=${encodeURIComponent(email)}`);
    await p.goto(`${BASE}/today`, { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Oldest first" }).click();
    check(
      "works with storage blocked: no errors, toggle still flips",
      errors.length === 0 &&
        (await p.getByRole("button", { name: "Oldest first" }).getAttribute("aria-pressed")) ===
          "true",
      errors.join("; "),
    );
    await blocked.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Snooze guard
  const uw = await one(
    `select c.id, c.business_name, c.stage from client_cards c join app_users u on u.id = c.user_id
      where u.email = $1 and c.stage = any($2::text[]) and c.next_due_on <= ${NY_TODAY} and c.next_due_kind = 'follow_up'
        and c.contact_status = 'ok' order by c.business_name limit 1`,
    [email, APPLICATION_IN],
  );
  const uw2 = await one(
    `select c.id, c.business_name from client_cards c join app_users u on u.id = c.user_id
      where u.email = $1 and c.stage = any($2::text[]) and c.next_due_on <= ${NY_TODAY} and c.next_due_kind = 'follow_up'
        and c.contact_status = 'ok' and c.id <> $3 order by c.business_name limit 1`,
    [email, APPLICATION_IN, uw.id],
  );
  const early = await one(
    `select c.id, c.business_name from client_cards c join app_users u on u.id = c.user_id
      where u.email = $1 and c.stage in ('name_in','spoke_with_owner','interested') and c.next_due_on <= ${NY_TODAY}
        and c.next_due_kind = 'follow_up' and c.contact_status = 'ok' order by c.business_name limit 1`,
    [email],
  );
  const rowOf = (name) =>
    page.locator("main article").filter({ has: page.getByRole("link", { name, exact: true }) });

  // snoozed N× badge, from the timeline
  await withDb((db) =>
    db.query(
      `insert into activities (user_id, client_id, kind, body)
       select c.user_id, c.id, 'timer', 'Follow up set for ' || g from clients c, unnest(array['Oct 1, 2026','Oct 8, 2026','Oct 15, 2026']) g where c.id = $1`,
      [uw.id],
    ),
  );
  await page.reload({ waitUntil: "networkidle" });
  check(
    "a client pushed three times shows 'snoozed 3×'",
    (await rowOf(uw.business_name).getByText("snoozed 3×").count()) === 1,
  );
  check(
    "…and one that was not pushed shows no badge",
    (await rowOf(early.business_name)
      .getByText(/snoozed \d×/)
      .count()) === 0,
  );

  const uwRow = rowOf(uw.business_name);
  await uwRow.locator("summary", { hasText: "Snooze" }).click();
  await uwRow.getByRole("button", { name: "1 month" }).click();
  const form = page.getByRole("form", { name: "Why snooze this merchant" });
  await form.waitFor({ timeout: 5000 });
  await shot(page, "snooze-guard-light");
  const beforeGuard = await openTimers(uw.id);
  check(
    "snoozing a merchant whose application is in, a month, asks WHY and has not moved anything yet",
    (await form.innerText()).includes("has the application in") &&
      beforeGuard.every((t) => t.due <= today),
    JSON.stringify(beforeGuard),
  );
  await form.getByRole("button", { name: "Back" }).click();
  check(
    "'Back' returns to the presets without snoozing",
    (await uwRow.getByRole("button", { name: "1 month" }).count()) === 1,
  );
  await uwRow.getByRole("button", { name: "1 month" }).click();
  await page.getByLabel("Reason for snoozing (one line)").fill("Waiting on his Q3 tax returns");
  await page.getByRole("button", { name: /^Snooze until/ }).click();
  await page
    .getByText(new RegExp(`${esc(uw.business_name)} — snoozed until`))
    .waitFor({ timeout: 8000 });
  const afterGuard = await openTimers(uw.id);
  const note = await one(
    "select body from activities where client_id = $1 and kind = 'note' order by occurred_at desc limit 1",
    [uw.id],
  );
  const monthOut = await one(`select (${NY_TODAY} + interval '1 month')::date::text as d`);
  check(
    "the date moved a month in the database",
    afterGuard.length === 1 &&
      afterGuard[0].kind === "follow_up" &&
      afterGuard[0].due === monthOut.d,
    JSON.stringify(afterGuard),
  );
  check(
    "…and the reason is on the timeline as a note",
    /^Snoozed until .+: Waiting on his Q3 tax returns$/.test(note?.body ?? ""),
    note?.body,
  );

  await page.waitForTimeout(400);
  await rowOf(uw2.business_name).locator("summary", { hasText: "Snooze" }).click();
  await rowOf(uw2.business_name).getByRole("button", { name: "1 week" }).click();
  await page
    .getByText(new RegExp(`${esc(uw2.business_name)} — snoozed until`))
    .waitFor({ timeout: 8000 });
  check(
    "a week or less on a merchant whose application is in does not ask",
    (await page.getByRole("form", { name: "Why snooze this merchant" }).count()) === 0 &&
      (await openTimers(uw2.id))[0]?.due === addDays(today, 7),
  );
  await page.waitForTimeout(400);
  await rowOf(early.business_name).locator("summary", { hasText: "Snooze" }).click();
  await rowOf(early.business_name).getByRole("button", { name: "1 month" }).click();
  await page
    .getByText(new RegExp(`${esc(early.business_name)} — snoozed until`))
    .waitFor({ timeout: 8000 });
  check(
    "an early-stage client is never asked, whatever the length",
    (await page.getByRole("form", { name: "Why snooze this merchant" }).count()) === 0 &&
      (await openTimers(early.id))[0]?.due === monthOut.d,
  );

  // ---------------------------------------------------------------------------------------------
  // 3. Bulk reschedule overdue
  await page.reload({ waitUntil: "networkidle" });
  const overdueBefore = await overdueSet();
  const movable = overdueBefore.filter((r) => r.contact_status !== "dnc" && r.kind === "follow_up");
  const keptUw = movable.filter((r) => APPLICATION_IN.includes(r.stage));
  const moving = movable.filter((r) => !APPLICATION_IN.includes(r.stage));
  const uiOrder = await section("Overdue")
    .locator('article a[href^="/clients/"]')
    .evaluateAll((els) => els.map((e) => e.textContent?.trim()));
  const firstMover = uiOrder.find((n) => moving.some((m) => m.business_name === n));

  await page.getByRole("button", { name: "Reschedule all", exact: true }).click();
  const dlg = page.getByRole("dialog");
  await dlg.waitFor();
  const summary = async () => {
    // the line is set in small caps, and innerText reads it as drawn
    const t = await dlg.locator("[aria-live=polite]").innerText();
    return Number(/(\d+) clients?, biggest asks first/i.exec(t)?.[1] ?? 0);
  };
  check(
    "preview says how many will move (application-in merchants kept by default)",
    (await summary()) === moving.length,
    `${await summary()} vs ${moving.length}`,
  );
  await dlg.getByRole("button", { name: "10 business days" }).click();
  await dlg.getByRole("button", { name: "5 business days" }).click();
  const perDay = await dlg
    .locator('ul[aria-label="How many land on each day"] li span:last-child')
    .allInnerTexts();
  const counts = perDay.map(Number);
  check(
    "preview lists each day and the counts add up, evenly (±1)",
    counts.reduce((a, b) => a + b, 0) === moving.length &&
      Math.max(...counts) - Math.min(...counts) <= 1,
    counts.join(","),
  );
  await shot(page, "bulk-dialog-light");
  await dlg.getByRole("checkbox").uncheck();
  check(
    "switching 'keep application-in' off adds those merchants to the move",
    (await summary()) === moving.length + keptUw.length,
    `${await summary()} vs ${moving.length + keptUw.length}`,
  );
  await dlg.getByRole("checkbox").check();
  await dlg
    .getByRole("button", { name: new RegExp(`^Reschedule ${moving.length} client`) })
    .click();
  await page.getByText(/^Rescheduled \d+ clients?/).waitFor({ timeout: 10000 });

  const slotDays = slots(today, 5);
  const movedRows = await rows(
    `select c.business_name, c.stage, t.due_on::text as due,
            (select count(*)::int from activities a where a.client_id = c.id and a.body like '%Rescheduled in bulk') as logged
       from clients c join app_users u on u.id = c.user_id
       join timers t on t.client_id = c.id and t.done_at is null and t.kind = 'follow_up'
      where u.email = $1 and c.id = any($2::uuid[])`,
    [email, moving.map((m) => m.id)],
  );
  check(
    "every moved client has ONE new follow-up on one of the next 5 business days and a timeline entry",
    movedRows.length === moving.length &&
      movedRows.every((r) => slotDays.includes(r.due) && r.logged === 1),
    `${movedRows.length}/${moving.length}`,
  );
  const dist = slotDays.map((d) => movedRows.filter((r) => r.due === d).length);
  check(
    "they are spread evenly over those days",
    Math.max(...dist) - Math.min(...dist) <= 1 && dist.reduce((a, b) => a + b, 0) === moving.length,
    dist.join(","),
  );
  const top = movedRows.find((r) => r.business_name === firstMover);
  check(
    "the biggest ask on the page landed on the first day",
    top?.due === slotDays[0],
    `${firstMover}: ${top?.due} (first day ${slotDays[0]})`,
  );
  const stillOverdue = await overdueSet();
  check(
    "application-in merchants and anything else needing a hand are still overdue",
    stillOverdue.length === overdueBefore.length - moving.length &&
      keptUw.every((k) => stillOverdue.some((s) => s.id === k.id)),
    `${stillOverdue.length} left`,
  );
  const stray = await one(
    `select count(*)::int as n from activities a join clients c on c.id = a.client_id join app_users u on u.id = c.user_id
      where u.email = $1 and a.body like '%Rescheduled in bulk' and c.id <> all($2::uuid[])`,
    [email, moving.map((m) => m.id)],
  );
  check("no client outside the plan was touched", stray.n === 0, `${stray.n}`);
  await page.waitForTimeout(500);
  await shot(page, "today-after-bulk-light");

  // ---------------------------------------------------------------------------------------------
  // 4. Global search + inbound-call lookup
  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "Find a client" });
  await palette.waitFor({ timeout: 5000 });
  const box = palette.getByRole("combobox");
  check(
    "Ctrl+K opens the palette with focus in the search box",
    await box.evaluate((e) => e === document.activeElement),
  );
  await box.fill("305555");
  await palette.getByRole("option").first().waitFor({ timeout: 8000 }); // the list loads on first open
  const dbPhone = (
    await rows(
      `select c.business_name from clients c join app_users u on u.id = c.user_id
        where u.email = $1 and regexp_replace(c.phone, '[^0-9]', '', 'g') like '%305555%'`,
      [email],
    )
  ).sort((x, y) => x.business_name.localeCompare(y.business_name));
  const opts = await palette.getByRole("option").allInnerTexts();
  check(
    "typing 305555 finds the merchants whose number contains it",
    opts.length === Math.min(8, dbPhone.length) &&
      dbPhone.slice(0, 8).every((r, i) => opts[i]?.includes(r.business_name)),
    `${opts.length} vs ${dbPhone.length}`,
  );
  await box.press("ArrowDown");
  const active = await box.getAttribute("aria-activedescendant");
  check(
    "arrow keys move aria-activedescendant to an option",
    Boolean(active) &&
      (await page.locator(`#${active}`).getAttribute("aria-selected")) === "true" &&
      active === (await palette.getByRole("option").nth(1).getAttribute("id")),
  );
  await shot(page, "palette-digits-light");

  const rivera = await one(
    "select c.id, c.phone, c.contact_name from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = 'Rivera Auto Repair'",
    [email],
  );
  await box.fill(rivera.phone);
  const first = palette.getByRole("option").first();
  const firstText = await first.innerText();
  check(
    "a full phone number shows 'Calling you: …' first, with stage, last call and what he wants",
    firstText.startsWith(
      `Calling you: ${rivera.contact_name} — Rivera Auto Repair · Interested · last call `,
    ) && firstText.includes("wants $60k"),
    firstText,
  );
  await shot(page, "palette-calling-light");
  await box.press("Enter");
  await page.waitForURL(`**/clients/${rivera.id}`, { timeout: 8000 });
  check("Enter opens the client page", true);

  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  await page.locator("aside").getByRole("button", { name: "Find a client" }).click();
  await palette.waitFor();
  await palette.getByRole("combobox").fill("hartman");
  await palette.getByRole("option").first().waitFor({ timeout: 8000 });
  check(
    "the sidebar's search button opens it too and finds by name",
    (await palette.getByRole("option").count()) >= 1 &&
      (await palette.getByRole("option").first().innerText()).includes("Hartman"),
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.querySelector("dialog[aria-label='Find a client'][open]"),
  );
  check("Escape closes it", true);

  // ---------------------------------------------------------------------------------------------
  // 5. Power dial: exactly three clients due, so we can walk the whole queue
  const three = await rows(
    `select c.id, c.business_name from client_cards c join app_users u on u.id = c.user_id
      where u.email = $1 and c.contact_status = 'ok' and c.next_due_on <= ${NY_TODAY}
        and c.next_due_kind = 'follow_up' and c.phone <> '' order by c.business_name limit 3`,
    [email],
  );
  await withDb((db) =>
    db.query(
      `update timers t set due_on = (${NY_TODAY}) + 20 from clients c, app_users u
        where t.client_id = c.id and u.id = c.user_id and u.email = $1 and t.done_at is null
          and t.due_on <= ${NY_TODAY} and c.id <> all($2::uuid[])`,
      [email, three.map((r) => r.id)],
    ),
  );
  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: /^Start power dial\s*3$/ }).click();
  await page.waitForURL("**/dial");
  const region = page.getByRole("region", { name: "Power dial" });
  const progress = () => region.locator("p[aria-live=polite]").innerText();
  const title = () => region.getByRole("heading", { level: 1 }).innerText();
  await region.getByRole("heading", { level: 1 }).waitFor();
  check(
    "'Start power dial' (3) opens the dial with the first of three",
    (await progress()) === "1 of 3",
    await progress(),
  );
  const a = await title();
  check(
    "the card shows the phone, what they want and the last call",
    // the labels are set in small caps, so they are matched as written, not as drawn
    (await region.locator("dt", { hasText: /^Wants$/ }).isVisible()) &&
      (await region.locator("dt", { hasText: /^Last call$/ }).isVisible()),
  );
  await shot(page, "dial-light");

  await page.keyboard.press("?");
  check(
    "? shows the shortcut list",
    (await region.getByRole("note").count()) === 1 &&
      (await region.getByRole("note").innerText()).includes("Skip"),
  );
  await shot(page, "dial-help-light");
  await page.keyboard.press("?");
  check("? again hides it", (await region.getByRole("note").count()) === 0);

  // Search still works over the full-screen dial, and Tab stays inside it (the app header is inert).
  await page.keyboard.press("Control+K");
  const dialPalette = page.getByRole("dialog", { name: "Find a client" });
  await dialPalette.waitFor({ timeout: 5000 });
  await dialPalette.getByRole("combobox").fill("hartman");
  await dialPalette.getByRole("option").first().waitFor({ timeout: 8000 });
  check(
    "Ctrl+K search works over the full-screen dial",
    (await dialPalette.getByRole("option").first().innerText()).includes("Hartman"),
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  await page.evaluate(
    () => document.activeElement instanceof HTMLElement && document.activeElement.blur(),
  );
  await page.keyboard.press("Tab");
  check(
    "Tab goes into the dial, not the hidden app header behind it",
    await page.evaluate(() =>
      Boolean(document.activeElement?.closest('[aria-label="Power dial"]')),
    ),
  );

  await page.keyboard.press("s");
  const b = await title();
  check("S skips: a different client is up", b !== a, `${a} -> ${b}`);
  await page.keyboard.press("p");
  check(
    "…and the skipped one went to the END of the line (Previous wraps to it), and the header says so: 3 of 3",
    (await title()) === a && (await progress()) === "3 of 3",
    await progress(),
  );
  await page.keyboard.press("n");
  check(
    "N moves on without reordering, and the header follows: 1 of 3",
    (await title()) === b && (await progress()) === "1 of 3",
    await progress(),
  );

  // Card B: click Call, Reached.
  const [popup] = await Promise.all([
    context.waitForEvent("page", { timeout: 5000 }).catch(() => null),
    region.getByRole("button", { name: /^Call / }).click(),
  ]);
  if (popup) await popup.close();
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  check(
    "Call opens the one-tap outcome prompt for that client",
    (await page.getByRole("dialog").innerText()).includes(`call with ${b}`),
  );
  await page.getByRole("button", { name: "Reached" }).click();
  await page.getByRole("button", { name: "Log it" }).click();
  await page.getByText(/Logged — next follow-up/).waitFor({ timeout: 8000 });
  await page.waitForFunction(
    (prev) => document.querySelector('[aria-label="Power dial"] h1')?.textContent !== prev,
    b,
  );
  const bRow = await client(b);
  const bAct = await one(
    "select kind, outcome from activities where client_id = $1 and kind = 'call' order by occurred_at desc limit 1",
    [bRow.id],
  );
  const bDue = (await openTimers(bRow.id)).find((t) => t.kind === "follow_up");
  check(
    "logging 'Reached' writes the call and moves his follow-up into the future",
    bAct?.outcome === "reached" && Boolean(bDue) && bDue.due > today,
    JSON.stringify({ bAct, bDue }),
  );
  const c = await title();
  check(
    "the next card appeared by itself, and the logged client left the queue",
    c !== b && c !== a && (await region.getByText(b, { exact: true }).count()) === 0,
    `${b} -> ${c}`,
  );
  check("progress moved on: 2 of 3", (await progress()) === "2 of 3", await progress());

  // Card C: keyboard Call, No answer.
  const cName = c;
  const [popup2] = await Promise.all([
    context.waitForEvent("page", { timeout: 5000 }).catch(() => null),
    page.keyboard.press("c"),
  ]);
  if (popup2) await popup2.close();
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  check(
    "C starts the call with the keyboard",
    (await page.getByRole("dialog").innerText()).includes(`call with ${cName}`),
  );
  await page.getByRole("button", { name: "No answer" }).click();
  await page.getByRole("button", { name: "Log it" }).click();
  await page
    .getByText(/Logged — next follow-up/)
    .first()
    .waitFor({ timeout: 8000 });
  await page.waitForFunction(
    (prev) => document.querySelector('[aria-label="Power dial"] h1')?.textContent !== prev,
    cName,
  );
  const cRow = await client(cName);
  const cAct = await one(
    "select outcome from activities where client_id = $1 and kind = 'call' order by occurred_at desc limit 1",
    [cRow.id],
  );
  const cDue = (await openTimers(cRow.id)).find((t) => t.kind === "follow_up");
  check(
    "'No answer' is logged and the retry lands in the next 3 days",
    cAct?.outcome === "no_answer" &&
      Boolean(cDue) &&
      cDue.due > today &&
      cDue.due <= addDays(today, 4),
    JSON.stringify({ cAct, cDue }),
  );
  check(
    "only the skipped client is left, and it is 3 of 3",
    (await title()) === a && (await progress()) === "3 of 3",
    `${await title()} ${await progress()}`,
  );

  // Card A: snooze with the big button.
  await region
    .getByRole("group", { name: "Snooze" })
    .getByRole("button", { name: "Tomorrow" })
    .click();
  await region.getByRole("heading", { name: "You're done" }).waitFor({ timeout: 8000 });
  const aRow = await client(a);
  const aDue = (await openTimers(aRow.id)).find((t) => t.kind === "follow_up");
  check(
    "Snooze → Tomorrow moves him a day in the database",
    aDue?.due === addDays(today, 1),
    JSON.stringify(aDue),
  );
  check(
    "an empty queue says 'You're done'",
    (await region.innerText()).includes("3 of 3 handled"),
    await region.innerText(),
  );
  await shot(page, "dial-done-light");
  await region.getByRole("link", { name: "Done for today" }).click();
  await page.waitForURL(`${BASE}/`);
  check(
    "'Done for today' leaves the dial for the Overview",
    (await until(() => page.getByRole("region", { name: "Right now" }).isVisible())) &&
      (await page.getByRole("region", { name: "Power dial" }).count()) === 0,
  );
  const left = await one(
    `select count(*)::int as n from client_cards c join app_users u on u.id = c.user_id
      where u.email = $1 and c.next_due_on <= ${NY_TODAY} and c.contact_status <> 'dnc'`,
    [email],
  );
  check("nothing is left due: all three really left Today", left.n === 0, `${left.n} still due`);

  // ---------------------------------------------------------------------------------------------
  // 6. Dark mode
  // (the three clients go back on today's list so the dark and phone screens have something to show)
  await withDb((db) =>
    db.query(
      `update timers t set due_on = ${NY_TODAY} from clients c, app_users u
        where t.client_id = c.id and u.id = c.user_id and u.email = $1 and t.done_at is null and c.id = any($2::uuid[])`,
      [email, three.map((r) => r.id)],
    ),
  );
  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "today-dark");
  await page.keyboard.press("Control+K");
  await page.getByRole("dialog", { name: "Find a client" }).getByRole("combobox").fill("305555");
  await shot(page, "palette-dark");
  await page.keyboard.press("Escape");
  await page.goto(`${BASE}/dial`, { waitUntil: "networkidle" });
  await shot(page, "dial-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await browser.close();

  // ---------------------------------------------------------------------------------------------
  // 7. The phone: a top bar, the sidebar's navigation behind its Menu button, nothing hidden under the bar
  const m = await openBrowser(
    email,
    { width: 390, height: 844 },
    { hasTouch: true, isMobile: true },
  );
  const mp = m.page;
  await mp.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  // a dialog's own header is a banner too, so the app's bar is the one with the Menu button
  const bar = mp.getByRole("banner").filter({ has: mp.getByRole("button", { name: "Menu" }) });
  check("the top bar is visible at 390px", await bar.isVisible());
  check(
    "the sidebar is hidden at 390px",
    !(await mp.locator("aside").isVisible()) &&
      !(await mp.getByRole("navigation", { name: "Main" }).isVisible()),
  );
  const labels = await bar
    .locator("a, button")
    .evaluateAll((els) =>
      els.map((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").trim()),
    );
  check(
    "the bar holds: Menu, the brand, Find a client, Alerts, New lead",
    labels.map((l) => l.replace(/, \d+ unread$/, "")).join("|") ===
      "Menu|Selective CRM home|Find a client|Alerts|New lead",
    labels.join("|"),
  );
  const vp = mp.viewportSize();
  const barBox = await bar.boundingBox();
  const barBottom = (barBox?.y ?? 0) + (barBox?.height ?? 0);
  check(
    "it sits on the top edge, full width",
    Math.abs(barBox?.y ?? -1) <= 1 && Math.abs((barBox?.width ?? 0) - (vp?.width ?? 0)) <= 1,
    JSON.stringify(barBox),
  );
  check(
    "brand, search and New lead are in the bar",
    (await bar.getByRole("link", { name: "Selective CRM home" }).isVisible()) &&
      (await bar.getByRole("button", { name: "Find a client" }).isVisible()) &&
      (await bar.getByRole("button", { name: "New lead" }).isVisible()),
  );
  const firstTop = (await mp.getByRole("heading", { level: 1 }).first().boundingBox())?.y ?? 0;
  await mp.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await mp.waitForTimeout(300);
  const lastCard = await mp.evaluate(
    () =>
      document.querySelector("main")?.firstElementChild?.lastElementChild?.getBoundingClientRect()
        .bottom ?? 0,
  );
  check(
    "the page starts below the bar, and the last card is clear of it and on screen when scrolled to the bottom",
    firstTop >= barBottom && lastCard > barBottom && lastCard <= (vp?.height ?? 0),
    `first ${firstTop}, last ${lastCard}, bar ends ${barBottom}, screen ${vp?.height}`,
  );
  await shot(mp, "today-390");

  // The Menu button slides the sidebar's navigation in; the due count rides on the Call list row.
  const dueNow = (
    await one(
      `select count(distinct t.client_id)::int as n from timers t join clients c on c.id = t.client_id
         join app_users u on u.id = c.user_id
        where u.email = $1 and t.done_at is null and t.due_on <= ${NY_TODAY} and c.contact_status <> 'dnc'`,
      [email],
    )
  ).n;
  await bar.getByRole("button", { name: "Menu" }).click();
  const menu = mp.getByRole("dialog", { name: "Menu" });
  await menu.waitFor();
  const nav = menu.getByRole("navigation", { name: "Main" });
  const callList = nav.getByRole("link", { name: /^Call list/ });
  check(
    "the Menu shows the due count on the Call list row (database)",
    dueNow > 0 && Number((await callList.innerText()).replace(/\D/g, "")) === dueNow,
    `${(await callList.innerText()).replace(/\s+/g, " ")} vs ${dueNow}`,
  );
  await menu.getByRole("button", { name: "Account" }).click();
  const menuText = (await menu.innerText()).replace(/\n+/g, "|");
  check(
    "the Menu holds Overview, Follow Up, Merchants (with the call list, power dial and trash), Settings, Alerts and Log out, and nothing of the removed pages",
    (await nav.getByRole("link", { name: /^Overview/ }).isVisible()) &&
      (await nav.getByRole("button", { name: /^Follow Up/ }).isVisible()) &&
      (await nav.getByRole("button", { name: /^Merchants/ }).getAttribute("aria-expanded")) ===
        "true" &&
      (await callList.isVisible()) &&
      (await nav.getByRole("link", { name: /^Power dial/ }).isVisible()) &&
      (await nav.getByRole("link", { name: /^Trash/ }).isVisible()) &&
      (await nav.getByRole("button", { name: /^Settings/ }).isVisible()) &&
      (await menu.getByRole("link", { name: /^Alerts/ }).isVisible()) &&
      (await menu.getByRole("button", { name: "Log out" }).isVisible()) &&
      !/Pipeline board|Winback|Funded|Deals|Lead intake/i.test(menuText),
    menuText,
  );
  await shot(mp, "menu-390");
  await nav.getByRole("button", { name: /^Settings/ }).click();
  await nav.getByRole("link", { name: /^My account/ }).click();
  await mp.waitForURL("**/settings");
  check(
    "a Menu link navigates and the menu closes",
    await until(async () => !(await menu.isVisible())),
  );

  // The bar is sticky: on a long page it is still on the top edge after scrolling.
  await mp.goto(`${BASE}/clients`, { waitUntil: "networkidle" });
  await mp.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await mp.waitForTimeout(300);
  const scrolled = await mp.evaluate(() => window.scrollY);
  const stuck = await bar.boundingBox();
  check(
    "the bar stays on the top edge when a long page is scrolled",
    scrolled > 100 && Math.abs(stuck?.y ?? -1) <= 1,
    `scrolled ${scrolled}px, bar at ${stuck?.y}`,
  );

  for (const path of ["/", "/clients", "/dial"]) {
    await mp.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    const overflow = await mp.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check(`mobile ${path} has no horizontal overflow`, overflow <= 1, `${overflow}px`);
  }
  // /dial at 390: full screen, big touch targets, the app's bar out of the way.
  await mp.goto(`${BASE}/dial`, { waitUntil: "networkidle" });
  await mp.getByRole("heading", { level: 1 }).first().waitFor();
  const tall = async (loc) => (await loc.boundingBox())?.height ?? 0;
  const dialRegion = mp.getByRole("region", { name: "Power dial" });
  check(
    "dial at 390px: Call, Skip and Next are all at least 44px tall",
    (await tall(dialRegion.getByRole("button", { name: /^Call / }))) >= 44 &&
      (await tall(dialRegion.getByRole("button", { name: /^Skip/ }))) >= 44 &&
      (await tall(dialRegion.getByRole("button", { name: /^Next/ }))) >= 44,
  );
  check(
    "…and the app's top bar is out of the way (covered by the dial and inert)",
    await mp.evaluate(() => {
      const btn = document.querySelector('[data-app-header] button[aria-label="Menu"]');
      if (!btn) return false;
      const r = btn.getBoundingClientRect();
      const onTop = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return (
        Boolean(onTop?.closest('[aria-label="Power dial"]')) && btn.closest("[inert]") !== null
      );
    }),
  );
  await shot(mp, "dial-390");
  await mp.emulateMedia({ colorScheme: "dark" });
  await mp.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  await shot(mp, "today-390-dark");
  await m.browser.close();

  // Desktop width: no top bar, the sidebar back.
  const wide = await openBrowser(email, { width: 1280, height: 800 });
  await wide.page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  check(
    "at desktop width the top bar is hidden and the sidebar shows",
    !(await wide.page.getByRole("button", { name: "Menu" }).isVisible()) &&
      (await wide.page.locator("aside").getByRole("navigation", { name: "Main" }).isVisible()),
  );
  await wide.browser.close();
}
