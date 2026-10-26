// Win-back, saved snippets, note → date chips, and add-to-calendar. Run: pnpm e2e winback
// (set SHOT_DIR=/some/folder to also save light / dark / 390px screenshots).
import { mkdirSync, readFileSync } from "node:fs";
import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);
const SHOT_DIR = process.env.SHOT_DIR;
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });
const bytes = (s) => Buffer.byteLength(s, "utf8");

/** Calendar math on "YYYY-MM-DD" strings, in UTC. */
const addDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const nextWeekday = (d, wd) => {
  const diff = (wd - new Date(`${d}T00:00:00Z`).getUTCDay() + 7) % 7;
  return addDays(d, diff === 0 ? 7 : diff);
};

export default async function winbackFlow({ email }) {
  const { browser, context, page } = await openBrowser(email);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });

  const today = await withDb((db) =>
    one(db, "select (now() at time zone 'America/New_York')::date::text as d", []),
  ).then((r) => r.d);
  const idOf = (name) =>
    withDb((db) =>
      one(
        db,
        "select c.id from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = $2",
        [email, name],
      ),
    ).then((r) => r.id);
  const userId = await withDb((db) =>
    one(db, "select id from app_users where email = $1", [email]),
  ).then((r) => r.id);

  // ---------------------------------------------------------------------------------------- setup
  const dnc = await idOf("Triple J Farms"); // declined, due in ~20 days — but asked us to stop
  const parkPlace = await idOf("Park Place Parking"); // lost to Rival Capital
  const oldTown = await idOf("Old Town Pubs"); // dead
  await withDb(async (db) => {
    // the competitor's advance is halfway through its 180-day term
    await db.query(
      "update competing_offers set offered_on = current_date - 90, term_days = 180, factor_rate = 1.42, won = true where client_id = $1",
      [parkPlace],
    );
  });

  // ------------------------------------------------------------------------------ the win-back list
  await page.goto(`${BASE}/winback?days=120`, { waitUntil: "networkidle" });
  check(
    "Win-back page loads",
    (await page.getByRole("heading", { name: "Win-back", exact: true }).count()) === 1,
  );
  const declinedText = await page
    .locator("article", { hasText: "Triple J Farms" })
    .locator("blockquote")
    .innerText();
  check(
    "a declined deal says 'may' and offers to resubmit (this merchant is listed before being marked do-not-contact)",
    /Your revenue may have grown since we last looked at Triple J Farms — want me to resubmit your \$90,000 request\?/.test(
      declinedText,
    ),
    declinedText,
  );
  await withDb((db) =>
    db.query("select * from set_contact_status($1, 'dnc', 'asked us to stop')", [dnc]),
  );
  await page.reload({ waitUntil: "networkidle" });
  check(
    "once marked do-not-contact, that merchant is not on the list at all",
    (await page.getByText("Triple J Farms").count()) === 0,
  );
  const dncRow = await withDb((db) =>
    one(db, "select contact_status, stage from clients where id = $1", [dnc]),
  );
  check(
    "…and that merchant really is a declined do-not-contact one in the database",
    dncRow.contact_status === "dnc" && dncRow.stage === "declined",
  );
  const ppRow = page.locator("article", { hasText: "Park Place Parking" });
  const ppText = await ppRow.locator("blockquote").innerText();
  check(
    "a lost deal gets a reason-aware text naming the rival and the factor rate",
    ppText.includes("Rival Capital's 1.42 advance should be about half paid by now") &&
      ppText.includes("want me to look at a renewal elsewhere?"),
    ppText,
  );
  const otRow = page.locator("article", { hasText: "Old Town Pubs" });
  check(
    "a dead deal asks if they are still looking for funding",
    (await otRow.locator("blockquote").innerText()).includes(
      "Been a while — still looking for funding?",
    ),
  );
  check(
    "batch is at most ten",
    (await page.locator("section[aria-label='Win-back 10'] article").count()) <= 10,
  );

  // ---------------------------------------------------- one-tap Text → the reason-aware message
  await ppRow.getByRole("button", { name: "Text Park Place Parking" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const msg = await dialog.locator("textarea").inputValue();
  check(
    "the Text dialog opens with the reason-aware message",
    msg === ppText.replace("Suggested text", "").trim(),
    msg,
  );
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/winback-text-dialog.png` });
  await dialog.getByRole("button", { name: /I sent it/ }).click();
  await page
    .getByRole("dialog")
    .getByText(/How did the text with Park Place Parking go/)
    .waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Sent — no reply yet" }).click();
  await page.getByRole("button", { name: "Log it" }).click();
  await page.getByText(/Logged — next follow-up/).waitFor({ timeout: 8000 });
  const touch = await withDb((db) =>
    one(
      db,
      "select kind, outcome, body from activities where client_id = $1 and kind = 'text' order by occurred_at desc limit 1",
      [parkPlace],
    ),
  );
  check(
    "the text is logged in the database",
    touch?.kind === "text" && touch?.outcome === "left_message",
  );
  await page.waitForTimeout(800);
  check(
    "the merchant leaves the batch once texted today",
    (await page
      .locator("section[aria-label='Win-back 10'] article", { hasText: "Park Place Parking" })
      .count()) === 0,
  );
  check(
    "'7 texts today'-style counter says 1 text today",
    (await page.getByTestId("text-counter").innerText()).includes("1 text today"),
  );

  // ------------------------------------------------------------------- the soft throttle counter
  await page.evaluate(
    ([d]) => localStorage.setItem("isaac:text-count", JSON.stringify({ date: d, n: 14 })),
    [today],
  );
  await page.reload({ waitUntil: "networkidle" });
  check(
    "14 texts: counted, and no warning yet",
    (await page.getByTestId("text-counter").innerText()).includes("14 texts today") &&
      (await page.getByText(/Google Voice may slow/).count()) === 0,
  );
  const nextCard = page.locator("section[aria-label='Win-back 10'] article").first();
  const nextName = (await nextCard.locator("a").first().innerText()).trim();
  await nextCard.getByRole("button", { name: `Text ${nextName}` }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /I sent it/ })
    .click();
  await page.getByRole("button", { name: /Skip/ }).click();
  await page.waitForTimeout(400);
  check(
    "the 15th text shows a gentle Google Voice warning",
    (await page.getByTestId("text-counter").innerText()).includes("15 texts today") &&
      (await page.getByText(/Google Voice may slow down/).count()) === 1,
  );
  await page.reload({ waitUntil: "networkidle" });
  check(
    "the count survives a reload",
    (await page.getByTestId("text-counter").innerText()).includes("15 texts today"),
  );
  await page.evaluate(() => localStorage.removeItem("isaac:text-count"));

  // ----------------------------------------------------------------------------------- "Not now"
  await page.reload({ waitUntil: "networkidle" });
  const snoozeCard = page.locator("section[aria-label='Win-back 10'] article", {
    hasText: "Old Town Pubs",
  });
  const beforeDue = await withDb((db) =>
    one(db, "select min(due_on)::text d from timers where client_id = $1 and done_at is null", [
      oldTown,
    ]),
  );
  await snoozeCard.getByRole("button", { name: "Not now" }).click();
  await page.getByText(/Old Town Pubs — back on/).waitFor({ timeout: 8000 });
  const afterDue = await withDb((db) =>
    one(db, "select min(due_on)::text d from timers where client_id = $1 and done_at is null", [
      oldTown,
    ]),
  );
  check(
    "'Not now' moves the follow-up just past the window, in the database",
    afterDue.d === addDays(today, 121) && afterDue.d > beforeDue.d,
    `${beforeDue.d} → ${afterDue.d}`,
  );
  await page.waitForTimeout(500);
  check(
    "…and the merchant leaves the list",
    (await page.locator("article", { hasText: "Old Town Pubs" }).count()) === 0,
  );

  // ------------------------------------------------------- Settings → Messages (defaults, then own)
  const rivera = await idOf("Rivera Auto Repair");
  const hartman = await idOf("Hartman Trucking");
  await page.goto(`${BASE}/clients/${rivera}`, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: /^Text Rivera/ })
    .first()
    .click();
  await page.getByRole("dialog").waitFor();
  await page.getByText("Snippets ▾").click();
  await page.getByRole("dialog").getByRole("button", { name: "Send application" }).waitFor();
  const titles = await page.getByRole("dialog").locator("details button").allInnerTexts();
  check(
    "until he saves his own, the six built-in snippets are offered",
    JSON.stringify(titles) ===
      JSON.stringify([
        "Send application",
        "Need statements",
        "Following up on offers",
        "Contract reminder",
        "Renewal check",
        "Win-back",
      ]),
    titles.join(" | "),
  );
  await page.getByRole("dialog").getByRole("button", { name: "Need statements" }).click();
  const filled = await page.getByRole("dialog").locator("textarea").inputValue();
  check(
    "a snippet fills the Text dialog with this merchant's details",
    filled.startsWith("Hey Tony, it's Isaac.") &&
      filled.includes("Rivera Auto Repair") &&
      !/[{}]/.test(filled),
    filled,
  );
  await page.getByText("Snippets ▾").click();
  await page.getByRole("dialog").getByRole("button", { name: "Send application" }).click();
  const withLink = await page.getByRole("dialog").locator("textarea").inputValue();
  check(
    "with no application link set, the field stays visible and is flagged — never blank",
    withLink.includes("{application_link}") &&
      (await page
        .getByRole("alert")
        .filter({ hasText: "still has {application_link}" })
        .count()) === 1,
    withLink,
  );
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  check(
    "Settings has the Messages card and keeps Reminders and Gmail",
    (await page.getByRole("heading", { name: "Messages" }).count()) === 1 &&
      (await page.getByRole("heading", { name: "Reminders" }).count()) === 1 &&
      (await page.getByRole("heading", { name: "Gmail" }).count()) === 1,
  );
  // signature + application link
  await page.getByLabel("Email signature").fill("Isaac Cohen\nCommercial funding · (305) 555-0100");
  await page.getByLabel("Application link").fill("not a link");
  await page.getByRole("button", { name: "Save signature and link" }).click();
  await page
    .getByText("Enter a full web address that starts with https://")
    .waitFor({ timeout: 8000 });
  const stillBlank = await withDb((db) =>
    one(db, "select signature, application_link from app_users where id = $1", [userId]),
  );
  check(
    "a bad link is refused in plain words and nothing is saved — typed text stays",
    stillBlank.signature === "" &&
      stillBlank.application_link === "" &&
      (await page.getByLabel("Email signature").inputValue()).startsWith("Isaac Cohen"),
  );
  await page.getByLabel("Application link").fill("https://apply.example.com/isaac");
  await page.getByRole("button", { name: "Save signature and link" }).click();
  await page.getByText("Message settings saved").waitFor({ timeout: 8000 });
  const savedSettings = await withDb((db) =>
    one(db, "select signature, application_link from app_users where id = $1", [userId]),
  );
  check(
    "signature and application link are saved in the database",
    savedSettings.signature === "Isaac Cohen\nCommercial funding · (305) 555-0100" &&
      savedSettings.application_link === "https://apply.example.com/isaac",
  );

  // a bad snippet keeps what was typed
  await page.getByRole("button", { name: "+ Add snippet" }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Name", { exact: true }).fill("Quick hello");
  await editor.locator("textarea").fill("Hi {firstname}, quick note about {business}");
  await editor.getByRole("button", { name: "Save snippet" }).click();
  await page
    .getByText(/\{firstname\} isn't a field I know/)
    .first()
    .waitFor({ timeout: 8000 });
  check(
    "an unknown field is refused, nothing is stored, and the typed message stays in the box",
    (
      await withDb((db) =>
        one(db, "select count(*)::int n from snippets where user_id = $1", [userId]),
      )
    ).n === 0 &&
      (await editor.locator("textarea").inputValue()).includes("{firstname}") &&
      (await editor.getByLabel("Name", { exact: true }).inputValue()) === "Quick hello",
  );
  await editor.locator("textarea").fill("Hi {first_name}, my SSN is 123-45-6789");
  await editor.getByRole("button", { name: "Save snippet" }).click();
  await page
    .getByText(/Social Security number/)
    .first()
    .waitFor({ timeout: 8000 });
  check(
    "a Social Security number in a snippet is refused",
    (
      await withDb((db) =>
        one(db, "select count(*)::int n from snippets where user_id = $1", [userId]),
      )
    ).n === 0,
  );
  await editor.locator("textarea").fill("Hi {first_name}, quick note about {business} — {sender}");
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/settings-snippet-editor.png` });
  await editor.getByRole("button", { name: "Save snippet" }).click();
  await page.getByText("Snippet saved").waitFor({ timeout: 8000 });
  const snip = await withDb((db) =>
    one(db, "select title, kind, body from snippets where user_id = $1", [userId]),
  );
  check(
    "a saved snippet is a real row",
    snip?.title === "Quick hello" &&
      snip?.kind === "text" &&
      snip?.body === "Hi {first_name}, quick note about {business} — {sender}",
    JSON.stringify(snip),
  );
  // a duplicate name is refused
  await page.getByRole("button", { name: "+ Add snippet" }).click();
  await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("quick hello");
  await page.getByRole("dialog").locator("textarea").fill("again");
  await page.getByRole("dialog").getByRole("button", { name: "Save snippet" }).click();
  await page.getByText(/You already have a text snippet called/).waitFor({ timeout: 8000 });
  check(
    "a second snippet with the same name is refused",
    (
      await withDb((db) =>
        one(db, "select count(*)::int n from snippets where user_id = $1", [userId]),
      )
    ).n === 1,
  );
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  if (SHOT_DIR)
    await page.screenshot({ path: `${SHOT_DIR}/settings-messages.png`, fullPage: true });

  // ------------------------------------------- his own snippet in the Text dialog, resolved
  await page.goto(`${BASE}/clients/${rivera}`, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: /^Text Rivera/ })
    .first()
    .click();
  await page.getByRole("dialog").waitFor();
  await page.getByText("Snippets ▾").click();
  await page.getByRole("dialog").getByRole("button", { name: "Quick hello" }).waitFor();
  const own = await page.getByRole("dialog").locator("details button").allInnerTexts();
  check(
    "once he has saved one, his list replaces the built-in ones",
    JSON.stringify(own) === JSON.stringify(["Quick hello"]),
    own.join(" | "),
  );
  await page.getByRole("dialog").getByRole("button", { name: "Quick hello" }).click();
  check(
    "his snippet fills the Text dialog",
    (await page.getByRole("dialog").locator("textarea").inputValue()) ===
      "Hi Tony, quick note about Rivera Auto Repair — Isaac",
  );
  await page.getByRole("button", { name: "Cancel" }).click();

  // ------------------------------------------- the Email dialog: signature and an email snippet
  await page.goto(`${BASE}/clients/${hartman}`, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: /^Email Hartman/ })
    .first()
    .click();
  await page.getByRole("dialog").waitFor();
  await page.getByText("Snippets ▾").click();
  await page.getByRole("dialog").getByRole("button", { name: "Send application" }).click();
  const subject = await page.getByRole("dialog").getByLabel("Subject").inputValue();
  const body = await page.getByRole("dialog").locator("#email-message").inputValue();
  check(
    "an email snippet sets the subject and fills the body, including the application link",
    subject === "Your application for Hartman Trucking" &&
      body.startsWith("Hi Dave,") &&
      body.includes("https://apply.example.com/isaac") &&
      !body.includes("Subject:"),
    `${subject} / ${body.slice(0, 60)}`,
  );
  const sig = await page.getByTestId("email-signature").innerText();
  check(
    "the signature is shown under the message",
    sig.startsWith("Isaac Cohen") && sig.includes("(305) 555-0100"),
    sig,
  );
  const gmailHref = await page
    .getByRole("link", { name: "Open in Gmail instead" })
    .getAttribute("href");
  const gmailBody = new URL(gmailHref).searchParams.get("body") ?? "";
  check(
    "the email that goes out ends with the signature, once",
    gmailBody.endsWith("Isaac Cohen\nCommercial funding · (305) 555-0100") &&
      gmailBody.split("Isaac Cohen").length === 2 &&
      !gmailBody.includes("Thanks,\nIsaac"),
  );
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/email-dialog.png` });
  await page
    .getByRole("dialog")
    .locator("#email-message")
    .fill("Hi Dave, apply here: {application_link} and {oops}");
  check(
    "a message with a field still in it is flagged and can't be opened in Gmail from here",
    (await page
      .getByRole("alert")
      .filter({ hasText: "still has {application_link}, {oops}" })
      .count()) === 1 &&
      (await page.getByRole("link", { name: "Open in Gmail instead" }).count()) === 0 &&
      (await page.getByText("Open in Gmail instead").getAttribute("aria-disabled")) === "true",
  );
  await page.getByRole("button", { name: "Cancel" }).click();

  // ------------------------------------------------------ notes → next date chips on the client page
  const before = await withDb((db) =>
    one(
      db,
      "select due_on::text d, id from timers where client_id = $1 and done_at is null and kind = 'follow_up'",
      [hartman],
    ),
  );
  await page
    .locator("#new-note")
    .fill("Wants 80k. Call back Friday after he talks to his dispatcher.");
  const friday = nextWeekday(today, 5);
  const chip = page.getByRole("button", {
    name: new RegExp(
      `^Friday ${new Date(`${friday}T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${Number(friday.slice(8))}`,
    ),
  });
  await chip.waitFor({ timeout: 5000 });
  const chipText = await chip.innerText();
  check(
    "typing 'call back Friday' offers a chip for that Friday",
    /^Friday [A-Z][a-z]{2} \d{1,2}$/.test(chipText),
    chipText,
  );
  const untouched = await withDb((db) =>
    one(
      db,
      "select due_on::text d from timers where client_id = $1 and done_at is null and kind = 'follow_up'",
      [hartman],
    ),
  );
  check(
    "a chip is only a suggestion: nothing changes until it is tapped",
    untouched.d === before.d,
  );
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/client-note-chip.png` });
  await chip.click();
  await page.getByText(/Follow-up set for/).waitFor({ timeout: 8000 });
  const after = await withDb((db) =>
    db
      .query(
        "select kind, due_on::text d, done_reason from timers where client_id = $1 order by created_at, id",
        [hartman],
      )
      .then((r) => r.rows),
  );
  const open = after.filter((r) => r.done_reason === null);
  check(
    "tapping the chip sets the follow-up: the open timer is that Friday",
    open.length === 1 && open[0].kind === "follow_up" && open[0].d === friday,
    JSON.stringify(after),
  );
  check(
    "…and the old follow-up was replaced, not left behind",
    after.some((r) => r.d === before.d && r.done_reason === "replaced"),
  );
  check("the chip now shows a check", (await chip.innerText()).endsWith("✓"));
  await page.getByRole("button", { name: "Save note" }).click();
  await page.getByText("Note saved").waitFor({ timeout: 8000 });
  const note = await withDb((db) =>
    one(
      db,
      "select body from activities where client_id = $1 and kind = 'note' order by occurred_at desc limit 1",
      [hartman],
    ),
  );
  check("the note itself is saved", note?.body.startsWith("Wants 80k. Call back Friday"));
  check(
    "the date suggestions stay tappable after the note is saved",
    (await page.getByText("From the note you just saved:").count()) === 1,
  );

  // a hot note
  await page.locator("#new-note").fill("He needs the money ASAP");
  await page.getByText("Sounds hot").waitFor({ timeout: 5000 });
  check(
    "a hot note is flagged",
    (await page.getByText("🔥 Sounds hot").count()) === 1 &&
      (await page.getByRole("button", { name: "Today" }).count()) >= 1,
  );
  await page.locator("#new-note").fill("great guy, has two trucks");
  await page.waitForTimeout(300);
  check(
    "a note with no date and no call-back offers nothing",
    (await page.getByRole("group", { name: "Suggested follow-up dates" }).count()) === 0,
  );
  await page.locator("#new-note").fill("");

  // ------------------------------------------- chips in the outcome prompt after a call
  const [popup] = await Promise.all([
    context.waitForEvent("page", { timeout: 5000 }).catch(() => null),
    page
      .getByRole("button", { name: /^Call Hartman/ })
      .first()
      .click(),
  ]);
  if (popup) await popup.close();
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Reached" }).click();
  await page.getByRole("dialog").locator("textarea").fill("Spoke again. Check back in 3 weeks.");
  const promptChip = page
    .getByRole("dialog")
    .getByRole("button", { name: /^\w+day [A-Z][a-z]{2} \d{1,2}/ });
  await promptChip.waitFor({ timeout: 5000 });
  check("the outcome prompt offers the date from the note", (await promptChip.count()) === 1);
  await promptChip.click();
  check(
    "tapping it picks the date (nothing is saved until Log it)",
    (await promptChip.innerText()).endsWith("✓"),
  );
  await page.getByRole("button", { name: "Log it" }).click();
  await page.getByText(/Logged — next follow-up/).waitFor({ timeout: 8000 });
  const threeWeeks = await withDb((db) =>
    one(
      db,
      "select due_on::text d from timers where client_id = $1 and done_at is null and kind = 'follow_up'",
      [hartman],
    ),
  );
  let expect3w = addDays(today, 21);
  const wd = new Date(`${expect3w}T00:00:00Z`).getUTCDay();
  if (wd === 6) expect3w = addDays(expect3w, 2);
  if (wd === 0) expect3w = addDays(expect3w, 1);
  check(
    "logging the call set the follow-up to the chip's date",
    threeWeeks.d === expect3w,
    `${threeWeeks.d} vs ${expect3w}`,
  );

  // ---------------------------------------------------------------- Add to calendar (.ics)
  await page.goto(`${BASE}/clients/${hartman}`, { waitUntil: "networkidle" });
  const when = `${addDays(today, 4)}T14:30`;
  await page.getByLabel(/^When/).fill(when);
  await page.getByLabel("What it's about").fill("Review offers");
  await page.getByRole("button", { name: "Book the call" }).click();
  await page.getByText("Call booked", { exact: true }).first().waitFor({ timeout: 8000 });
  const booked = await withDb((db) =>
    one(
      db,
      "select to_char(scheduled_call_at at time zone 'UTC', 'YYYYMMDD\"T\"HH24MISS\"Z\"') as utc, to_char((scheduled_call_at + interval '30 minutes') at time zone 'UTC', 'YYYYMMDD\"T\"HH24MISS\"Z\"') as utc_end from clients where id = $1",
      [hartman],
    ),
  );
  check("the call is booked in the database", Boolean(booked?.utc), JSON.stringify(booked));
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/client-booked-call.png` });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 8000 }),
    page.getByRole("button", { name: /Add to calendar/ }).click(),
  ]);
  check(
    "the download is named after the merchant",
    download.suggestedFilename() === "call-hartman-trucking.ics",
    download.suggestedFilename(),
  );
  const ics = readFileSync(await download.path(), "utf8");
  const lines = ics.split("\r\n");
  const flat = ics.replace(/\r\n /g, "").split("\r\n");
  check(
    "the .ics is a calendar with CRLF line endings throughout",
    lines[0] === "BEGIN:VCALENDAR" && ics.endsWith("END:VCALENDAR\r\n") && !/(?<!\r)\n/.test(ics),
  );
  check(
    "DTSTART is the booked time in UTC",
    flat.includes(`DTSTART:${booked.utc}`),
    flat.find((l) => l.startsWith("DTSTART")),
  );
  check("it runs 30 minutes", flat.includes(`DTEND:${booked.utc_end}`));
  check("SUMMARY is 'Call: Hartman Trucking'", flat.includes("SUMMARY:Call: Hartman Trucking"));
  const desc = flat.find((l) => l.startsWith("DESCRIPTION:Phone")) ?? "";
  check(
    "DESCRIPTION has the phone, what he wants, the topic, the last call note and the client page",
    desc.includes("Phone: (212) 555-0111") &&
      desc.includes("Wants: $80\\,000") &&
      desc.includes("About: Review offers") &&
      desc.includes("Last call note: Spoke again. Check back in 3 weeks.") &&
      desc.includes(`/clients/${hartman}`),
    desc,
  );
  check(
    "it has a 15-minute reminder",
    flat.includes("TRIGGER:-PT15M") && flat.includes("BEGIN:VALARM"),
  );
  check(
    "no line is over 75 octets",
    lines.every((l) => bytes(l) <= 75),
  );
  const gcal = await page.getByRole("link", { name: "Google Calendar" }).getAttribute("href");
  const gu = new URL(gcal);
  check(
    "the Google Calendar link is a filled-in template",
    gu.origin + gu.pathname === "https://calendar.google.com/calendar/render" &&
      gu.searchParams.get("action") === "TEMPLATE" &&
      gu.searchParams.get("text") === "Call: Hartman Trucking" &&
      gu.searchParams.get("dates") === `${booked.utc}/${booked.utc_end}` &&
      (gu.searchParams.get("details") ?? "").includes("(212) 555-0111"),
    gcal,
  );

  // ---------------------------------------------------------------- look: dark and a phone
  const shots = async (suffix) => {
    for (const [name, path] of [
      ["winback", `/winback?days=120`],
      ["settings", `/settings`],
      ["client", `/clients/${hartman}`],
    ]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check(`${name} has no sideways scroll (${suffix})`, overflow <= 0, `overflow ${overflow}px`);
      if (SHOT_DIR)
        await page.screenshot({ path: `${SHOT_DIR}/${name}-${suffix}.png`, fullPage: true });
    }
  };
  await page.emulateMedia({ colorScheme: "dark" });
  await shots("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await shots("390");
  // the dialogs on a phone
  await page.goto(`${BASE}/winback?days=120`, { waitUntil: "networkidle" });
  const firstCard = page.locator("section[aria-label='Win-back 10'] article").first();
  const firstName = (await firstCard.locator("a").first().innerText()).trim();
  await firstCard.getByRole("button", { name: `Text ${firstName}` }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByText("Snippets ▾").click();
  await page.waitForTimeout(300);
  const dlgOverflow = await page.evaluate(() => {
    const d = document.querySelector("dialog");
    return d ? d.scrollWidth - d.clientWidth : 0;
  });
  check("the Text dialog fits a 390px phone", dlgOverflow <= 0, `overflow ${dlgOverflow}px`);
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/text-dialog-390.png` });
  await browser.close();
}
