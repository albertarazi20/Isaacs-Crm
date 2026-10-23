// Funders, submissions and offers-in, driven through the real UI. Every step asserts the database,
// not just the screen. Screenshots (light, dark, 390px) go to SHOT_DIR so a human can look at them.
import { mkdirSync } from "node:fs";
import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const SHOT_DIR =
  process.env.SHOT_DIR ??
  "/tmp/claude-0/-home-user-Isaac/17874b0e-83c6-5f06-8a6a-1bf11b991d45/scratchpad/funders";
mkdirSync(SHOT_DIR, { recursive: true });

const rows = (sql, params) => withDb((db) => db.query(sql, params).then((r) => r.rows));
const one = (sql, params) => rows(sql, params).then((r) => r[0]);

export default async function fundersFlow({ email }) {
  const { browser, page } = await openBrowser(email);
  const shot = (name) => page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
  const dialog = () => page.getByRole("dialog");

  // ---- /funders: empty state, then add three funders ---------------------------------------
  await page.goto(`${BASE}/funders`, { waitUntil: "networkidle" });
  check(
    "empty Funders page explains what to do first",
    await page.getByText("Start by adding the funders you send applications to").isVisible(),
  );
  await shot("01-funders-empty");

  async function addFunder(fields) {
    await page.getByRole("button", { name: "+ Add funder" }).click();
    await dialog().waitFor();
    for (const [label, value] of Object.entries(fields)) {
      await dialog().getByLabel(label).fill(value);
    }
    await dialog().getByRole("button", { name: "Save" }).click();
    await page.getByText(`Added ${fields["Funder name *"]}`).waitFor({ timeout: 8000 });
    await dialog().waitFor({ state: "hidden" });
  }

  // A failed save keeps the dialog and what was typed.
  await page.getByRole("button", { name: "+ Add funder" }).click();
  await dialog().getByLabel("Funder name *").fill("Bad Capital");
  await dialog().getByLabel("States they won't write").fill("FL, Narnia");
  await dialog().getByRole("button", { name: "Save" }).click();
  await dialog().getByRole("alert").waitFor();
  check(
    "a bad state is explained in the dialog, which stays open with the typed values",
    (await dialog().getByRole("alert").innerText()).includes("isn't a state") &&
      (await dialog().getByLabel("Funder name *").inputValue()) === "Bad Capital",
  );
  const none = await one(
    "select count(*)::int n from funders f join app_users u on u.id = f.user_id where u.email = $1",
    [email],
  );
  check("nothing was saved by the bad attempt", none.n === 0);
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "hidden" });

  await addFunder({
    "Funder name *": "Pearl Capital",
    "Contact name": "Dana",
    "Where you send applications": "subs@pearl.example",
    "Minimum monthly revenue": "50k",
    "Highest position they'll take": "2",
    "Industries they skip": "restaurants, trucking",
    "Your commission points": "8",
  });
  await addFunder({
    "Funder name *": "Libertas Funding",
    "Minimum time in business (months)": "12",
    "States they won't write": "FL, new york",
  });
  await addFunder({
    "Funder name *": "Everest Advance",
    "Highest position they'll take": "1",
    "Smallest advance": "20k",
  });
  const funders = await rows(
    `select f.name, f.min_monthly_revenue_cents::int rev, f.max_position, f.excluded_states, f.excluded_industries,
            f.commission_points::float8 pts, f.min_amount_cents::int min_amt
       from funders f join app_users u on u.id = f.user_id where u.email = $1 order by f.name`,
    [email],
  );
  check(
    "three funders saved with their appetite (k and $ parsed, states normalised)",
    funders.length === 3 &&
      funders[2].name === "Pearl Capital" &&
      funders[2].rev === 5_000_000 &&
      funders[2].max_position === 2 &&
      funders[2].pts === 8 &&
      funders[2].excluded_industries.join() === "restaurants,trucking" &&
      funders[1].excluded_states.join() === "FL,NY" &&
      funders[0].max_position === 1 &&
      funders[0].min_amt === 2_000_000,
    JSON.stringify(funders),
  );
  check(
    "funder cards show the appetite in words",
    (await page.getByText("Min revenue $50k/mo").isVisible()) &&
      (await page.getByText("Up to 2nd position").isVisible()) &&
      (await page.getByText("Skips FL, NY").isVisible()),
  );
  await shot("02-funders-list");

  // Duplicate names are refused in plain words.
  await page.getByRole("button", { name: "+ Add funder" }).click();
  await dialog().getByLabel("Funder name *").fill("pearl capital");
  await dialog().getByRole("button", { name: "Save" }).click();
  await page.getByText("You already have a funder called pearl capital").waitFor({ timeout: 8000 });
  check("a duplicate funder name is refused and the dialog stays open", await dialog().isVisible());
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "hidden" });

  // ---- a merchant to send: Salon, NJ, $80k/mo, 36 months, one advance already (so this would be 2nd) ----
  const merchant = await one(
    `select c.id, c.business_name from clients c join app_users u on u.id = c.user_id
      where u.email = $1 and c.business_name = 'Bright Smiles Pediatrics'`,
    [email],
  );
  await withDb(async (db) => {
    await db.query(
      `update clients set industry = 'Dental', state = 'NJ', monthly_revenue_cents = 8000000,
              time_in_business_months = 36 where id = $1`,
      [merchant.id],
    );
    await db.query(
      `insert into positions (user_id, client_id, position_no, funder_name, funded_amount_cents, balance_cents)
       select user_id, id, 1, 'Old Funder', 2000000, 900000 from clients where id = $1`,
      [merchant.id],
    );
    await db.query("update clients set stage = 'stips' where id = $1", [merchant.id]);
  });

  await page.goto(`${BASE}/clients/${merchant.id}`, { waitUntil: "networkidle" });
  check(
    "the Submissions card starts with an empty state",
    await page.getByText("Not sent to any funder yet").isVisible(),
  );
  await page.getByRole("button", { name: "Send to funders" }).click();
  await dialog().waitFor();
  const pearlBox = dialog().getByRole("checkbox", { name: "Pearl Capital" });
  const libertasBox = dialog().getByRole("checkbox", { name: "Libertas Funding" });
  const everestBox = dialog().getByRole("checkbox", { name: "Everest Advance" });
  check(
    "funders that fit are ticked; the one that won't take 2nd position is not",
    (await pearlBox.isChecked()) &&
      (await libertasBox.isChecked()) &&
      !(await everestBox.isChecked()),
  );
  const sendText = await dialog().innerText();
  check(
    "fit check says fits for two and gives the reason for the third",
    sendText.includes("Everest Advance won't take 2nd position (up to 1st)") &&
      (sendText.match(/Fits\b/g) ?? []).length >= 2 &&
      sendText.includes("would be 2nd position"),
    sendText.replace(/\s+/g, " ").slice(0, 400),
  );
  await shot("03-send-dialog");
  await dialog().getByRole("button", { name: "Send to 2 funders" }).click();
  await page.getByText(/Sent to Libertas Funding, Pearl Capital/).waitFor({ timeout: 8000 });
  await dialog().waitFor({ state: "hidden" });

  // ---- database: submissions, chase timers, stage, timeline ----------------------------------
  const subs = await rows(
    `select f.name, s.status, s.sent_on::text, s.responded_at from submissions s
       join funders f on f.id = s.funder_id where s.client_id = $1 order by f.name`,
    [merchant.id],
  );
  check(
    "two submissions exist, both 'sent'",
    subs.length === 2 && subs.every((s) => s.status === "sent") && subs[1].name === "Pearl Capital",
    JSON.stringify(subs),
  );
  const chase = await rows(
    `select t.due_on::text, extract(isodow from t.due_on)::int dow, t.submission_id is not null linked
       from timers t where t.client_id = $1 and t.kind = 'chase' and t.done_at is null`,
    [merchant.id],
  );
  check(
    "one chase timer per submission, on a weekday after the send",
    chase.length === 2 && chase.every((c) => c.linked && c.dow <= 5 && c.due_on > subs[0].sent_on),
    JSON.stringify(chase),
  );
  const moved = await one("select stage from clients where id = $1", [merchant.id]);
  check("Collecting stips moved to Submitted to funders", moved.stage === "submitted", moved.stage);
  const log = await rows(
    "select body from activities where client_id = $1 and kind = 'system' and body like 'Submitted to%'",
    [merchant.id],
  );
  check(
    "the timeline says who it was sent to",
    log[0]?.body === "Submitted to Libertas Funding, Pearl Capital",
    log[0]?.body,
  );
  await page.waitForTimeout(300);
  await shot("04-submissions-sent");

  // Logging a call to the merchant (the same SQL the Call button runs) does not clear the chase.
  await withDb((db) =>
    db.query(
      "select * from log_touch($1, 'call', 'reached', 'spoke with owner', current_date + 3)",
      [merchant.id],
    ),
  );
  const stillChasing = await one(
    "select count(*)::int n from timers where client_id = $1 and kind = 'chase' and done_at is null",
    [merchant.id],
  );
  check("logging a call to the merchant leaves both chase timers open", stillChasing.n === 2);

  // ---- Pearl approves with an offer; a second offer follows ----------------------------------
  const pearl = page.locator('li[data-submission="Pearl Capital"]');
  const libertas = page.locator('li[data-submission="Libertas Funding"]');
  await pearl.getByRole("button", { name: "Approved" }).click();
  await dialog().waitFor();
  await dialog().getByLabel("Advance amount *").fill("45k");
  await dialog().getByLabel("Factor rate *").fill("1.34");
  await dialog().getByLabel("Remittance (each debit)").fill("450");
  await dialog().getByLabel("Estimated term (days)").fill("130");
  await dialog().getByLabel("Fees").fill("500");
  check(
    "the offer form shows the payback",
    (await dialog().innerText()).includes("Payback $60,300"),
  );
  await shot("05-offer-dialog");
  await dialog().getByRole("button", { name: "Save offer" }).click();
  await page.getByText("Offer from Pearl Capital saved").waitFor({ timeout: 8000 });
  await dialog().waitFor({ state: "hidden" });
  await pearl.getByRole("button", { name: "Add offer" }).click();
  await dialog().waitFor();
  await dialog().getByLabel("Advance amount *").fill("40k");
  await dialog().getByLabel("Factor rate *").fill("1.31");
  await dialog().getByLabel("Remittance (each debit)").fill("400");
  await dialog().getByLabel("Estimated term (days)").fill("120");
  await dialog().getByRole("button", { name: "Save offer" }).click();
  await page.getByText("Offer from Pearl Capital saved").last().waitFor({ timeout: 8000 });
  await dialog().waitFor({ state: "hidden" });

  const offers = await rows(
    `select o.amount_cents::int amt, o.factor_rate::float8 factor, o.payment_cents::int pay, o.frequency,
            o.term_days, o.position_no, o.fees_cents::int fees, o.status
       from offers o where o.client_id = $1 order by o.factor_rate desc`,
    [merchant.id],
  );
  check(
    "both offers are in the database with their terms and the next position (2nd)",
    offers.length === 2 &&
      offers[0].amt === 4_500_000 &&
      offers[0].factor === 1.34 &&
      offers[0].pay === 45_000 &&
      offers[0].frequency === "daily" &&
      offers[0].term_days === 130 &&
      offers[0].position_no === 2 &&
      offers[0].fees === 50_000 &&
      offers[1].factor === 1.31,
    JSON.stringify(offers),
  );
  const afterOffer = await one(
    `select c.stage,
            (select s.status from submissions s join funders f on f.id = s.funder_id where s.client_id = c.id and f.name = 'Pearl Capital') pearl,
            (select count(*)::int from timers t join submissions s on s.id = t.submission_id join funders f on f.id = s.funder_id
              where t.client_id = c.id and t.kind = 'chase' and t.done_at is null and f.name = 'Pearl Capital') pearl_chase,
            (select count(*)::int from timers t join submissions s on s.id = t.submission_id join funders f on f.id = s.funder_id
              where t.client_id = c.id and t.kind = 'chase' and t.done_at is null and f.name = 'Libertas Funding') libertas_chase
       from clients c where c.id = $1`,
    [merchant.id],
  );
  check(
    "Pearl is approved, its chase is closed, Libertas's chase survived the move to Offers in",
    afterOffer.stage === "offers_in" &&
      afterOffer.pearl === "approved" &&
      afterOffer.pearl_chase === 0 &&
      afterOffer.libertas_chase === 1,
    JSON.stringify(afterOffer),
  );
  // The page refreshes a moment after the dialog closes; wait for the second offer to land.
  await page.getByLabel("Offers in").getByText("lowest factor").waitFor({ timeout: 8000 });
  const summary = await page.getByLabel("Offers in").innerText();
  check(
    "the offers-in line lists both, best (lowest factor) flagged",
    summary.includes("Pearl Capital 1.31 / $40k daily") &&
      summary.includes("Pearl Capital 1.34 / $45k daily") &&
      summary.includes("lowest factor") &&
      summary.indexOf("1.31") < summary.indexOf("1.34"),
    summary.replace(/\s+/g, " "),
  );

  // ---- Libertas declines with a reason ---------------------------------------------------------
  await libertas.getByRole("button", { name: "Declined" }).click();
  await dialog().waitFor();
  await dialog().getByRole("button", { name: "Save decline" }).click();
  check(
    "a decline without a reason is refused in the dialog",
    (await dialog().getByRole("alert").innerText()).includes("Pick why they declined"),
  );
  await dialog().getByLabel("Why did they decline?").selectOption("revenue");
  await dialog().getByLabel("Note").fill("wants 100k+ a month");
  await shot("06-decline-dialog");
  await dialog().getByRole("button", { name: "Save decline" }).click();
  await page.getByText("Libertas Funding declined").first().waitFor({ timeout: 8000 });
  await dialog().waitFor({ state: "hidden" });
  const declined = await one(
    `select s.status, s.decline_reason, s.decline_note, s.responded_at is not null answered,
            (select count(*)::int from timers t where t.submission_id = s.id and t.done_at is null) open_chase
       from submissions s join funders f on f.id = s.funder_id where s.client_id = $1 and f.name = 'Libertas Funding'`,
    [merchant.id],
  );
  check(
    "Libertas is declined for revenue with the note, answered, and its chase closed",
    declined.status === "declined" &&
      declined.decline_reason === "revenue" &&
      declined.decline_note === "wants 100k+ a month" &&
      declined.answered &&
      declined.open_chase === 0,
    JSON.stringify(declined),
  );
  await page.waitForTimeout(300);
  await shot("07-after-answers");

  // ---- accept the best offer: the Funded dialog opens pre-filled -------------------------------
  await pearl
    .locator('li[data-offer="open"]')
    .filter({ hasText: "1.31 factor" })
    .getByRole("button", { name: "Accept" })
    .click();
  await dialog().waitFor();
  await page.waitForTimeout(400);
  const val = (label) => dialog().getByLabel(label, { exact: false }).first().inputValue();
  const prefilled = {
    amount: await val("Advance amount"),
    factor: await val("Factor rate"),
    payment: await val("Remittance (each debit)"),
    how: await dialog().getByLabel("How often").inputValue(),
    funder: await val("Funder"),
    position: await val("Position"),
    term: await val("Estimated term (days)"),
    commission: await val("Your commission"),
  };
  check(
    "the Funded dialog is pre-filled from the accepted offer",
    prefilled.amount === "40000" &&
      prefilled.factor === "1.31" &&
      prefilled.payment === "400" &&
      prefilled.how === "daily" &&
      prefilled.funder === "Pearl Capital" &&
      prefilled.position === "2" &&
      prefilled.term === "120" &&
      prefilled.commission === "3200",
    JSON.stringify(prefilled),
  );
  await shot("08-funded-prefilled");
  const accepted = await rows(
    "select factor_rate::float8 factor, status from offers where client_id = $1 order by factor_rate",
    [merchant.id],
  );
  check(
    "accepting marked that offer accepted and turned the other down — before any funding exists",
    accepted[0].status === "accepted" && accepted[1].status === "declined",
    JSON.stringify(accepted),
  );
  const notFunded = await one("select count(*)::int n from fundings where client_id = $1", [
    merchant.id,
  ]);
  check("accepting does not fund by itself", notFunded.n === 0);
  await dialog().getByRole("button", { name: "Mark funded" }).click();
  await page
    .getByText(/Funded|funded/)
    .first()
    .waitFor({ timeout: 8000 });
  await dialog().waitFor({ state: "hidden" });
  const funded = await one(
    `select c.stage, f.amount_cents::int amt, f.factor_rate::float8 factor, f.payment_cents::int pay,
            f.frequency, f.funder_name, f.position_no, f.term_days, f.commission_cents::int commission
       from clients c join fundings f on f.client_id = c.id where c.id = $1`,
    [merchant.id],
  );
  check(
    "funding was recorded with the offer's terms and the client is Funded",
    funded?.stage === "funded" &&
      funded.amt === 4_000_000 &&
      funded.factor === 1.31 &&
      funded.pay === 40_000 &&
      funded.funder_name === "Pearl Capital" &&
      funded.position_no === 2 &&
      funded.term_days === 120 &&
      funded.commission === 320_000,
    JSON.stringify(funded),
  );

  // ---- scoreboard ----------------------------------------------------------------------------
  await page.goto(`${BASE}/funders`, { waitUntil: "networkidle" });
  const pearlCard = page
    .locator("section", { hasText: "Pearl Capital" })
    .filter({ hasText: "Approval rate" })
    .first();
  const libertasCard = page
    .locator("section", { hasText: "Libertas Funding" })
    .filter({ hasText: "Approval rate" })
    .first();
  const pearlText = await pearlCard.innerText();
  const libertasText = await libertasCard.innerText();
  check(
    "scoreboard: Pearl sent 1, 100% approved, average factor 1.325 from two offers",
    /Sent\s*1/.test(pearlText) &&
      pearlText.includes("100%") &&
      pearlText.includes("1.325") &&
      pearlText.includes("2 offers"),
    pearlText.replace(/\s+/g, " "),
  );
  check(
    "scoreboard: Libertas 0% with the decline reason",
    libertasText.includes("0%") && libertasText.includes("Revenue too low 1"),
    libertasText.replace(/\s+/g, " "),
  );
  await shot("09-funders-scoreboard");

  // ---- the unknown merchant: blank fields say "unknown", never "fails" ------------------------
  const blank = await one(
    `select c.id from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = 'Harbor Seafood'`,
    [email],
  );
  await page.goto(`${BASE}/clients/${blank.id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Send to funders" }).click();
  await dialog().waitFor();
  const blankText = (await dialog().innerText()).replace(/\s+/g, " ");
  check(
    "a merchant with blank revenue/state shows 'unknown' and 'Fits so far'",
    blankText.includes("revenue unknown") &&
      blankText.includes("Fits so far") &&
      blankText.includes("unknown"),
    blankText.slice(0, 500),
  );
  check(
    "industry Restaurant is flagged for the funder that skips restaurants (amber, still sendable)",
    blankText.includes("excludes restaurants"),
    blankText.slice(0, 500),
  );
  await shot("10-send-unknown");
  await page.keyboard.press("Escape");
  await browser.close();

  // ---- dark mode and a phone ------------------------------------------------------------------
  const dark = await openBrowser(email, { width: 1280, height: 900 }, { colorScheme: "dark" });
  await dark.page.goto(`${BASE}/clients/${merchant.id}`, { waitUntil: "networkidle" });
  await dark.page.screenshot({ path: `${SHOT_DIR}/11-dark-client.png`, fullPage: true });
  await dark.page.goto(`${BASE}/funders`, { waitUntil: "networkidle" });
  await dark.page.screenshot({ path: `${SHOT_DIR}/12-dark-funders.png`, fullPage: true });
  await dark.page.goto(`${BASE}/clients/${blank.id}`, { waitUntil: "networkidle" });
  await dark.page.getByRole("button", { name: "Send to funders" }).click();
  await dark.page.getByRole("dialog").waitFor();
  await dark.page.screenshot({ path: `${SHOT_DIR}/13-dark-send.png` });
  await dark.browser.close();

  const phone = await openBrowser(
    email,
    { width: 390, height: 800 },
    { hasTouch: true, isMobile: true },
  );
  for (const [name, url] of [
    ["14-phone-funders", `${BASE}/funders`],
    ["15-phone-client", `${BASE}/clients/${merchant.id}`],
  ]) {
    await phone.page.goto(url, { waitUntil: "networkidle" });
    const overflow = await phone.page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check(
      `phone ${url.replace(BASE, "")} has no horizontal overflow`,
      overflow <= 1,
      `${overflow}px`,
    );
    await phone.page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
  }
  await phone.page.goto(`${BASE}/clients/${blank.id}`, { waitUntil: "networkidle" });
  await phone.page.getByRole("button", { name: "Send to funders" }).click();
  await phone.page.getByRole("dialog").waitFor();
  await phone.page.screenshot({ path: `${SHOT_DIR}/16-phone-send.png` });
  const dlgOverflow = await phone.page.evaluate(() => {
    const d = document.querySelector("dialog");
    return d ? d.scrollWidth - d.clientWidth : 0;
  });
  check("phone Send dialog has no horizontal overflow", dlgOverflow <= 1, `${dlgOverflow}px`);
  await phone.browser.close();
}
