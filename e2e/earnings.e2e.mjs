// Earnings, editable advance terms, renewal radar, payoff prompt and price book.
//   CHROMIUM_PATH=... DATABASE_URL=... pnpm -s e2e earnings
import { mkdirSync } from "node:fs";
import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const SHOTS =
  process.env.SHOT_DIR ??
  "/tmp/claude-0/-home-user-Isaac/17874b0e-83c6-5f06-8a6a-1bf11b991d45/scratchpad/earnings";
mkdirSync(SHOTS, { recursive: true });

const rows = (db, sql, params) => db.query(sql, params).then((r) => r.rows);
const one = (db, sql, params) => rows(db, sql, params).then((r) => r[0]);

/** Mon–Fri, like addBusinessDays() in src/lib/mca/dates.ts. Written out again here on purpose: the test must not share code with what it checks. */
function bizAdd(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}
const addDaysIso = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The page re-renders a moment after a server action returns; wait for the text instead of racing it. */
const seen = (page, text) =>
  page
    .getByText(text)
    .first()
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);

export default async function earningsFlow({ email }) {
  const user = await withDb((db) => one(db, "select id from app_users where email = $1", [email]));
  const today = await withDb((db) =>
    one(db, "select (now() at time zone 'America/New_York')::date::text as d").then((r) => r.d),
  );
  const client = (name) =>
    withDb((db) =>
      one(db, "select id, stage from clients where user_id = $1 and business_name = $2", [
        user.id,
        name,
      ]),
    );
  // bigint columns arrive as strings; the checks below compare numbers
  const MONEY = [
    "amount_cents",
    "payback_cents",
    "payment_cents",
    "commission_cents",
    "commission_received_cents",
  ];
  const fundingRows = (clientId) =>
    withDb((db) =>
      rows(
        db,
        "select * from fundings where client_id = $1 order by funded_on desc, created_at desc",
        [clientId],
      ),
    ).then((list) =>
      list.map((r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [k, MONEY.includes(k) && v !== null ? Number(v) : v]),
        ),
      ),
    );
  const openTimers = (clientId) =>
    withDb((db) =>
      rows(
        db,
        "select id, kind, due_on, note from timers where client_id = $1 and done_at is null order by kind",
        [clientId],
      ),
    );

  // ---- history the earnings page can chew on: commissions entered, some received in earlier months --------------
  const history = [
    // name, commission entered, received amount, days ago received
    ["Sol Y Mar Grill", 275_000, 275_000, 45],
    ["Apex Dental Lab", 300_000, 300_000, 70],
    ["Iron Ridge Gym", 250_000, 250_000, 100],
    ["Prime Cuts Barbers", 260_000, 260_000, 130],
    ["Cedar Print Shop", 240_000, 240_000, 200],
    ["Duke's Detailing", 250_000, 250_000, 170],
    ["Blue Door Bistro", 250_000, null, 0],
  ];
  for (const [name, entered, got, ago] of history) {
    await withDb((db) =>
      db.query(
        `update fundings set commission_cents = $2, commission_received_cents = $3,
                commission_received_on = case when $3::bigint is null then null else ($4::date - $5::int) end
          where client_id = (select id from clients where user_id = $1 and business_name = $6)`,
        [user.id, entered, got, today, ago, name],
      ),
    );
  }
  // two advances whose last remittance is long past but still say Funded, plus a third for "move all"
  for (const name of ["Iron Ridge Gym", "Apex Dental Lab", "Summit Roofing"]) {
    await withDb((db) =>
      db.query(
        `update fundings set funded_on = ($2::date - 330) where client_id = (select id from clients where user_id = $1 and business_name = $3)`,
        [user.id, today, name],
      ),
    );
  }

  const { browser, page } = await openBrowser(email);

  // ======================================================================================================
  // 1. fix a typo in the terms of a live advance
  // ======================================================================================================
  const blue = await client("Blue Door Bistro");
  const [blueFunding] = await fundingRows(blue.id);
  const timersBefore = await openTimers(blue.id);
  const checkInBefore = timersBefore.find((t) => t.kind === "check_in");
  await page.goto(`${BASE}/clients/${blue.id}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/01-funding-card.png`, fullPage: true });
  await page.getByRole("button", { name: "Update", exact: true }).click();
  const dialog = page.getByRole("dialog");
  check("Update opens the full terms dialog", await dialog.getByText("Advance terms").isVisible());
  check(
    "the old fields are still there",
    (await dialog.getByLabel("Collected so far").count()) === 1 &&
      (await dialog.getByLabel("Last remittance received").count()) === 1 &&
      (await dialog.getByLabel("Promise to pay — when").count()) === 1,
  );
  const amountBox = dialog.getByLabel("Advance amount");
  check("the amount is pre-filled with what is stored", (await amountBox.inputValue()) === "50000");
  await amountBox.fill("52000");
  await dialog.getByLabel("Remittance", { exact: true }).fill("600");
  const preview = await dialog.locator("[aria-live=polite]").innerText();
  const factor = Number(blueFunding.factor_rate);
  const payback = Math.round(5_200_000 * factor);
  check(
    "live preview shows the new payback and remittance count",
    preview.includes(`$${(payback / 100).toLocaleString("en-US")}`) &&
      preview.includes(String(Math.ceil(payback / 60_000))),
    preview.replace(/\s+/g, " "),
  );
  check(
    "live preview says the renewal call will move",
    /Saving moves the renewal call/.test(preview),
  );
  await dialog.screenshot({ path: `${SHOTS}/02-terms-dialog.png` });

  // plain-words validation, and the dialog stays
  await dialog.getByLabel("Factor rate").fill("0.9");
  await dialog.getByRole("button", { name: "Save" }).click();
  check(
    "a bad factor rate is explained and nothing is sent",
    (await dialog.getByText("Factor rate must be between 1.00 and 3.00").count()) > 0 &&
      (await fundingRows(blue.id))[0].amount_cents === 5_000_000,
  );
  await dialog.getByLabel("Factor rate").fill(String(factor));
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.getByText("Funding updated").waitFor({ timeout: 8000 });

  const [afterRow] = await fundingRows(blue.id);
  check(
    "the amount and remittance changed in the database",
    afterRow.amount_cents === 5_200_000 && afterRow.payment_cents === 60_000,
  );
  check(
    "payback was recomputed by the database",
    afterRow.payback_cents === payback,
    `${afterRow.payback_cents} vs ${payback}`,
  );
  check("the advance is still active, not 'renewed' by a re-fund", afterRow.status === "active");
  check("no second advance was created", (await fundingRows(blue.id)).length === 1);
  const timersAfter = await openTimers(blue.id);
  const renewalAfter = timersAfter.find((t) => t.kind === "renewal");
  const n50 = Math.ceil((payback * 0.5) / 60_000);
  const expectedRenewal = bizAdd(afterRow.funded_on, n50);
  check(
    "the renewal timer now sits on the day the merchant crosses 50% under the new terms",
    expectedRenewal > today
      ? renewalAfter?.due_on === expectedRenewal
      : renewalAfter?.due_on <= today,
    `${renewalAfter?.due_on} vs ${expectedRenewal}`,
  );
  check(
    "it is the same renewal timer row, not a new one",
    timersAfter.filter((t) => t.kind === "renewal").length === 1 &&
      timersBefore.find((t) => t.kind === "renewal")?.id === renewalAfter?.id,
  );
  check(
    "the 30-day check-in is untouched",
    JSON.stringify(timersAfter.find((t) => t.kind === "check_in")) ===
      JSON.stringify(checkInBefore),
  );
  const logged = await withDb((db) =>
    rows(
      db,
      "select kind, body from activities where client_id = $1 order by occurred_at desc limit 1",
      [blue.id],
    ),
  );
  check(
    "the timeline says what changed in plain words",
    /^Advance terms corrected: amount \$50,000 → \$52,000, remittance \$550\/day → \$600\/day/.test(
      logged[0]?.body ?? "",
    ),
    logged[0]?.body,
  );
  check(
    "and the timeline on the page shows it",
    await seen(page, "Advance terms corrected: amount $50,000 → $52,000"),
  );

  // a save that fails on the server keeps the dialog and what was typed
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await dialog.getByLabel("Advance amount").fill("61000");
  await withDb((db) => db.query("delete from fundings where id = $1", [afterRow.id])); // gone behind his back
  await dialog.getByRole("button", { name: "Save" }).click();
  await page
    .getByText(/no longer exists/)
    .first()
    .waitFor({ timeout: 8000 });
  check(
    "a failed save keeps the dialog open with the typed value",
    (await dialog.isVisible()) &&
      (await dialog.getByLabel("Advance amount").inputValue()) === "61000",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  // put it back so later steps see the merchant
  await withDb((db) =>
    db.query(
      `insert into fundings (id, user_id, client_id, funded_on, funder_name, amount_cents, factor_rate, payment_cents, frequency,
                             position_no, commission_cents, status)
       values ($1, $2, $3, $4, $5, 5000000, $6, 55000, 'daily', 1, 250000, 'active')`,
      [afterRow.id, user.id, blue.id, afterRow.funded_on, afterRow.funder_name, factor],
    ),
  );

  // ======================================================================================================
  // 2. an older advance can be corrected, and no timer moves
  // ======================================================================================================
  const sol = await client("Sol Y Mar Grill");
  await withDb((db) =>
    db.query("select record_funding($1, $2::jsonb, $3::jsonb)", [
      sol.id,
      JSON.stringify({
        funded_on: addDaysIso(today, -5),
        funder_name: "Beta Funding",
        amount_cents: 3_000_000,
        factor_rate: 1.3,
        payment_cents: 40_000,
        frequency: "daily",
        position_no: 1,
        commission_cents: 150_000,
      }),
      JSON.stringify([
        { kind: "check_in", due_on: addDaysIso(today, 25), note: "" },
        { kind: "renewal", due_on: addDaysIso(today, 60), note: "" },
      ]),
    ]),
  );
  const solRows = await fundingRows(sol.id);
  const oldAdvance = solRows.find((r) => r.status === "renewed");
  const solTimers = await openTimers(sol.id);
  await page.goto(`${BASE}/clients/${sol.id}`, { waitUntil: "networkidle" });
  await page.getByText(/Past advances/).click();
  await page.getByRole("button", { name: /^Edit the \$50,000 advance/ }).click();
  check(
    "a past advance opens in an 'Edit past advance' dialog that says no reminders move",
    (await dialog.getByText("Edit past advance").isVisible()) &&
      (await dialog.getByText(/no reminders move/).count()) > 0,
  );
  await dialog.getByLabel("Advance amount").fill("48000");
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.getByText("Funding updated").waitFor({ timeout: 8000 });
  const oldAfter = (await fundingRows(sol.id)).find((r) => r.id === oldAdvance.id);
  check("the old advance changed in the database", oldAfter.amount_cents === 4_800_000);
  check("and stayed 'renewed'", oldAfter.status === "renewed");
  check("no timer moved", JSON.stringify(await openTimers(sol.id)) === JSON.stringify(solTimers));
  const newest = (await fundingRows(sol.id)).find((r) => r.id !== oldAdvance.id);
  check("the newer advance is untouched", newest.amount_cents === 3_000_000);

  // ======================================================================================================
  // 3. commission received: from the card, and from the Earnings page
  // ======================================================================================================
  const summit = await client("Summit Roofing");
  await page.goto(`${BASE}/clients/${summit.id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await dialog.getByLabel("Commission received").fill("2,500");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.getByText("Enter the day the commission arrived").waitFor({ timeout: 5000 });
  check(
    "an amount without a day is refused in words, nothing saved",
    (await fundingRows(summit.id))[0].commission_received_cents === null,
  );
  await dialog.getByLabel("Day it arrived").fill(today);
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.getByText("Funding updated").waitFor({ timeout: 8000 });
  const summitRow = (await fundingRows(summit.id))[0];
  check(
    "commission received is stored with its day",
    summitRow.commission_received_cents === 250_000 && summitRow.commission_received_on === today,
  );
  check(
    "the Funding card shows it",
    (await seen(page, "Commission received")) && (await seen(page, "$2,500")),
  );

  await page.goto(`${BASE}/earnings`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/03-earnings-light.png`, fullPage: true });
  const tileValue = async (label) => {
    const tile = page
      .getByText(label, { exact: true })
      .first()
      .locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
    const text = await tile.innerText();
    const m = /\$[\d,]+/.exec(text);
    return m ? Number(m[0].replace(/[$,]/g, "")) * 100 : null;
  };
  const sums = await withDb((db) =>
    one(
      db,
      `select
         coalesce(sum(commission_received_cents) filter (where to_char(commission_received_on,'YYYY-MM') = to_char($2::date,'YYYY-MM')), 0)::bigint as this_month,
         coalesce(sum(commission_received_cents) filter (where to_char(commission_received_on,'YYYY-MM') = to_char($2::date - interval '1 month','YYYY-MM')), 0)::bigint as last_month,
         coalesce(sum(commission_received_cents) filter (where extract(year from commission_received_on) = extract(year from $2::date)), 0)::bigint as ytd
       from fundings where user_id = $1`,
      [user.id, today],
    ),
  );
  check(
    "This month shows what the database holds",
    (await tileValue("This month")) === Number(sums.this_month),
    `${await tileValue("This month")} vs ${sums.this_month}`,
  );
  check(
    "Last month shows what the database holds",
    (await tileValue("Last month")) === Number(sums.last_month),
    `${await tileValue("Last month")} vs ${sums.last_month}`,
  );
  check(
    "Year to date shows what the database holds",
    (await tileValue("Year to date")) === Number(sums.ytd),
    `${await tileValue("Year to date")} vs ${sums.ytd}`,
  );
  check("this month includes the $2,500 just entered", Number(sums.this_month) >= 250_000);

  // the awaiting list: Blue Door has an entered commission and nothing received
  check(
    "Blue Door Bistro waits for $2,500",
    (await page.getByText("Blue Door Bistro").count()) > 0,
  );
  const blueItem = page.locator("li", { hasText: "Blue Door Bistro" }).first();
  await blueItem.getByRole("button", { name: "Record received" }).click();
  const recDialog = page.getByRole("dialog");
  check(
    "'Record received' starts from the expected amount",
    (await recDialog.getByLabel("Amount received").inputValue()) === "2500",
  );
  await recDialog.getByLabel("Amount received").fill("2,400");
  await recDialog.getByRole("button", { name: "Save" }).click();
  await page.getByText("Commission recorded for Blue Door Bistro").waitFor({ timeout: 8000 });
  const blueNow = (await fundingRows(blue.id))[0];
  check(
    "recorded from the Earnings page, in the database",
    blueNow.commission_received_cents === 240_000 && blueNow.commission_received_on === today,
  );
  await page.reload({ waitUntil: "networkidle" });
  check(
    "This month moved by exactly that much",
    (await tileValue("This month")) === Number(sums.this_month) + 240_000,
  );

  const chart = page.getByRole("group", { name: /Commission received per month/ });
  check("the month chart is drawn", await chart.isVisible());
  await chart.getByRole("img").nth(11).hover();
  check(
    "hovering a bar shows its month and amount",
    (await page.getByRole("status").filter({ hasText: "from" }).count()) > 0,
  );
  const tableRows = await page.locator("table").first().locator("tbody tr").count();
  check("the month table has 12 rows", tableRows === 12, String(tableRows));
  check(
    "estimates say so and carry a tooltip",
    (await page.getByText("estimate", { exact: true }).count()) > 0 &&
      (await page.locator("[role=tooltip]").count()) > 0,
  );
  const tip = await page.locator("[role=tooltip]").nth(1).textContent();
  check(
    "the tooltip shows the formula with his average points",
    /average .* points/.test(tip ?? ""),
    tip ?? "",
  );

  // price book
  check(
    "the price book shows sample sizes",
    (await page.getByText(/Based on \d+ prices?/).count()) > 0,
  );
  check(
    "a bucket under 3 prices shows 'too few', not an average",
    (await page.getByText("too few").count()) > 0 ||
      (await page.getByText(/Only \d+ prices? so far/).count()) > 0,
  );

  // ======================================================================================================
  // 4. renewal radar
  // ======================================================================================================
  // two merchants become eligible long ago with no contact, one with a recent call; one paid-in-full is do-not-contact
  await withDb((db) =>
    db.query(
      `update clients set stage_changed_at = now() - interval '5 days' where user_id = $1 and business_name = 'Cedar Print Shop'`,
      [user.id],
    ),
  );
  await withDb((db) =>
    db.query(
      `update clients set stage_changed_at = now() - interval '70 days' where user_id = $1 and business_name = $2`,
      [user.id, "Duke's Detailing"],
    ),
  );
  await withDb((db) =>
    db.query(
      `update clients set contact_status = 'dnc' where user_id = $1 and business_name = 'Cedar Print Shop'`,
      [user.id],
    ),
  );
  await page.goto(`${BASE}/renewals`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/04-renewals-light.png`, fullPage: true });
  const promptText = await page
    .getByRole("region", { name: /past their estimated payoff|past its estimated payoff/i })
    .innerText()
    .catch(() => "");
  check(
    "the payoff prompt lists the advances past their estimated payoff",
    /3 advances are past their estimated payoff — move to Paid in full\?/.test(promptText),
    promptText.replace(/\s+/g, " ").slice(0, 100),
  );
  const ready = page.locator("article").filter({ hasText: "paid down" });
  const scores = await ready.evaluateAll((articles) =>
    articles.map((a) => {
      const fact = (label) => {
        const dt = [...a.querySelectorAll("dt")].find((d) => d.textContent === label);
        return dt?.nextElementSibling?.textContent ?? "";
      };
      const days = /(\d+) days?/.exec(fact("Eligible"));
      const money = /\$([\d,]+)/.exec(fact("Renewal commission"));
      return {
        name: a.querySelector("a")?.textContent ?? "",
        score: (days ? Number(days[1]) : 0) * (money ? Number(money[1].replace(/,/g, "")) : 0),
      };
    }),
  );
  check(
    "the radar lists merchants hottest first (eligible days × commission, descending)",
    scores.length > 1 && scores.every((s, i) => i === 0 || scores[i - 1].score >= s.score),
    scores.map((s) => `${s.name}:${s.score}`).join(", "),
  );
  check(
    "'Not contacted since eligible' flags merchants nobody has called",
    (await page.getByText("Not contacted since eligible").count()) > 0,
  );
  check(
    "each ready merchant shows days eligible, payback outstanding, commission and last contact",
    (await page.getByText("Payback outstanding").count()) > 0 &&
      (await page.getByText("Renewal commission").count()) > 0 &&
      (await page.getByText("Last contact").count()) > 0 &&
      (await page.getByText("Eligible", { exact: true }).count()) > 0,
  );
  const paid = page.locator("article").filter({ hasText: "Paid off" });
  check(
    "paid-in-full merchants show days since paid off",
    (await paid.filter({ hasText: /Paid off (\d+ days? ago|today)/ }).count()) >= 2,
  );
  check(
    "a merchant inside 30 days is marked Hot, one at 70 days is not",
    (await paid
      .filter({ hasText: "Cedar Print Shop" })
      .getByText("Hot", { exact: true })
      .count()) === 1 &&
      (await paid
        .filter({ hasText: "Duke's Detailing" })
        .getByText("Hot", { exact: true })
        .count()) === 0,
  );
  check(
    "a do-not-contact merchant's Call is disabled",
    await page.getByRole("button", { name: /^Call Cedar Print Shop/ }).isDisabled(),
  );
  check(
    "other paid-in-full merchants have a live Call",
    await page.getByRole("button", { name: /^Call Duke's Detailing/ }).isEnabled(),
  );

  // ======================================================================================================
  // 5. move past-payoff advances to Paid in full
  // ======================================================================================================
  const prompt = page.getByRole("region", { name: /estimated payoff/i });
  await prompt.getByRole("button", { name: "Move to Paid in full" }).first().click();
  await page
    .getByText(/moved to Paid in full/)
    .first()
    .waitFor({ timeout: 8000 });
  const stages = await withDb((db) =>
    rows(
      db,
      `select c.business_name, c.stage, f.status from clients c join fundings f on f.client_id = c.id
        where c.user_id = $1 and c.business_name in ('Iron Ridge Gym','Apex Dental Lab','Summit Roofing') order by 1`,
      [user.id],
    ),
  );
  const moved = stages.filter((s) => s.stage === "paid_in_full");
  check(
    "one per-row move changed exactly one merchant in the database",
    moved.length === 1,
    JSON.stringify(stages),
  );
  check("its advance is now paid off", moved[0]?.status === "paid_off");
  const movedClient = await client(moved[0].business_name);
  const movedTimer = await openTimers(movedClient.id);
  check(
    "and it got the 14-day Paid in full timer",
    movedTimer.length === 1 && movedTimer[0].kind === "follow_up",
    JSON.stringify(movedTimer),
  );
  await page.reload({ waitUntil: "networkidle" });
  await prompt.getByRole("button", { name: /^Move all 2/ }).click();
  await page.getByText("Moved 2 merchants to Paid in full").waitFor({ timeout: 10000 });
  const after = await withDb((db) =>
    rows(
      db,
      `select c.stage, f.status from clients c join fundings f on f.client_id = c.id
        where c.user_id = $1 and c.business_name in ('Iron Ridge Gym','Apex Dental Lab','Summit Roofing')`,
      [user.id],
    ),
  );
  check(
    "'Move all' moved the rest, advances paid off",
    after.every((s) => s.stage === "paid_in_full" && s.status === "paid_off"),
    JSON.stringify(after),
  );
  await page.reload({ waitUntil: "networkidle" });
  check(
    "the prompt is gone once there is nothing past payoff",
    (await page.getByRole("region", { name: /estimated payoff/i }).count()) === 0,
  );

  // ======================================================================================================
  // 6. looks right everywhere
  // ======================================================================================================
  for (const path of ["/earnings", "/renewals"]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    const name = path.slice(1);
    await page.screenshot({ path: `${SHOTS}/10-${name}-light-after.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "dark" });
  for (const path of ["/earnings", "/renewals"]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${SHOTS}/20-${path.slice(1)}-dark.png`, fullPage: true });
  }
  await page.goto(`${BASE}/clients/${blue.id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await page.screenshot({ path: `${SHOTS}/21-terms-dialog-dark.png` });
  await browser.close();

  const phone = await openBrowser(email, { width: 390, height: 844 });
  for (const path of ["/earnings", "/renewals"]) {
    await phone.page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await phone.page.screenshot({ path: `${SHOTS}/30-${path.slice(1)}-390.png`, fullPage: true });
    const overflow = await phone.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(`${path} has no horizontal scroll at 390px`, overflow <= 0, `overflow ${overflow}px`);
  }
  await phone.page.goto(`${BASE}/clients/${blue.id}`, { waitUntil: "networkidle" });
  await phone.page.getByRole("button", { name: "Update", exact: true }).click();
  await phone.page.screenshot({ path: `${SHOTS}/31-terms-dialog-390.png` });
  const dialogOverflow = await phone.page.evaluate(() => {
    const d = document.querySelector("dialog[open]");
    return d ? d.scrollWidth - d.clientWidth : 0;
  });
  check(
    "the terms dialog fits a 390px screen",
    dialogOverflow <= 0,
    `overflow ${dialogOverflow}px`,
  );
  await phone.browser.close();
}
