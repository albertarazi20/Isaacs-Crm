// Client page: notes, call outcomes, booked calls, follow-ups, ask, other advances, competing offers,
// stips, edit details, sensitive-data guard, mobile layout. Every check reads the DATABASE.
// A failing check is a finding for docs/ISSUES.md.   E2E_ONLY=stips pnpm -s e2e client   runs one section.
import { mkdirSync } from "node:fs";
import { BASE, check as libCheck, openBrowser, withDb } from "./lib.mjs";

// A section's checks are held back until it finishes, so a section that was wrecked by the dev server
// reloading the page (other crews are editing src/ while this runs) can be thrown away and run again once.
let held = null;
const check = (name, ok, detail = "") =>
  held ? (held.push([name, ok, detail]), ok) : libCheck(name, ok, detail);
const NAV = { loaded: 0, intended: 0 };
/** Counts page loads we asked for vs page loads that just happened. */
function trackNav(page) {
  const goto = page.goto.bind(page);
  const reload = page.reload.bind(page);
  page.goto = (...a) => ((NAV.intended += 1), goto(...a));
  page.reload = (...a) => ((NAV.intended += 1), reload(...a));
  page.on("load", () => (NAV.loaded += 1));
}

const SHOTS = process.env.E2E_SHOTS ?? "/tmp/e2e-shots/client";
mkdirSync(SHOTS, { recursive: true });
const ONLY = process.env.E2E_ONLY ?? "";

// ---- database helpers ---------------------------------------------------------------------
const rows = (sql, params = []) => withDb((db) => db.query(sql, params)).then((r) => r.rows);
const one = async (sql, params = []) => (await rows(sql, params))[0];
let USER = "";
const clientOf = (name) =>
  one(
    `select c.id, c.stage, c.phone, c.email, c.state, c.contact_name, c.business_name, c.industry, c.source,
            c.monthly_revenue_cents::int revenue, c.time_in_business_months months,
            to_char(c.scheduled_call_at at time zone 'America/New_York', 'YYYY-MM-DD"T"HH24:MI') call_at
       from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = $2`,
    [USER, name],
  );
const clientById = (id) =>
  one(
    `select c.id, c.stage, c.phone, c.email, c.state, c.contact_name, c.business_name, c.dba, c.industry, c.source,
            c.monthly_revenue_cents::int revenue, c.time_in_business_months months,
            to_char(c.scheduled_call_at at time zone 'America/New_York', 'YYYY-MM-DD"T"HH24:MI') call_at
       from clients c where c.id = $1`,
    [id],
  );
const openTimers = (id) =>
  rows(
    "select id, kind, due_on::text due_on, note from timers where client_id = $1 and done_at is null order by due_on, kind",
    [id],
  );
const followUps = async (id) => (await openTimers(id)).filter((t) => t.kind === "follow_up");
const activities = (id, kind) =>
  rows(
    "select kind, outcome, body from activities where client_id = $1 and kind = $2 order by occurred_at desc",
    [id, kind],
  );

// ---- independent date math (deliberately not imported from src/) -----------------------------
const iso = (d) => d.toISOString().slice(0, 10);
const utc = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => {
  const d = utc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const addMonths = (s, n) => {
  const [y, m, day] = s.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(ny, nm, Math.min(day, last))));
};
const addBDays = (s, n) => {
  let d = s;
  for (let left = n; left > 0;) {
    d = addDays(d, 1);
    const dow = utc(d).getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d;
};
const PRESETS = [
  ["1w", (t) => addDays(t, 7)],
  ["2w", (t) => addDays(t, 14)],
  ["1m", (t) => addMonths(t, 1)],
  ["2m", (t) => addMonths(t, 2)],
  ["3m", (t) => addMonths(t, 3)],
  ["6m", (t) => addMonths(t, 6)],
  ["9m", (t) => addMonths(t, 9)],
  ["12m", (t) => addMonths(t, 12)],
  ["18m", (t) => addMonths(t, 18)],
  ["24m", (t) => addMonths(t, 24)],
  ["36m", (t) => addMonths(t, 36)],
];

// ---- playwright helpers -----------------------------------------------------------------------
const firstLine = (e) => String(e instanceof Error ? e.message : e).split("\n")[0];
let SHOT_PAGE = null;
async function section(name, fn) {
  if (ONLY && !ONLY.split("|").some((o) => name.includes(o))) return;
  console.log(`\n-- ${name}`);
  const t0 = Date.now();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const before = NAV.loaded - NAV.intended;
    held = [];
    let crash = null;
    try {
      await fn();
    } catch (e) {
      crash = e;
    }
    const surprise = NAV.loaded - NAV.intended - before;
    if (crash && surprise > 0 && attempt === 1) {
      console.log(
        `   (the page was reloaded ${surprise}x behind our back — the dev server restarting while other crews edit src/. Throwing this attempt away and running the section once more.)`,
      );
      held = null;
      continue;
    }
    const mine = held;
    held = null;
    for (const [n, ok, d] of mine) libCheck(n, ok, d);
    if (surprise > 0)
      console.log(
        `   (note: ${surprise} unexpected page reload(s) happened during this section; a failure above may be that)`,
      );
    if (crash) {
      libCheck(`[${name}] ran to the end without crashing`, false, firstLine(crash));
      const at = String(crash?.stack ?? "")
        .split("\n")
        .find((l) => l.includes(".e2e.mjs:"));
      if (at) console.log(`   crashed at ${at.trim()}`);
      if (SHOT_PAGE) {
        const f = `${SHOTS}/crash-${name.replace(/[^a-z0-9]+/gi, "-")}.png`;
        await SHOT_PAGE.screenshot({ path: f })
          .then(() => console.log(`   screenshot of the page at the crash: ${f}`))
          .catch(() => undefined);
      }
    }
    break;
  }
  console.log(`   (${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
async function until(fn, timeout = 7000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 120));
  }
}
const shot = (page, name, full = false) =>
  page
    .screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full })
    .catch((e) => console.log("   shot failed", firstLine(e)));
const field = (scope, re) => scope.getByLabel(re);
const dialogOf = (page) => page.getByRole("dialog");
const panel = (page, title) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .first();
/** Next's route announcer is also role=alert (it holds the page title); error toasts are the other ones. Each toast is read once. */
const ALERT = '[role="alert"]:not(#__next-route-announcer__)';
async function alertText(page, timeout = 5000) {
  const loc = page.locator(`${ALERT}:not([data-seen])`).filter({ hasText: /\S/ }).first();
  const text = await loc.innerText({ timeout }).catch(() => "");
  if (text) await loc.evaluate((e) => e.setAttribute("data-seen", "1")).catch(() => undefined);
  return text;
}
/** Waits (no sleeping) until a panel's text matches. */
const panelHas = (p, re, timeout = 6000) =>
  until(async () => re.test(await p.innerText()), timeout).then((v) => !!v);
const gone = (loc, timeout = 8000) =>
  loc
    .waitFor({ state: "hidden", timeout })
    .then(() => true)
    .catch(() => false);

/** True once React has attached to the element: typing before that is wiped by hydration. */
const hydrated = (page, selector) =>
  page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return (
        !!el &&
        Object.keys(el).some((k) => k.startsWith("__reactProps") || k.startsWith("__reactFiber"))
      );
    },
    selector,
    { timeout: 15000 },
  );

async function openClient(page, id) {
  await page.goto(`${BASE}/clients/${id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 15000 });
  await hydrated(page, "#new-note");
  await page.evaluate(() =>
    document.querySelectorAll('[role="alert"]').forEach((e) => e.setAttribute("data-seen", "1")),
  );
}
/** Saves the open FormDialog and resolves true when it closed (i.e. the server accepted it). */
async function saveDialog(page, label = "Save") {
  const d = dialogOf(page);
  await d.getByRole("button", { name: label, exact: true }).click();
  return gone(d, 6000);
}
/** Elements smaller than 40px in either direction that a thumb must hit (checkbox hit area is its label). */
const tapAudit = (page) =>
  page.evaluate(() => {
    const out = [];
    const sel =
      'button, a[href], input:not([type=hidden]), select, textarea, summary, [role="button"]';
    for (const el of document.querySelectorAll(sel)) {
      const target = el.matches("input[type=checkbox], input[type=radio]")
        ? (el.closest("label") ?? el)
        : el;
      const r = target.getBoundingClientRect();
      const cs = getComputedStyle(target);
      if (cs.visibility === "hidden" || cs.display === "none" || r.width <= 1 || r.height <= 1)
        continue;
      if (r.bottom < 0 || r.top > document.documentElement.scrollHeight) continue;
      if (r.height < 40)
        out.push({
          label: (
            el.getAttribute("aria-label") ||
            el.textContent ||
            el.getAttribute("placeholder") ||
            el.getAttribute("type") ||
            ""
          )
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 26),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
    }
    return out;
  });

export default async function clientFlow({ email }) {
  USER = email;
  const tz = (await one("select timezone from app_users where email = $1", [email])).timezone;
  const today = (await one("select (now() at time zone $1)::date::text d", [tz])).d;
  console.log(`   Isaac's today is ${today} (${tz}), weekday ${utc(today).getUTCDay()}`);

  const { browser, context, page } = await openBrowser(email, { width: 1440, height: 900 });
  SHOT_PAGE = page;
  trackNav(page);
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error")
      consoleErrors.push(`${m.text().slice(0, 200)} @ ${m.location().url.replace(BASE, "")}`);
    if (/Fast Refresh|\[HMR\]/.test(m.text()) && !/connected/.test(m.text()))
      console.log(`   (dev server hot-reloaded the page: ${m.text().slice(0, 80)})`);
  });
  const badResponses = [];
  context.on(
    "response",
    (r) => r.status() >= 400 && badResponses.push(`${r.status()} ${r.url().replace(BASE, "")}`),
  );
  page.on(
    "framenavigated",
    (f) =>
      f === page.mainFrame() &&
      process.env.DEBUG_NAV &&
      console.log("   nav →", f.url().replace(BASE, "")),
  );
  // Call opens Google Voice in a new tab on desktop; nothing here should ever leave localhost.
  context.on("page", (p) => void p.close().catch(() => undefined));

  // =========================== 1. notes =============================================================
  await section("notes", async () => {
    const c = await clientOf("Hartman Trucking");
    await openClient(page, c.id);
    const box = page.getByLabel("New note");
    const save = page.getByRole("button", { name: "Save note" });
    check("Save note is disabled while the box is empty", await save.isDisabled());
    await box.fill("   \n  ");
    check("…and while it holds only spaces", await save.isDisabled());
    const text =
      "Dave says the dispatcher OK'd the two repairs.\nWants 80k, will send statements Monday.";
    await box.fill(text);
    await save.click();
    await page
      .getByText("Note saved")
      .waitFor({ timeout: 6000 })
      .catch(() => undefined);
    const rows1 = await activities(c.id, "note");
    check(
      "DB: activities row kind 'note' with the exact text (line break kept)",
      rows1.length === 1 && rows1[0].body === text,
      JSON.stringify(rows1),
    );
    const first = page.locator('section[aria-label="Notes and history"] ol > li').first();
    const t0 = Date.now();
    const top = await until(
      async () => (await first.innerText()).includes("dispatcher OK'd"),
      5000,
    );
    check(
      "the note is at the top of the timeline",
      !!top,
      `${Date.now() - t0}ms after the 'Note saved' toast; top entry: ${(await first.innerText()).replace(/\s+/g, " ").slice(0, 70)}`,
    );
    check("the box is cleared after saving", (await box.inputValue()) === "");
    // Newest first, Ctrl+Enter saves.
    await box.fill("Second note, saved from the keyboard");
    await box.press("Control+Enter");
    const ok = await until(async () => (await activities(c.id, "note")).length === 2);
    check("Ctrl+Enter saves the note", !!ok);
    const top2 = await until(
      async () =>
        (
          await page.locator('section[aria-label="Notes and history"] ol > li').first().innerText()
        ).includes("Second note"),
      5000,
    );
    check("newest note sits above the older one", !!top2);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByLabel("New note").waitFor();
    check(
      "after a reload both notes are still there, newest first",
      (
        await page.locator('section[aria-label="Notes and history"] ol > li').first().innerText()
      ).includes("Second note"),
    );
    const pill = await page.getByRole("button", { name: /^Notes \d+$/ }).innerText();
    check("the 'Notes' filter counts them", pill.includes("2"), pill);
    // Too long.
    await page.getByLabel("New note").fill("x".repeat(5001));
    await page.getByRole("button", { name: "Save note" }).click();
    const msg = await alertText(page);
    check(
      "a note over 5,000 characters is refused in plain words",
      /too long|5,?000|shorter/i.test(msg) && !/Too big|expected/i.test(msg),
      msg,
    );
    check("…and nothing was stored", (await activities(c.id, "note")).length === 2);
    check(
      "…and the text stays in the box so he can trim it",
      (await page.getByLabel("New note").inputValue()).length === 5001,
    );
    await shot(page, "client-notes");
  });

  // =========================== 2. calls ==============================================================
  await section("call outcomes", async () => {
    const c = await clientOf("Sunrise Dental");
    await openClient(page, c.id);
    const callBtn = page.getByRole("button", { name: /^Call Sunrise/ }).first();
    const prompt = () => dialogOf(page).filter({ hasText: "How did the call with" });
    const stageOwn = addBDays(today, 2); // spoke_with_owner: its own pace is 2 business days
    const cases = [
      ["Reached", "reached", stageOwn, "Wants to move forward"],
      ["No answer", "no_answer", addBDays(today, 1), ""],
      ["Left message", "left_message", addBDays(today, 2), "Left a voicemail about the app"],
      ["Bad number", "bad_number", addDays(today, 7), "Disconnected"],
    ];
    for (const [label, key, want, note] of cases) {
      const before = (await activities(c.id, "call")).length;
      await callBtn.click();
      await prompt().waitFor({ timeout: 5000 });
      const d = prompt();
      check(
        `[${label}] 'Log it' is disabled until an outcome is picked`,
        await d.getByRole("button", { name: "Log it" }).isDisabled(),
      );
      await d.getByRole("button", { name: label, exact: true }).click();
      const shown = await d.getByLabel("Follow-up date").inputValue();
      check(`[${label}] the prompt suggests ${want}`, shown === want, `shows ${shown}`);
      if (note) await d.getByLabel(/^Notes/).fill(note);
      await d.getByRole("button", { name: "Log it" }).click();
      await gone(prompt(), 6000);
      const ok = await until(async () => (await activities(c.id, "call")).length === before + 1);
      const act = (await activities(c.id, "call"))[0];
      check(
        `[${label}] DB: call activity with outcome ${key}${note ? " and his note" : ""}`,
        !!ok && act.outcome === key && act.body === note,
        JSON.stringify(act),
      );
      const f = await followUps(c.id);
      check(
        `[${label}] DB: the one open follow-up is now ${want} (the date the prompt suggested)`,
        f.length === 1 && f[0].due_on === want,
        JSON.stringify(f.map((x) => x.due_on)),
      );
    }
    const firstLi = page.locator('section[aria-label="Notes and history"] ol > li').first();
    const topOk = await until(async () => /Bad number/.test(await firstLi.innerText()), 5000);
    check(
      "the latest call shows at the top of the timeline with its outcome badge",
      !!topOk,
      (await firstLi.innerText()).replace(/\s+/g, " ").slice(0, 80),
    );
    const header = await page
      .getByText(/^Last call/)
      .first()
      .innerText()
      .catch(() => "");
    check(
      "'Last call' header at the top of the timeline shows a call just logged",
      /just now|min ago/.test(header),
      header,
    );

    // Pick his own date first, then an outcome: the outcome must not overwrite it.
    await callBtn.click();
    await prompt().waitFor({ timeout: 5000 });
    await prompt().getByRole("button", { name: "2m", exact: true }).click();
    await prompt().getByRole("button", { name: "Reached", exact: true }).click();
    const kept = await prompt().getByLabel("Follow-up date").inputValue();
    check(
      "a date he picked himself is not overwritten when he then picks an outcome",
      kept === addMonths(today, 2),
      kept,
    );
    await prompt().getByRole("button", { name: "Log it" }).click();
    await gone(prompt(), 6000);
    const ok2 = await until(async () =>
      (await followUps(c.id)).some((t) => t.due_on === addMonths(today, 2)),
    );
    check(
      "DB: and it is saved as the follow-up",
      !!ok2,
      JSON.stringify((await followUps(c.id)).map((t) => t.due_on)),
    );

    // Skip: nothing changes.
    const tBefore = JSON.stringify(await openTimers(c.id));
    const aBefore = (
      await rows("select count(*)::int n from activities where client_id = $1", [c.id])
    )[0].n;
    await callBtn.click();
    await prompt().waitFor({ timeout: 5000 });
    await prompt().getByRole("button", { name: /^Skip/ }).click();
    check("Skip closes the prompt", await gone(prompt(), 4000));
    await until(async () => false, 500);
    const aAfter = (
      await rows("select count(*)::int n from activities where client_id = $1", [c.id])
    )[0].n;
    check(
      "Skip: no activity row, timers byte-for-byte the same",
      aBefore === aAfter && tBefore === JSON.stringify(await openTimers(c.id)),
      `${aBefore}→${aAfter}`,
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await until(async () => false, 600);
    check(
      "after Skip the prompt does not come back on reload",
      (await prompt().count()) === 0 || !(await prompt().isVisible()),
    );

    // He closes the tab after tapping Call: the prompt is waiting when he comes back.
    await page
      .getByRole("button", { name: /^Call Sunrise/ })
      .first()
      .click();
    await prompt().waitFor({ timeout: 5000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    const back = await prompt()
      .waitFor({ timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    check("tap Call, reload: the outcome prompt is still waiting", back);
    if (back) await prompt().getByRole("button", { name: /^Skip/ }).click();

    // Notes in the prompt go through the same sensitive-data guard.
    await page
      .getByRole("button", { name: /^Call Sunrise/ })
      .first()
      .click();
    await prompt().waitFor({ timeout: 5000 });
    await prompt().getByRole("button", { name: "Reached", exact: true }).click();
    await prompt()
      .getByLabel(/^Notes/)
      .fill("SSN is 123-45-6789");
    await prompt().getByRole("button", { name: "Log it" }).click();
    const msg = await alertText(page);
    check(
      "a call note with an SSN is refused in plain words and the prompt stays",
      /Social Security/.test(msg) && (await prompt().isVisible()),
      msg,
    );
    check(
      "DB: the SSN call was not logged",
      (await activities(c.id, "call")).every((a) => !a.body.includes("123-45")),
    );
    await prompt().getByRole("button", { name: /^Skip/ }).click();

    // Text.
    const t0 = (await activities(c.id, "text")).length;
    await page
      .getByRole("button", { name: /^Text Sunrise/ })
      .first()
      .click();
    await dialogOf(page)
      .getByRole("button", { name: /I sent it/ })
      .click();
    const tp = dialogOf(page).filter({ hasText: "How did the text with" });
    await tp.waitFor({ timeout: 5000 });
    check(
      "a text offers 'They replied / Sent — no reply yet / Bad number' (no 'No answer')",
      (await tp.getByRole("button", { name: "They replied" }).count()) === 1 &&
        (await tp.getByRole("button", { name: "No answer" }).count()) === 0,
    );
    await tp.getByRole("button", { name: "They replied" }).click();
    await tp.getByRole("button", { name: "Log it" }).click();
    await gone(tp, 6000);
    const ok3 = await until(async () => (await activities(c.id, "text")).length === t0 + 1);
    check(
      "DB: text activity with outcome reached",
      !!ok3 && (await activities(c.id, "text"))[0].outcome === "reached",
    );
    await shot(page, "client-after-calls");
  });

  // =========================== 3. booked call =========================================================
  await section("book and cancel a call", async () => {
    const c = await clientOf("Green Leaf Market");
    await openClient(page, c.id);
    const at = `${addDays(today, 1)}T10:30`;
    const p = panel(page, "Next follow-up");
    check(
      "the 'Set … reminder' button is disabled until a time is chosen",
      await p.getByRole("button", { name: /^Set (call|text|email) reminder$/ }).isDisabled(),
    );
    // the picker is a day plus an hour / minute / AM-PM chooser
    const pickReminder = async (day, hour, minute, ampm) => {
      await p.getByLabel(/^Day/).fill(day);
      await p.getByRole("button", { name: "Time of day", exact: true }).click();
      await p
        .getByRole("group", { name: "Hour" })
        .getByRole("button", { name: hour, exact: true })
        .click();
      await p
        .getByRole("group", { name: "Minute" })
        .getByRole("button", { name: minute, exact: true })
        .click();
      await p
        .getByRole("group", { name: "AM or PM" })
        .getByRole("button", { name: ampm, exact: true })
        .click();
    };
    await pickReminder(addDays(today, 1), "10", "30", "AM");
    await p.getByLabel("What it's about").fill("Review the two offers");
    await p.getByRole("button", { name: /^Set (call|text|email) reminder$/ }).click();
    await page
      .getByText(/reminder set/)
      .first()
      .waitFor({ timeout: 6000 })
      .catch(() => undefined);
    const ok = await until(async () => (await clientById(c.id)).call_at === at);
    const after = await clientById(c.id);
    check(
      "DB: clients.scheduled_call_at is the time he typed (in his timezone)",
      !!ok,
      `db ${after.call_at}, typed ${at}`,
    );
    const t = await openTimers(c.id);
    check(
      "DB: an open scheduled_call timer on that day",
      t.some(
        (x) =>
          x.kind === "scheduled_call" &&
          x.due_on === addDays(today, 1) &&
          x.note === "Review the two offers",
      ),
      JSON.stringify(t.map((x) => `${x.kind}:${x.due_on}`)),
    );
    check(
      "DB: a client still in early prospecting stays in Interested ('Phone call scheduled' folds into it)",
      after.stage === "interested" || after.stage === "call_scheduled",
      after.stage,
    );
    const badge = await p
      .getByText(/Scheduled call|Call booked/)
      .first()
      .innerText()
      .catch(() => "");
    check(
      "the panel shows the scheduled call with a Cancel button",
      /Scheduled call|Call booked/.test(badge) &&
        (await p.getByRole("button", { name: /^Cancel/ }).count()) >= 1,
      badge,
    );
    check(
      "the booked time reads as he typed it (10:30 AM)",
      /10:30 AM/.test(await p.innerText()),
      (await p.innerText()).replace(/\s+/g, " ").slice(-120),
    );

    // A logged call today is not THE booked call (that is tomorrow): the booking must survive.
    await page
      .getByRole("button", { name: /^Call Green/ })
      .first()
      .click();
    const prompt = dialogOf(page).filter({ hasText: "How did the call with" });
    await prompt.waitFor({ timeout: 5000 });
    await prompt.getByRole("button", { name: "No answer", exact: true }).click();
    await prompt.getByRole("button", { name: "Log it" }).click();
    await gone(prompt, 6000);
    await until(async () => (await activities(c.id, "call")).length === 1);
    const t2 = await openTimers(c.id);
    check(
      "DB: logging an unrelated call today leaves tomorrow's booked call in place",
      (await clientById(c.id)).call_at === at && t2.some((x) => x.kind === "scheduled_call"),
      JSON.stringify(t2.map((x) => `${x.kind}:${x.due_on}`)),
    );

    // Re-book: only one booking at a time.
    const at2 = `${addDays(today, 2)}T15:00`;
    await pickReminder(addDays(today, 2), "3", "00", "PM");
    await p.getByRole("button", { name: /^Set (call|text|email) reminder$/ }).click();
    await until(async () => (await clientById(c.id)).call_at === at2);
    const sc = (await openTimers(c.id)).filter((x) => x.kind === "scheduled_call");
    check(
      "DB: booking again replaces the first one (exactly one open scheduled_call)",
      sc.length === 1 && sc[0].due_on === addDays(today, 2),
      JSON.stringify(sc),
    );

    // Cancel.
    await p.getByRole("button", { name: /^Cancel/ }).click();
    await page
      .getByText("Call cancelled")
      .first()
      .waitFor({ timeout: 6000 })
      .catch(() => undefined);
    const ok2 = await until(async () => (await clientById(c.id)).call_at === null);
    const t3 = await openTimers(c.id);
    check(
      "DB: cancelling clears scheduled_call_at and the scheduled_call timer",
      !!ok2 && !t3.some((x) => x.kind === "scheduled_call"),
      JSON.stringify(t3.map((x) => `${x.kind}:${x.due_on}`)),
    );
    check(
      "DB: …and he still has a next date (nobody falls off)",
      t3.length >= 1,
      `${t3.length} open timers`,
    );
    const log = await rows(
      "select body from activities where client_id = $1 and kind = 'timer' order by occurred_at desc limit 3",
      [c.id],
    );
    check(
      "the timeline records 'Call cancelled'",
      log.some((r) => r.body === "Call cancelled"),
      JSON.stringify(log),
    );
    check(
      "a cancelled call takes him out of 'Phone call scheduled'",
      (await clientById(c.id)).stage !== "call_scheduled",
      `stage is still ${(await clientById(c.id)).stage} with no call booked`,
    );

    // A time in the past.
    await pickReminder(addDays(today, -3), "9", "00", "AM");
    await p.getByRole("button", { name: /^Set (call|text|email) reminder$/ }).click();
    const msg = await alertText(page);
    // the day picker refuses past days itself (min = today); when a past value gets through anyway the server says so
    const nativeRefusal = await p
      .getByLabel(/^Day/)
      .evaluate((el) => el.validationMessage)
      .catch(() => "");
    const unchanged = (await clientById(c.id)).call_at === null;
    check(
      "booking a call three days ago is refused (the day picker's own validation, or the server in plain words about a CALL)",
      (nativeRefusal.length > 0 && unchanged) ||
        (msg.length > 0 && /call|past|earlier/i.test(msg) && !/follow-up date/i.test(msg)),
      msg || nativeRefusal,
    );
    check("DB: …and nothing was booked", (await clientById(c.id)).call_at === null);
    await shot(page, "client-booked-call");
  });

  // =========================== 4. follow-up presets ===================================================
  await section("follow-up presets, custom date, limits", async () => {
    const c = await clientOf("Mike's Pizza");
    await openClient(page, c.id);
    const p = panel(page, "Next follow-up");
    const group = p.getByRole("group", { name: "Follow-up in" });
    for (const [key, due] of PRESETS) {
      const want = due(today);
      await group.getByRole("button", { name: key, exact: true }).click();
      check(
        `[${key}] the date box shows ${want}`,
        (await p.getByLabel("Follow-up date").inputValue()) === want,
      );
      await p.getByRole("button", { name: "Set follow-up", exact: true }).click();
      const ok = await until(async () => {
        const f = await followUps(c.id);
        return f.length === 1 && f[0].due_on === want;
      });
      check(
        `[${key}] DB: exactly one open follow-up on ${want}`,
        !!ok,
        JSON.stringify((await followUps(c.id)).map((x) => x.due_on)),
      );
    }
    const shown = await p.innerText();
    check(
      "the panel lists the follow-up with its date and how far off it is",
      /Oct 23, 2029|in 3 years|in 36 months/.test(shown) ||
        shown.includes(String(addMonths(today, 36).slice(0, 4))),
      shown.replace(/\s+/g, " ").slice(0, 120),
    );
    // Custom date.
    const custom = addDays(today, 100);
    await p.getByLabel("Follow-up date").fill(custom);
    await p.getByRole("button", { name: "Set follow-up", exact: true }).click();
    const ok = await until(async () => (await followUps(c.id)).some((t) => t.due_on === custom));
    check(
      `custom date ${custom} saves`,
      !!ok,
      JSON.stringify((await followUps(c.id)).map((x) => x.due_on)),
    );
    // 36 months is the limit; one day beyond, and 37 months, are refused.
    const keep = custom;
    const limit = addMonths(today, 37);
    await p.getByLabel("Follow-up date").fill(limit);
    await p.getByRole("button", { name: "Set follow-up", exact: true }).click();
    const msg = await alertText(page);
    check("37 months out is refused in plain words", /36 months/.test(msg), msg);
    check(
      "DB: …and the follow-up is unchanged",
      (await followUps(c.id)).length === 1 && (await followUps(c.id))[0].due_on === keep,
    );
    await p.getByLabel("Follow-up date").fill(addDays(addMonths(today, 36), 1));
    await p.getByRole("button", { name: "Set follow-up", exact: true }).click();
    const msg2 = await until(async () => (await alertText(page, 800)) || null, 4000);
    check(
      "one day past 36 months is refused too",
      /36 months/.test(msg2 ?? ""),
      msg2 ?? "no message",
    );
    await p.getByLabel("Follow-up date").fill(addDays(today, -3));
    await p.getByRole("button", { name: "Set follow-up", exact: true }).click();
    const msg3 = await until(async () => (await alertText(page, 800)) || null, 4000);
    check(
      "a date in the past is refused in plain words",
      /past/.test(msg3 ?? ""),
      msg3 ?? "no message",
    );
    check(
      "DB: still exactly one open follow-up, unchanged",
      (await followUps(c.id)).length === 1 && (await followUps(c.id))[0].due_on === keep,
    );
    const nTimer = (
      await rows("select count(*)::int n from activities where client_id = $1 and kind = 'timer'", [
        c.id,
      ])
    )[0].n;
    check(
      "each saved follow-up left a line in the timeline",
      nTimer >= PRESETS.length + 1,
      `${nTimer} timer activities`,
    );
  });

  // =========================== 5. the ask =============================================================
  await section("the ask", async () => {
    const c = await clientOf("Mike's Pizza");
    await openClient(page, c.id);
    const p = panel(page, "The ask");
    const asks = () =>
      rows(
        "select wanted_amount_cents::int wanted, est_approval_cents::int est, wanted_terms, est_approval_note from client_asks where client_id = $1 order by created_at",
        [c.id],
      );
    check("precondition: no ask recorded yet", (await asks()).length === 0);
    await p.getByRole("button", { name: "Record the ask" }).click();
    let d = dialogOf(page);
    await field(d, /^How much he wants/).fill("$50,000");
    await field(d, /^The offer he wants/).fill("6 months, daily");
    await field(d, /^What I think funders would approve/).fill("30k");
    await field(d, /^Why/).fill("Thin August deposits");
    check("the ask saves", await saveDialog(page));
    let a = await asks();
    check(
      "DB: one client_asks row — wanted $50,000, estimate $30,000, terms and reason",
      a.length === 1 &&
        a[0].wanted === 5_000_000 &&
        a[0].est === 3_000_000 &&
        a[0].wanted_terms === "6 months, daily" &&
        a[0].est_approval_note === "Thin August deposits",
      JSON.stringify(a),
    );
    check("the card shows $50,000", await panelHas(p, /\$50,000/));
    await p.getByRole("button", { name: "Edit", exact: true }).click();
    d = dialogOf(page);
    check(
      "the dialog starts from what he saved",
      (await field(d, /^How much he wants/).inputValue()) === "50000",
    );
    await field(d, /^How much he wants/).fill("60k");
    await field(d, /^What I think funders would approve/).fill("45k");
    check("changing the ask saves", await saveDialog(page));
    a = await asks();
    check(
      "DB: BOTH snapshots exist — $50,000 then $60,000 (history kept, not overwritten)",
      a.length === 2 &&
        a[0].wanted === 5_000_000 &&
        a[1].wanted === 6_000_000 &&
        a[1].est === 4_500_000,
      JSON.stringify(a),
    );
    const card = await one(
      "select wanted_amount_cents::int w, est_approval_cents::int e from client_cards where id = $1",
      [c.id],
    );
    check(
      "DB: the client card reads the newest ask ($60,000 / est $45,000)",
      card.w === 6_000_000 && card.e === 4_500_000,
      JSON.stringify(card),
    );
    check(
      "the card now shows $60,000 and the earlier ask under 'in the past'",
      (await panelHas(p, /\$60,000/)) && (await panelHas(p, /in the past \(1\)/)),
    );
    await p.getByText(/How much he wanted in the past/).click();
    check(
      "the earlier ask shows $50,000 with its date",
      /Wanted \$50,000/.test(await p.innerText()),
    );
    // Bad input.
    await p.getByRole("button", { name: "Edit", exact: true }).click();
    d = dialogOf(page);
    await field(d, /^How much he wants/).fill("abc");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    const msg = await alertText(page);
    check("an amount of 'abc' is refused with an example", /50k|amount/i.test(msg), msg);
    await field(d, /^How much he wants/).fill("0");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    const msg0 = await until(async () => (await alertText(page, 700)) || null, 3000);
    check(
      "an amount of 0 is refused in plain words",
      !!msg0 && !/went wrong|isn't allowed/i.test(msg0),
      msg0 ?? "it was accepted",
    );
    check(
      "DB: neither bad save added a snapshot",
      (await asks()).length === (msg0 ? 2 : 3),
      `${(await asks()).length} rows`,
    );
    await d.getByRole("button", { name: "Cancel" }).click();
    // Free-text 'terms' is a one-line field: is it guarded like notes?
    await p.getByRole("button", { name: "Edit", exact: true }).click();
    d = dialogOf(page);
    await field(d, /^The offer he wants/).fill("SSN 123-45-6789, 6 months");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    const sens = await until(async () => (await alertText(page, 700)) || null, 3000);
    const stored = await one(
      "select count(*)::int n from client_asks where client_id = $1 and wanted_terms like '%123-45-6789%'",
      [c.id],
    );
    check(
      "an SSN typed into the ask's 'terms' line is refused, not stored",
      stored.n === 0,
      sens ?? `STORED in client_asks.wanted_terms (${stored.n} row)`,
    );
    if (
      await dialogOf(page)
        .isVisible()
        .catch(() => false)
    )
      await dialogOf(page).getByRole("button", { name: "Cancel" }).click();
    await shot(page, "client-ask");
  });

  // =========================== 6. other advances ======================================================
  await section("other advances (positions)", async () => {
    const c = await clientOf("Mike's Pizza");
    await openClient(page, c.id);
    const p = panel(page, "Other advances");
    const pos = () =>
      rows(
        `select id, position_no, funder_name, funded_amount_cents::int amount, payback_cents::int payback, balance_cents::int balance,
                payment_cents::int payment, frequency, funded_on::text funded_on, note from positions where client_id = $1 order by position_no`,
        [c.id],
      );
    check(
      "empty state says a new advance would be 1st position",
      /1st position/.test(await p.innerText()),
    );
    await p.getByRole("button", { name: "+ Add" }).click();
    let d = dialogOf(page);
    check("a new position starts at 1", (await field(d, /^Position/).inputValue()) === "1");
    await field(d, /^Funder/).fill("Libertas");
    await field(d, /^Advance amount taken/).fill("40k");
    await field(d, /^Total payback/).fill("54.8k");
    await field(d, /^Balance still owed/).fill("21k");
    await field(d, /^Date funded/).fill(addDays(today, -60));
    await field(d, /^Remittance/).fill("450");
    await field(d, /^How often/).selectOption({ label: "Daily" });
    await field(d, /^Note/).fill("Paying on time");
    check("the position saves", await saveDialog(page));
    let r = await pos();
    check(
      "DB: positions row has funder, amount, payback, balance, remittance, frequency, date and note",
      r.length === 1 &&
        r[0].funder_name === "Libertas" &&
        r[0].amount === 4_000_000 &&
        r[0].payback === 5_480_000 &&
        r[0].balance === 2_100_000 &&
        r[0].payment === 45_000 &&
        r[0].frequency === "daily" &&
        r[0].funded_on === addDays(today, -60) &&
        r[0].note === "Paying on time" &&
        r[0].position_no === 1,
      JSON.stringify(r),
    );
    await panelHas(p, /61\.7% paid down/);
    const txt = await p.innerText();
    check(
      "the panel rolls up 1 position, $21,000 owed, 61.7% paid down; next would be 2nd",
      /1 position/.test(txt) &&
        /\$21,000 still owed/.test(txt) &&
        /61\.7% paid down/.test(txt) &&
        /2nd position/.test(txt),
      txt.replace(/\s+/g, " ").slice(0, 200),
    );
    // Edit.
    await p.getByRole("button", { name: "Edit", exact: true }).click();
    d = dialogOf(page);
    check(
      "edit starts from the saved values",
      (await field(d, /^Balance still owed/).inputValue()) === "21000" &&
        (await field(d, /^Funder/).inputValue()) === "Libertas",
    );
    await field(d, /^Balance still owed/).fill("10k");
    check("the edit saves", await saveDialog(page));
    await panelHas(p, /\$10,000 still owed/);
    r = await pos();
    check(
      "DB: balance updated to $10,000 on the same row",
      r.length === 1 && r[0].balance === 1_000_000,
      JSON.stringify(r.map((x) => x.balance)),
    );
    // Second position, no payback.
    await p.getByRole("button", { name: "+ Add" }).click();
    d = dialogOf(page);
    check("the next position starts at 2", (await field(d, /^Position/).inputValue()) === "2");
    await field(d, /^Funder/).fill("Cobalt Capital");
    await field(d, /^Advance amount taken/).fill("25k");
    await field(d, /^Balance still owed/).fill("30k");
    await saveDialog(page);
    await panelHas(p, /Cobalt Capital/);
    r = await pos();
    check(
      "DB: two positions, the second without a payback",
      r.length === 2 && r[1].funder_name === "Cobalt Capital" && r[1].payback === null,
      JSON.stringify(r.map((x) => `${x.position_no}:${x.funder_name}`)),
    );
    check(
      "the card's own line for the one without payback does not invent a %",
      !/Cobalt[\s\S]{0,80}% paid down/.test(
        await p.locator("li").filter({ hasText: "Cobalt" }).innerText(),
      ),
      (await p.locator("li").filter({ hasText: "Cobalt" }).innerText()).replace(/\s+/g, " "),
    );
    // Validation.
    await p.getByRole("button", { name: "+ Add" }).click();
    d = dialogOf(page);
    await field(d, /^Position/).fill("0");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    const posBox = field(d, /^Position/);
    const pv = await posBox.evaluate((el) => ({
      bad: !el.validity.valid,
      msg: el.validationMessage,
    }));
    const toastMsg = await alertText(page, 800);
    check(
      "position 0 is refused in plain words (browser tooltip or our own message) and the dialog stays",
      (await d.isVisible()) && (pv.bad || /1 to 20/.test(toastMsg)),
      `browser says "${pv.msg}", toast "${toastMsg}"`,
    );
    await field(d, /^Position/).fill("3");
    await field(d, /^Advance amount taken/).fill("abc");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    const m2 = await until(async () => (await alertText(page, 700)) || null, 3000);
    check(
      "an advance amount of 'abc' is refused with an example",
      /50k|amount/i.test(m2 ?? ""),
      m2 ?? "no message",
    );
    await field(d, /^Advance amount taken/).fill("20k");
    await field(d, /^Total payback/).fill("10k");
    await field(d, /^Balance still owed/).fill("50k");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    const closed = await gone(d, 2500);
    const bad = await pos();
    check(
      "a payback smaller than the advance, and a balance bigger than the payback, are questioned",
      !closed && bad.length === 2,
      closed ? "saved silently: amount $20k, payback $10k, balance $50k" : "refused",
    );
    if (await d.isVisible().catch(() => false))
      await d.getByRole("button", { name: "Cancel" }).click();
    else await rows("delete from positions where client_id = $1 and position_no = 3", [c.id]); // tidy up the silently-saved one
    await openClient(page, c.id);
    // Delete needs a second click.
    await p
      .locator("li")
      .filter({ hasText: "Libertas" })
      .getByRole("button", { name: "Edit" })
      .click();
    d = dialogOf(page);
    await d.getByRole("button", { name: "Delete", exact: true }).click();
    check(
      "one click on Delete asks to confirm",
      (await d.getByRole("button", { name: "Click again to delete" }).count()) === 1,
    );
    check(
      "DB: still there after the first click",
      (await pos()).some((x) => x.funder_name === "Libertas"),
    );
    await d.getByRole("button", { name: "Click again to delete" }).click();
    await gone(d, 6000);
    const ok = await until(async () => !(await pos()).some((x) => x.funder_name === "Libertas"));
    check(
      "DB: the position is gone after the second click",
      !!ok,
      JSON.stringify((await pos()).map((x) => x.funder_name)),
    );
    check(
      "DB: the other position is untouched",
      (await pos()).some((x) => x.funder_name === "Cobalt Capital"),
    );
    await shot(page, "client-positions");
  });

  // =========================== 7. competing offers ====================================================
  await section("competing offers", async () => {
    const c = await clientOf("Mike's Pizza");
    await openClient(page, c.id);
    const p = panel(page, "Competing offers");
    const offers = () =>
      rows(
        `select id, funder_name, amount_cents::int amount, factor_rate::float factor, payment_cents::int payment, frequency, position_no,
                term_days, offered_on::text offered_on, won, note from competing_offers where client_id = $1 order by created_at`,
        [c.id],
      );
    await p.getByRole("button", { name: "+ Add" }).click();
    let d = dialogOf(page);
    await field(d, /^Funder/).fill("Pearl Funding");
    await field(d, /^Advance amount/).fill("45k");
    await field(d, /^Factor rate/).fill("1.34");
    await field(d, /^Remittance/).fill("400");
    await field(d, /^How often/).selectOption({ label: "Daily" });
    await field(d, /^Position/).fill("1");
    await field(d, /^Term/).fill("120");
    await field(d, /^Note/).fill("Faster funding");
    check("the offer saves", await saveDialog(page));
    let r = await offers();
    check(
      "DB: competing_offers row with every field, won = false, dated today",
      r.length === 1 &&
        r[0].funder_name === "Pearl Funding" &&
        r[0].amount === 4_500_000 &&
        r[0].factor === 1.34 &&
        r[0].payment === 40_000 &&
        r[0].frequency === "daily" &&
        r[0].position_no === 1 &&
        r[0].term_days === 120 &&
        r[0].won === false &&
        r[0].offered_on === today &&
        r[0].note === "Faster funding",
      JSON.stringify(r),
    );
    check(
      "no 'average factor' insight with a single offer",
      !/Average factor/.test(await p.innerText()),
    );
    // Second offer → insight.
    await p.getByRole("button", { name: "+ Add" }).click();
    d = dialogOf(page);
    await field(d, /^Funder/).fill("Everest Funding");
    await field(d, /^Factor rate/).fill("1.38");
    await field(d, /^Advance amount/).fill("40k");
    await saveDialog(page);
    check(
      "with two offers the average factor appears (1.36, range 1.34 to 1.38)",
      await panelHas(p, /Average factor across 2 offers: 1\.36 \(1\.34 to 1\.38\)/),
      (await p.innerText()).replace(/\s+/g, " ").slice(0, 160),
    );
    // Validation.
    await p.getByRole("button", { name: "+ Add" }).click();
    d = dialogOf(page);
    await field(d, /^Funder/).fill("Bad Factor Inc");
    await field(d, /^Factor rate/).fill("5");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    const msg = await alertText(page);
    check("a factor rate of 5 is refused in plain words", /1\.00 and 3\.00/.test(msg), msg);
    await field(d, /^Factor rate/).fill("");
    await field(d, /^Funder/).fill("");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    check(
      "a blank funder does not save (the browser asks for it)",
      (await d.isVisible()) && (await offers()).length === 2,
    );
    await d.getByRole("button", { name: "Cancel" }).click();
    // Mark one as the winner.
    await p
      .locator("li")
      .filter({ hasText: "Everest Funding" })
      .getByRole("button", { name: "Edit" })
      .click();
    d = dialogOf(page);
    await d.getByRole("checkbox", { name: /They won this deal/ }).check();
    await saveDialog(page);
    r = await offers();
    check(
      "DB: Everest is marked won, Pearl is not",
      r.find((x) => x.funder_name === "Everest Funding")?.won === true &&
        r.find((x) => x.funder_name === "Pearl Funding")?.won === false,
    );
    check("the card says 'Won the deal'", await panelHas(p, /Won the deal/));
    // Delete.
    await p
      .locator("li")
      .filter({ hasText: "Pearl Funding" })
      .getByRole("button", { name: "Edit" })
      .click();
    d = dialogOf(page);
    await d.getByRole("button", { name: "Delete", exact: true }).click();
    await d.getByRole("button", { name: "Click again to delete" }).click();
    await gone(d, 6000);
    const ok = await until(async () => (await offers()).length === 1);
    check(
      "DB: Pearl's offer is deleted, Everest's remains",
      !!ok && (await offers())[0].funder_name === "Everest Funding",
      JSON.stringify((await offers()).map((x) => x.funder_name)),
    );
    check(
      "with one offer left the average insight goes away",
      !!(await until(async () => !/Average factor/.test(await p.innerText()), 5000)),
    );
  });

  // =========================== 8. stips ================================================================
  await section("stips", async () => {
    const c = await clientOf("Harbor Seafood");
    await openClient(page, c.id);
    const p = panel(page, "Stips");
    const st = () =>
      rows(
        "select kind, period::text period, required, received_at from stips where client_id = $1 order by kind, period",
        [c.id],
      );
    check(
      "precondition: no checklist yet",
      (await st()).length === 0 &&
        (await p.getByRole("button", { name: "Start the checklist" }).count()) === 1,
    );
    await p.getByRole("button", { name: "Start the checklist" }).click();
    await p
      .getByText(/of \d+ required/)
      .waitFor({ timeout: 6000 })
      .catch(() => undefined);
    const s0 = await st();
    const first = `${today.slice(0, 7)}-01`;
    const months = [4, 3, 2, 1].map((i) => addMonths(first, -i));
    const stmts = s0.filter((x) => x.kind === "bank_statement").map((x) => x.period);
    check(
      "DB: 4 monthly bank statements for the last 4 COMPLETE months",
      JSON.stringify(stmts) === JSON.stringify(months),
      `${stmts} vs ${months}`,
    );
    check(
      "DB: 7 required (application, 4 statements, ID, voided check) and 4 optional",
      s0.filter((x) => x.required).length === 7 && s0.filter((x) => !x.required).length === 4,
      `${s0.filter((x) => x.required).length}/${s0.filter((x) => !x.required).length}`,
    );
    check(
      "DB: nothing is marked received yet",
      s0.every((x) => x.received_at === null),
    );
    check(
      "the card says 0 of 7 required and lists what is missing",
      /0 of 7 required/.test(await p.innerText()) && /Missing:/.test(await p.innerText()),
    );
    // Tick one statement month.
    const label = (iso) => {
      const [y, m] = iso.split("-").map(Number);
      return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y} statement`;
    };
    await p.getByRole("checkbox", { name: label(months[3]) }).check();
    const ok = await until(
      async () => (await st()).find((x) => x.period === months[3])?.received_at,
    );
    check(`DB: ticking "${label(months[3])}" sets stips.received_at`, !!ok, String(ok));
    check("DB: only that one changed", (await st()).filter((x) => x.received_at).length === 1);
    check(
      "the card says 1 of 7 and no longer lists that month as missing",
      /1 of 7 required/.test(await p.innerText()) &&
        !new RegExp(`Missing:[^\\n]*${label(months[3])}`).test(await p.innerText()),
    );
    const log = await rows(
      "select body from activities where client_id = $1 and kind = 'system' order by occurred_at desc limit 1",
      [c.id],
    );
    check(
      "the timeline notes which document came in",
      /Stip received/.test(log[0]?.body ?? ""),
      log[0]?.body,
    );
    // Tick all required.
    const requiredBoxes = [
      "Signed application",
      ...months.slice(0, 3).map(label),
      "Driver's license / ID",
      "Voided check",
    ];
    for (const name of requiredBoxes) await p.getByRole("checkbox", { name, exact: true }).check();
    await until(async () => (await st()).filter((x) => x.required && x.received_at).length === 7);
    check(
      "DB: all 7 required are received",
      (await st()).filter((x) => x.required && x.received_at).length === 7,
    );
    const ready = await p
      .getByText(/Ready to submit/)
      .first()
      .isVisible()
      .catch(() => false);
    check(
      "'Ready to submit' appears",
      ready,
      (await p.innerText()).replace(/\s+/g, " ").slice(0, 160),
    );
    await shot(page, "client-stips-ready");
    // Untick one.
    await p.getByRole("checkbox", { name: label(months[1]), exact: true }).uncheck();
    await until(async () => (await st()).find((x) => x.period === months[1])?.received_at === null);
    check(
      "DB: unticking clears received_at again",
      (await st()).find((x) => x.period === months[1])?.received_at === null,
    );
    check(
      "the banner changes back and names the missing month",
      /Missing:/.test(await p.innerText()) && (await p.innerText()).includes(label(months[1])),
      (await p.innerText()).replace(/\s+/g, " ").slice(0, 140),
    );
    // Optional stip does not decide 'ready'.
    await p.getByRole("checkbox", { name: "Tax return", exact: true }).check();
    await until(async () => (await st()).find((x) => x.kind === "tax_return")?.received_at);
    check(
      "ticking an optional document does not count toward 'required'",
      /6 of 7 required/.test(await p.innerText()),
      (await p.innerText()).replace(/\s+/g, " ").slice(0, 80),
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await p.getByText(/of 7 required/).waitFor({ timeout: 6000 });
    check(
      "after a reload the ticks are remembered",
      await p.getByRole("checkbox", { name: "Signed application", exact: true }).isChecked(),
    );
  });

  // =========================== 9. edit details ========================================================
  await section("edit details", async () => {
    const c = await clientOf("Cruz Landscaping");
    await openClient(page, c.id);
    await page.getByRole("button", { name: "Edit details" }).click();
    let d = dialogOf(page);
    check(
      "the dialog starts from what is on file",
      (await field(d, /^Business name/).inputValue()) === "Cruz Landscaping" &&
        (await field(d, /^Phone/).inputValue()) === "(786) 555-0103",
    );
    await field(d, /^Business name/).fill("Cruz Landscaping & Pools");
    await field(d, /^Merchant name/).fill("Luis A. Cruz");
    await field(d, /^Phone/).fill("(305) 555-0188");
    await field(d, /^Email/).fill("luis@cruz.example.com");
    await field(d, /^State/).fill("TX");
    await field(d, /^Monthly revenue/).fill("85k");
    await field(d, /^Time in business/).fill("48");
    check("details save", await saveDialog(page));
    let r = await clientById(c.id);
    check(
      "DB: name, merchant, phone, email, state, revenue and months are updated",
      r.business_name === "Cruz Landscaping & Pools" &&
        r.contact_name === "Luis A. Cruz" &&
        r.phone === "(305) 555-0188" &&
        r.email === "luis@cruz.example.com" &&
        r.state === "TX" &&
        r.revenue === 8_500_000 &&
        r.months === 48,
      JSON.stringify(r),
    );
    check(
      "the page header shows the new name",
      !!(await until(
        async () => (await page.getByRole("heading", { level: 1 }).innerText()).includes("Pools"),
        5000,
      )),
    );
    check(
      "the phone on the page is formatted (305) 555-0188",
      !!(await until(async () => page.getByText("(305) 555-0188").first().isVisible(), 5000)),
    );
    // Invalid email: browser blocks it.
    await page.getByRole("button", { name: "Edit details" }).click();
    d = dialogOf(page);
    const emailBox = field(d, /^Email/);
    await emailBox.fill("not-an-email");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    await until(async () => false, 300);
    const validity = await emailBox.evaluate((el) => ({
      bad: el.validity.typeMismatch,
      msg: el.validationMessage,
    }));
    check(
      "an email with no @ is rejected before it is saved (message in plain words)",
      d && (await d.isVisible()) && validity.bad && /@/.test(validity.msg),
      validity.msg,
    );
    check(
      "DB: the bad email was not stored",
      (await clientById(c.id)).email === "luis@cruz.example.com",
    );
    // Passes the browser's check, fails ours.
    await emailBox.fill("luis@cruz");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    const msg = await until(async () => (await alertText(page, 700)) || null, 3000);
    check(
      "'luis@cruz' (no dot) is refused in plain words",
      /valid email/i.test(msg ?? ""),
      msg ?? "accepted",
    );
    check("DB: still the old email", (await clientById(c.id)).email === "luis@cruz.example.com");
    check(
      "the dialog stays open with what he typed",
      (await d.isVisible()) && (await emailBox.inputValue()) === "luis@cruz",
    );
    await emailBox.fill("luis@cruz.example.com");
    // Other validation.
    await field(d, /^Monthly revenue/).fill("lots");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    const m2 = await until(async () => (await alertText(page, 700)) || null, 3000);
    check(
      "revenue 'lots' is refused with an example",
      /50k|amount/i.test(m2 ?? ""),
      m2 ?? "accepted",
    );
    await field(d, /^Monthly revenue/).fill("85k");
    await field(d, /^Time in business/).fill("-3");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    const m3 = await until(async () => (await alertText(page, 700)) || null, 3000);
    check(
      "months in business of -3 is refused in plain words",
      /whole number/i.test(m3 ?? ""),
      m3 ?? "accepted",
    );
    await field(d, /^Time in business/).fill("48");
    await field(d, /^Business name/).fill("N".repeat(250));
    await d.getByRole("button", { name: "Save", exact: true }).click();
    const m4 = await until(async () => (await alertText(page, 700)) || null, 3000);
    check(
      "a 250-character business name is refused in plain words (not 'Too big: expected…')",
      !!m4 && !/Too big|expected|characters\b.*<=/i.test(m4),
      m4 ?? "accepted",
    );
    await field(d, /^Business name/).fill("Cruz Landscaping & Pools");
    // A phone number with no digits.
    await field(d, /^Phone/).fill("call his cell");
    check("'call his cell' saves as a phone number", await saveDialog(page));
    const call = page.getByRole("button", { name: /^Call Cruz/ }).first();
    check(
      "with no usable phone the Call button is disabled",
      !!(await until(async () => call.isDisabled(), 5000)),
    );
    check(
      "…and says why (tooltip / label)",
      !!(await call.getAttribute("title")) &&
        /phone|number/i.test((await call.getAttribute("title")) ?? ""),
      `title=${JSON.stringify(await call.getAttribute("title"))}`,
    );
    // Duplicate phone.
    const mike = await clientOf("Mike's Pizza");
    await page.getByRole("button", { name: "Edit details" }).click();
    d = dialogOf(page);
    await field(d, /^Phone/).fill(mike.phone);
    await d.getByRole("button", { name: "Save", exact: true }).click();
    const warned = await until(
      async () =>
        /already|looks like|duplicate/i.test(await d.innerText().catch(() => "")) ||
        (await alertText(page, 500)).length > 0,
      3000,
    );
    check(
      "giving him Mike's Pizza's phone number warns about the duplicate (Add client does)",
      !!warned,
      "saved silently",
    );
    if (await d.isVisible().catch(() => false))
      await d.getByRole("button", { name: "Cancel" }).click();
    // Source is single-line: SSN guard?
    await page.getByRole("button", { name: "Edit details" }).click();
    d = dialogOf(page);
    await field(d, /^Phone/).fill("(305) 555-0188");
    await field(d, /^Source/).fill("referred by 123-45-6789");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    const closed = await gone(d, 2500);
    r = await clientById(c.id);
    check(
      "an SSN typed into 'Source' is refused, not stored",
      !/123-45-6789/.test(r.source ?? ""),
      closed ? `STORED in clients.source = "${r.source}"` : "refused",
    );
    if (await d.isVisible().catch(() => false))
      await d.getByRole("button", { name: "Cancel" }).click();
  });

  // =========================== stage move from the client page =========================================
  await section("move to a stage from the client page", async () => {
    const c = await clientOf("Verde Landscaping");
    await openClient(page, c.id);
    const sel = page.getByLabel("Move to stage");
    const current = await sel.locator("option[disabled]").first().innerText();
    check(
      "the current stage is listed but cannot be picked again",
      /\(current\)/.test(current),
      current,
    );
    await sel.selectOption({ label: "Offers in" }); // "Offer presented" folds into "Offers in" in every dropdown
    const ok = await until(async () => (await clientById(c.id)).stage === "offers_in");
    check("DB: picking 'Offers in' moves him", !!ok, (await clientById(c.id)).stage);
    const t = await followUps(c.id);
    check(
      "DB: with the stage's own follow-up (one open timer, after today)",
      t.length === 1 && t[0].due_on > today,
      JSON.stringify(t.map((x) => x.due_on)),
    );
    check(
      "the badge at the top now says Offers in",
      !!(await until(
        async () => /Offers in/.test(await page.locator("h1").locator("xpath=..").innerText()),
        5000,
      )),
    );
    check("the select goes back to 'Move to…' after a move", (await sel.inputValue()) === "");
    const sc = await rows(
      "select from_stage, to_stage from activities where client_id = $1 and kind = 'stage_change'",
      [c.id],
    );
    check(
      "DB: a stage_change row application_in → offers_in",
      sc.some((x) => x.from_stage === "application_in" && x.to_stage === "offers_in"),
      JSON.stringify(sc),
    );
    await sel.selectOption({ label: "Funded" });
    const d = dialogOf(page);
    await d.getByRole("heading", { name: /funded/ }).waitFor({ timeout: 5000 });
    check(
      "Funded opens the terms dialog and nothing moves yet",
      (await clientById(c.id)).stage === "offers_in",
    );
    await field(d, /^Advance amount/).fill("25k");
    await field(d, /^Factor rate/).fill("1.4");
    await field(d, /^Remittance/).fill("350");
    await d.getByRole("button", { name: "Mark funded" }).click();
    await gone(d, 8000);
    const ok2 = await until(async () => (await clientById(c.id)).stage === "funded");
    const f = await one(
      "select amount_cents::int a, payback_cents::int p, payment_cents::int r from fundings where client_id = $1",
      [c.id],
    );
    check(
      "DB: funded with payback = amount × factor ($35,000)",
      !!ok2 && f?.a === 2_500_000 && f.p === 3_500_000 && f.r === 35_000,
      JSON.stringify(f),
    );
    const tm = await openTimers(c.id);
    check(
      "DB: check-in 30 days out and a renewal call",
      tm.some((x) => x.kind === "check_in" && x.due_on === addDays(today, 30)) &&
        tm.some((x) => x.kind === "renewal"),
      JSON.stringify(tm.map((x) => `${x.kind}:${x.due_on}`)),
    );
    check(
      "the Funding panel appears on the page",
      !!(await until(async () => (await panel(page, "Funding").count()) > 0, 5000)),
    );
    await shot(page, "client-funded");
  });

  // =========================== 12. sensitive data in notes ============================================
  await section("sensitive data in notes", async () => {
    const c = await clientOf("Green Leaf Market");
    await openClient(page, c.id);
    const box = page.getByLabel("New note");
    const stored = () =>
      rows("select body from activities where client_id = $1 and kind = 'note'", [c.id]);
    const cases = [
      ["SSN with dashes", "Owner SSN 123-45-6789 per his email", true, /Social Security/],
      ["SSN with spaces", "ssn 123 45 6789", true, /Social Security/],
      [
        "card, spaced (Luhn-valid test number)",
        "card 4111 1111 1111 1111 exp 12/29",
        true,
        /card number/,
      ],
      ["card, 16 digits in a row (Luhn-valid)", "pay with 4111111111111111", true, /card number/],
      ["card, dashes (Visa test)", "4012-8888-8888-1881", true, /card number/],
      ["16 digits that fail the checksum", "number is 1234 5678 9012 3456", true, /card number/],
      ["SSN as nine digits", "SSN 123456789", true, /Social Security/],
      ["routing/account number", "routing number 021000021", true, /bank account|routing/],
      ["account with 'acct #'", "acct # 000123456789", true, /bank account|routing/],
    ];
    for (const [name, body, shouldRefuse, re] of cases) {
      await box.fill(body);
      await page.getByRole("button", { name: "Save note" }).click();
      const msg = await until(async () => (await alertText(page, 600)) || null, 2500);
      const saved = (await stored()).some((r) => r.body === body);
      const ok = shouldRefuse ? !saved && re.test(msg ?? "") : saved;
      check(
        `${name}: refused with a plain-words message and NOT stored`,
        ok,
        saved ? `STORED: "${body}"` : `message: ${msg}`,
      );
      await page
        .waitForFunction(() => document.querySelectorAll('[role="alert"]').length === 0, null, {
          timeout: 7000,
        })
        .catch(() => undefined);
    }
    // Things that look like numbers but are not secrets must go through.
    const fine = [
      ["a phone number", "call him on 305-555-0121 after 3"],
      ["a dollar amount", "wants $1,250,000 over 12 months"],
      ["a date and amount", "funded 2026-09-14 for 1500000"],
      ["a long reference that is not a card", "ref 2026101400000001"],
    ];
    for (const [name, body] of fine) {
      await box.fill(body);
      await page.getByRole("button", { name: "Save note" }).click();
      const ok = await until(async () => (await stored()).some((r) => r.body === body));
      check(
        `${name} is NOT mistaken for a secret`,
        !!ok,
        ok ? "" : `refused: ${await alertText(page, 300)}`,
      );
    }
    const n = (await stored()).filter((r) => /123-45-6789|4111|123 45 6789/.test(r.body)).length;
    check("DB: no stored note contains an SSN or a Luhn-valid card number", n === 0, `${n} notes`);
    const everywhere = await one(
      `select count(*)::int n from activities a join clients c on c.id = a.client_id join app_users u on u.id = c.user_id
        where u.email = $1 and (a.body ~ '\\d{3}-\\d{2}-\\d{4}' or a.body ~ '4111')`,
      [email],
    );
    check("DB: …and none anywhere in this user's timelines", everywhere.n === 0, `${everywhere.n}`);
  });

  check(
    "no console errors on the client page (desktop)",
    consoleErrors.length === 0,
    [...consoleErrors.slice(0, 3), ...badResponses.slice(0, 5)].join(" | "),
  );
  await browser.close();

  // =========================== 11. mobile 390px ======================================================
  await section("mobile 390px", async () => {
    const c = await clientOf("Rivera Auto Repair");
    for (const scheme of ["light", "dark"]) {
      const m = await openBrowser(
        email,
        { width: 390, height: 844 },
        { hasTouch: true, isMobile: true, colorScheme: scheme },
      );
      m.context.on("page", (p) => void p.close().catch(() => undefined));
      const p = m.page;
      await openClient(p, c.id);
      await p.getByLabel("New note").waitFor();
      const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`[${scheme}] no horizontal page overflow`, over <= 1, `${over}px`);
      if (scheme === "light") {
        const geo = await p.evaluate(() => {
          const note = document.getElementById("new-note")?.getBoundingClientRect();
          const sticky = document.querySelector(".sticky.top-\\[57px\\]")?.getBoundingClientRect();
          return {
            noteTop: note ? note.top + scrollY : -1,
            vh: innerHeight,
            docH: document.documentElement.scrollHeight,
            stickyH: sticky?.height ?? 0,
            stickyBottom: sticky?.bottom ?? 0,
          };
        });
        console.log(
          `   mobile: note box starts ${Math.round(geo.noteTop)}px down the page (${(geo.noteTop / geo.vh).toFixed(1)} screens of ${geo.vh}px); page is ${geo.docH}px tall; pinned header block is ${Math.round(geo.stickyBottom)}px of the screen`,
        );
        check(
          "the note box is reachable without scrolling past a wall of cards (within ~1 screen)",
          geo.noteTop > 0 && geo.noteTop < geo.vh * 1.0,
          `${Math.round(geo.noteTop)}px down = ${(geo.noteTop / geo.vh).toFixed(1)} screens`,
        );
        check(
          "the pinned header (name, stage, next date, Call/Text/Email) takes under a quarter of the screen",
          geo.stickyBottom < geo.vh * 0.25,
          `${Math.round(geo.stickyBottom)}px of ${geo.vh}px`,
        );
      }
      const small = await tapAudit(p);
      check(
        `[${scheme}] every button, link and field is at least 40px tall`,
        small.length === 0,
        `${small.length} too small: ` +
          small
            .slice(0, 14)
            .map((x) => `${x.label}(${x.w}x${x.h})`)
            .join(", "),
      );
      await shot(p, `mobile-client-${scheme}`);
      await shot(p, `mobile-client-${scheme}-full`, true);
      // Open the dialogs a thumb would use.
      if (scheme === "light") {
        await p.getByRole("button", { name: "Edit details" }).click();
        const dd = dialogOf(p);
        const fits = await dd.evaluate(
          (d) =>
            d.getBoundingClientRect().width <= window.innerWidth &&
            d.getBoundingClientRect().height <= window.innerHeight,
        );
        check("the Edit details dialog fits the phone screen", fits);
        const small2 = await p.evaluate(() => {
          const d = document.querySelector("dialog[open]");
          const out = [];
          for (const el of d?.querySelectorAll("button, input, select, textarea") ?? []) {
            const r = el.getBoundingClientRect();
            if (r.width > 1 && r.height > 1 && r.height < 40)
              out.push(
                `${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 14)}(${Math.round(r.height)})`,
              );
          }
          return out;
        });
        check(
          "buttons and fields inside the dialog are at least 40px tall",
          small2.length === 0,
          small2.join(", "),
        );
        await shot(p, "mobile-client-edit-dialog");
        await dd.getByRole("button", { name: "Cancel" }).click();
      }
      await m.browser.close();
    }
  });

  await section("desktop screenshots (light + dark)", async () => {
    const c = await clientOf("Rivera Auto Repair");
    for (const scheme of ["light", "dark"]) {
      const d = await openBrowser(email, { width: 1440, height: 900 }, { colorScheme: scheme });
      await openClient(d.page, c.id);
      await shot(d.page, `desktop-client-${scheme}`, true);
      await d.browser.close();
    }
  });
}
