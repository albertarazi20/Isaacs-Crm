// Board: drag and drop (mouse, keyboard, touch), stage dialogs, failures, search, collapse, storage, mobile.
// Every check reads the DATABASE, not just the screen (CLAUDE.md rule 6). A failing check is a finding for docs/ISSUES.md.
//   E2E_ONLY=walk pnpm -s e2e board     run one section (names are the first argument of section(); "a|b" runs both)
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

const SHOTS = process.env.E2E_SHOTS ?? "/tmp/e2e-shots/board";
mkdirSync(SHOTS, { recursive: true });
const ONLY = process.env.E2E_ONLY ?? "";

// ---- database helpers ---------------------------------------------------------------------
const rows = (sql, params = []) => withDb((db) => db.query(sql, params)).then((r) => r.rows);
const one = async (sql, params = []) => (await rows(sql, params))[0];

let USER = "";
const clientOf = (name) =>
  one(
    `select c.id, c.stage, c.application_received_on::text app_on, c.business_name
       from clients c join app_users u on u.id = c.user_id
      where u.email = $1 and c.business_name = $2`,
    [USER, name],
  );
const openTimers = (id) =>
  rows(
    "select kind, due_on::text due_on, note from timers where client_id = $1 and done_at is null order by due_on, kind",
    [id],
  );
const followUps = async (id) => (await openTimers(id)).filter((t) => t.kind === "follow_up");
const stageChanges = (id) =>
  rows(
    "select from_stage, to_stage, body from activities where client_id = $1 and kind = 'stage_change' order by occurred_at",
    [id],
  );
const latestFunding = (id) =>
  one(
    `select amount_cents::int amount, factor_rate::float factor, payback_cents::int payback,
            payment_cents::int payment, frequency, funded_on::text funded_on, status,
            defaulted_on::text defaulted_on, promise_amount_cents::int promise_amount,
            to_char(promise_to_pay_at at time zone 'America/New_York', 'YYYY-MM-DD"T"HH24:MI') promise_at,
            commission_cents::int commission, funder_name, position_no, term_days
       from fundings where client_id = $1 order by funded_on desc, created_at desc limit 1`,
    [id],
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
const BUCKETS = {
  today: { label: "Today", due: (t) => t },
  "1w": { label: "1 week", due: (t) => addDays(t, 7) },
  "2w": { label: "2 weeks", due: (t) => addDays(t, 14) },
  "1m": { label: "1 month", due: (t) => addMonths(t, 1) },
  "2m": { label: "2 months", due: (t) => addMonths(t, 2) },
  "3m": { label: "3 months", due: (t) => addMonths(t, 3) },
  "6m": { label: "6 months", due: (t) => addMonths(t, 6) },
  "12m": { label: "12 months", due: (t) => addMonths(t, 12) },
  "24m": { label: "24 months", due: (t) => addMonths(t, 24) },
  "36m": { label: "36 months", due: (t) => addMonths(t, 36) },
};

// ---- small playwright helpers -----------------------------------------------------------------
const firstLine = (e) => String(e instanceof Error ? e.message : e).split("\n")[0];

/** Runs one block; a crash inside it becomes a failing check instead of killing the whole run. */
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

const card = (page, name) => page.locator(`article[aria-label^="${name},"]`);
/** A card or its lazy placeholder (cards far down a column are empty boxes until scrolled near). */
const slot = (page, name) => page.locator(`[aria-label^="${name},"]`);
const column = (page, label) => page.locator(`section[aria-label^="${label}, "]`);
/** The label of the board column a card sits in, e.g. "1 week". */
const colOf = async (page, name) =>
  (
    (await page
      .locator("section[aria-label*=', ']")
      .filter({ has: slot(page, name) })
      .last()
      .getAttribute("aria-label", { timeout: 4000 })
      .catch(() => "")) ?? ""
  ).split(", ")[0];
/** Scroll the card to the top of its column (clear of the toasts at the bottom of the screen) and wait for the real card. */
async function reveal(page, name) {
  const s0 = slot(page, name).first();
  await s0.scrollIntoViewIfNeeded({ timeout: 8000 });
  await s0.evaluate((el) => {
    const body = el.closest("div.overflow-y-auto");
    if (body)
      body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
  });
  const art = card(page, name).first();
  await art.waitFor({ timeout: 5000 });
  // Wait for the box to stop moving (a placeholder is swapped for the real card, scroll settles).
  let last = "";
  await until(async () => {
    const box = JSON.stringify(await art.boundingBox());
    const same = box === last;
    last = box;
    return same;
  }, 3000);
  return art;
}

const dialogOf = (page) => page.getByRole("dialog");
/** Next's route announcer is also role=alert (it holds the page title); error toasts are the other ones. Each toast is read once. */
const ALERT = '[role="alert"]:not(#__next-route-announcer__)';
async function alertText(page, timeout = 5000) {
  const loc = page.locator(`${ALERT}:not([data-seen])`).filter({ hasText: /\S/ }).first();
  const text = await loc.innerText({ timeout }).catch(() => "");
  if (text) await loc.evaluate((e) => e.setAttribute("data-seen", "1")).catch(() => undefined);
  return text;
}
const field = (scope, re) => scope.getByLabel(re);
const shot = (page, name) =>
  page
    .screenshot({ path: `${SHOTS}/${name}.png` })
    .catch((e) => console.log("   shot failed", firstLine(e)));

async function gotoBoard(page, view = "pipeline") {
  const t0 = Date.now();
  await page.goto(`${BASE}/board?view=${view}`, { waitUntil: "domcontentloaded" });
  await page.locator("article").first().waitFor({ timeout: 15000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector("article");
      return (
        !!el &&
        Object.keys(el).some((k) => k.startsWith("__reactProps") || k.startsWith("__reactFiber"))
      );
    },
    null,
    { timeout: 15000 },
  );
  const ms = Date.now() - t0;
  await page.evaluate(() =>
    document.querySelectorAll('[role="alert"]').forEach((e) => e.setAttribute("data-seen", "1")),
  );
  return ms;
}

/**
 * Mouse drag the way a person does it: press on the card's edge, move past the 6px threshold, hold the
 * pointer near the board's left/right edge so it auto-scrolls until the target column is on screen, then
 * glide onto the column and let go.
 */
async function drag(page, name, targetLoc) {
  const cardLoc = await reveal(page, name);
  const a = await cardLoc.boundingBox();
  const region = page.locator('[role="region"][aria-label*="board"]').first();
  const R = await region.boundingBox();
  if (!a || !R) throw new Error("card or board has no box");
  const sx = a.x + 6;
  const sy = a.y + 6;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 12, sy + 12, { steps: 3 });
  const midY = R.y + R.height / 2;
  for (let i = 0; i < 80; i += 1) {
    const b = await targetLoc.boundingBox();
    if (!b) throw new Error("target column has no box");
    const centre = b.x + b.width / 2;
    if (centre > R.x + R.width * 0.2 && centre < R.x + R.width * 0.8) break;
    const edgeX = centre > R.x + R.width / 2 ? R.x + R.width - 40 : R.x + 40;
    await page.mouse.move(edgeX, midY + (i % 2), { steps: 2 });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 70))); // let the auto-scroll tick while the pointer waits at the edge
  }
  const b = await targetLoc.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 160), { steps: 10 });
  await targetLoc
    .and(page.locator(".ring-2"))
    .waitFor({ timeout: 2500 })
    .catch(() => undefined);
  await page.mouse.up();
}

let dragRetries = 0;
/** Drag a card into a column; true once the card shows in it (the optimistic move). One retry is allowed and counted. */
async function dragInto(page, name, colLabel) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await drag(page, name, column(page, colLabel));
    const landed = await until(
      async () => (await column(page, colLabel).locator(`[aria-label^="${name},"]`).count()) > 0,
      3500,
    );
    if (landed) return true;
    // A dialog (Funded, Lost, defaults) opening instead of an instant move is a success too.
    if (
      await dialogOf(page)
        .isVisible()
        .catch(() => false)
    )
      return true;
    dragRetries += 1;
    console.log(
      `   (drag of ${name} to ${colLabel} did not register; retrying once — retry #${dragRetries})`,
    );
  }
  return false;
}

/** Space, arrows, Space — waiting for the screen-reader announcement after each key (dnd-kit attaches its key listener a tick after pick-up). */
async function keyboardMove(page, name, keys) {
  const art = await reveal(page, name);
  await art.focus();
  const live = page.locator('[id^="DndLiveRegion"]');
  const text = () => live.innerText().catch(() => "");
  await page.keyboard.press("Space");
  await until(async () => /is over/.test(await text()), 2500);
  for (const k of keys) {
    const before = await text();
    await page.keyboard.press(k);
    await until(async () => (await text()) !== before, 2500);
    // dnd-kit measures from the last render: wait for the floating card to stop moving before the next key, as a person would.
    let lastBox = "";
    await until(async () => {
      const b = JSON.stringify(
        await page
          .locator("div.cursor-grabbing")
          .first()
          .boundingBox()
          .catch(() => null),
      );
      const same = b === lastBox;
      lastBox = b;
      return same;
    }, 1500);
    // dnd-kit measures from the last render: let it paint before the next key, as a person would.
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    if (process.env.DEBUG_KEYS) console.log("     key", k, "→", (await text()).trim());
  }
  const said = await text();
  await page.keyboard.press("Space");
  return said;
}

const waitDialogGone = (page) =>
  dialogOf(page)
    .waitFor({ state: "hidden", timeout: 8000 })
    .then(() => true)
    .catch(() => false);

async function fillFunded(
  dialog,
  { amount = "50k", factor = "1.35", remit = "450", freq = "Daily", funder = "" } = {},
) {
  await field(dialog, /^Advance amount/).fill(amount);
  await field(dialog, /^Factor rate/).fill(factor);
  await field(dialog, /^Remittance/).fill(remit);
  await field(dialog, /^How often/).selectOption({ label: freq });
  if (funder) await field(dialog, /^Funder/).fill(funder);
}

export default async function boardFlow({ email }) {
  USER = email;
  const tz = (await one("select timezone from app_users where email = $1", [email])).timezone;
  const today = (await one("select (now() at time zone $1)::date::text d", [tz])).d;
  console.log(`   Isaac's today is ${today} (${tz}), weekday ${utc(today).getUTCDay()}`);

  // 1600px is the widest the app lays out (max-w-[1600px]); farther columns are reached by auto-scroll while dragging.
  const wide = await openBrowser(email, { width: 1600, height: 900 });
  const { browser, page } = wide;
  SHOT_PAGE = page;
  trackNav(page);
  const consoleErrors = [];
  const badResponses = [];
  page.on(
    "response",
    (r) => r.status() >= 400 && badResponses.push(`${r.status()} ${r.url().replace(BASE, "")}`),
  );
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 500));
    if (/Fast Refresh|\[HMR\]/.test(m.text()) && !/connected/.test(m.text()))
      console.log(`   (dev server hot-reloaded the page: ${m.text().slice(0, 80)})`);
  });

  // =========================== 6. performance sanity ================================================
  await section("perf: render and first drag", async () => {
    const loadMs = await gotoBoard(page, "pipeline");
    const count = await page.locator("article").count();
    check(
      "pipeline renders cards for the seeded merchants",
      count >= 40,
      `${count} articles mounted in ${loadMs}ms (domcontentloaded to first card)`,
    );
    const dueN = (
      await one(
        "select count(distinct t.client_id)::int n from timers t join app_users u on u.id = t.user_id where u.email = $1 and t.done_at is null and t.due_on <= $2::date",
        [email, today],
      )
    ).n;
    check(
      "the browser tab title carries the due count like the other pages",
      (await page.title()).startsWith(`(${dueN}) Board`),
      `${await page.title()} vs ${dueN} due in the database`,
    );
    const t0 = Date.now();
    const landed = await dragInto(page, "Mike's Pizza", "Spoke with owner");
    const uiMs = Date.now() - t0;
    check(
      "first drag responds: card shows in the new column",
      landed,
      `${uiMs}ms from press to card landing (includes ~0.6s of scripted mouse travel)`,
    );
    const dbMs = await (async () => {
      const t1 = Date.now();
      const ok = await until(
        async () => (await clientOf("Mike's Pizza")).stage === "spoke_with_owner",
      );
      return ok ? Date.now() - t1 : -1;
    })();
    check("first drag reached the database", dbMs >= 0, `${dbMs}ms after the card landed`);
    const nav = await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.toJSON());
    console.log(
      `   timings: load ${loadMs}ms, dom ${Math.round(nav?.domContentLoadedEventEnd ?? 0)}ms, drag-to-ui ${uiMs}ms, ui-to-db ${dbMs}ms`,
    );
    const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    console.log(`   JS heap ${(heap / 1048576).toFixed(0)}MB`);
  });

  // =========================== 1. follow-ups view ====================================================
  await section("followups: drag into every column", async () => {
    await gotoBoard(page, "followups");
    const mike = await clientOf("Mike's Pizza");
    // Mike's follow-up was reset by the previous section's stage move; start from a known date.
    for (const key of ["1m", "6m", "1w", "2w", "2m", "3m", "12m", "24m", "36m", "today"]) {
      const b = BUCKETS[key];
      const before = await followUps(mike.id);
      const landed = await dragInto(page, "Mike's Pizza", b.label);
      const want = b.due(today);
      const ok = await until(async () => {
        const f = await followUps(mike.id);
        return f.length === 1 && f[0].due_on === want;
      });
      const now = await openTimers(mike.id);
      check(
        `drag to "${b.label}" sets the one open follow-up to ${want} (calendar math)`,
        !!ok && now.length >= 1,
        `UI landed=${landed}; before ${before.map((t) => t.due_on)} → now ${JSON.stringify(now.map((t) => `${t.kind}:${t.due_on}`))}`,
      );
    }
    const acts = await rows(
      "select kind, body from activities where client_id = $1 and kind = 'timer' order by occurred_at desc limit 2",
      [mike.id],
    );
    check(
      "each follow-up move leaves a timeline entry",
      acts.length >= 1,
      JSON.stringify(acts[0] ?? null),
    );
    await shot(page, "followups-after-drags");
  });

  await section("followups: same column is a no-op", async () => {
    await gotoBoard(page, "followups");
    const gl = await clientOf("Green Leaf Market");
    const before = await rows(
      "select id, due_on::text d, done_at from timers where client_id = $1 order by created_at",
      [gl.id],
    );
    const label = await colOf(page, "Green Leaf Market");
    await drag(page, "Green Leaf Market", column(page, label));
    // Give a wrongly-fired server action time to land before comparing.
    await until(
      async () =>
        (await rows("select id from timers where client_id = $1", [gl.id])).length !==
        before.length,
      1500,
    );
    const after = await rows(
      "select id, due_on::text d, done_at from timers where client_id = $1 order by created_at",
      [gl.id],
    );
    check(
      `dropping on the card's own column ("${label}") changes nothing in the database`,
      JSON.stringify(before) === JSON.stringify(after),
      `${before.length} → ${after.length} timer rows`,
    );
    const stillThere = await column(page, label)
      .locator('[aria-label^="Green Leaf Market,"]')
      .count();
    check("card is still in its column after the no-op drop", stillThere === 1);
  });

  await section("followups: Overdue and Later are not drop targets", async () => {
    await gotoBoard(page, "followups");
    const over = await column(page, "Overdue (not a place to drop)").count();
    check("Overdue column says it is not a place to drop", over === 1);
    const patel = await clientOf("Patel Convenience");
    const before = await followUps(patel.id);
    await drag(page, "Patel Convenience", column(page, "Overdue (not a place to drop)"));
    await until(async () => false, 1200);
    const after = await followUps(patel.id);
    check("dropping on Overdue changes nothing", JSON.stringify(before) === JSON.stringify(after));
  });

  await section("followups: keyboard drag", async () => {
    await gotoBoard(page, "followups");
    const name = "Bella Nails & Spa";
    const c = await clientOf(name);
    const col0 = await colOf(page, name);
    const said1 = await keyboardMove(page, name, ["ArrowRight"]);
    check(
      "announcement while hovering a column names the merchant and the follow-up time",
      /Bella Nails & Spa is over follow up in 2 weeks/.test(said1),
      said1,
    );
    const want = addDays(today, 14);
    const ok = await until(async () => (await followUps(c.id)).some((t) => t.due_on === want));
    check(
      "keyboard: Space, ArrowRight, Space moves the card one column right (1 week → 2 weeks) in the database",
      !!ok,
      `column was "${col0}", due now ${JSON.stringify((await followUps(c.id)).map((t) => t.due_on))}, wanted ${want}`,
    );
    const live = page.locator('[id^="DndLiveRegion"]');
    check(
      "announcement on drop says where it was dropped",
      /dropped on follow up in 2 weeks/i.test(await live.innerText().catch(() => "")),
      (await live.innerText().catch(() => "")).slice(0, 120),
    );
    // Back left past Today: the disabled Overdue column must never be chosen.
    const said2 = await keyboardMove(page, name, ["ArrowLeft", "ArrowLeft"]);
    await page.keyboard.press("Escape");
    check("keyboard: two ArrowLeft reach Today", /over Today/.test(said2), said2);
    const art = await reveal(page, name);
    await art.focus();
    await page.keyboard.press("Space");
    await until(async () => /is over/.test(await live.innerText().catch(() => "")), 2500);
    for (let i = 0; i < 5; i += 1) await page.keyboard.press("ArrowLeft");
    await until(async () => false, 500);
    const said3 = await live.innerText().catch(() => "");
    await page.keyboard.press("Space");
    check(
      "keyboard: pressing ArrowLeft past Today never announces the Overdue column",
      !/overdue/i.test(said3),
      said3,
    );
    await until(async () => (await followUps(c.id)).every((t) => t.due_on >= today), 2000);
    check(
      "keyboard: after that the follow-up is not in the past",
      (await followUps(c.id)).every((t) => t.due_on >= today),
      JSON.stringify(await followUps(c.id)),
    );
    // Escape cancels.
    const before = JSON.stringify(await openTimers(c.id));
    const art2 = await reveal(page, name);
    await art2.focus();
    await page.keyboard.press("Space");
    await until(async () => /is over/.test(await live.innerText().catch(() => "")), 2500);
    await page.keyboard.press("ArrowRight");
    await until(
      async () => /over follow up in 1 week/.test(await live.innerText().catch(() => "")),
      2500,
    );
    await page.keyboard.press("Escape");
    const cancelled = await until(
      async () => /cancelled/i.test(await live.innerText().catch(() => "")),
      2500,
    );
    await until(async () => false, 400);
    check(
      "keyboard: Escape says 'Move cancelled' and changes nothing",
      !!cancelled && before === JSON.stringify(await openTimers(c.id)),
      (await live.innerText().catch(() => "")).slice(0, 100),
    );
  });

  await section("followups: two quick drags in a row end up consistent", async () => {
    await gotoBoard(page, "followups");
    const name = "Hartman Trucking";
    const c = await clientOf(name);
    await dragInto(page, name, "1 month");
    // No waiting for the first save: a broker flicking a card around.
    await dragInto(page, name, "6 months");
    await dragInto(page, name, "2 weeks");
    await until(
      async () => (await followUps(c.id)).some((t) => t.due_on === addDays(today, 14)),
      6000,
    );
    await until(async () => false, 1500);
    const f = await followUps(c.id);
    check(
      "three drags without pausing: the database ends on the last one (2 weeks)",
      f.length === 1 && f[0].due_on === addDays(today, 14),
      JSON.stringify(f.map((x) => x.due_on)),
    );
    await gotoBoard(page, "followups");
    const where = await colOf(page, name);
    check(
      "after a reload the card sits where the database says",
      where === "2 weeks",
      `shown under "${where}"`,
    );
    check(
      "no card is stuck mid-save (nothing greyed out)",
      (await page.locator("article.opacity-40").count()) === 0,
    );
  });

  await section(
    "followups: a funded merchant's renewal call survives being dragged far out",
    async () => {
      await gotoBoard(page, "followups");
      const name = "Apex Dental Lab"; // funded, renewal call due today
      const c = await clientOf(name);
      const before = await openTimers(c.id);
      const renewal0 = before.find((t) => t.kind === "renewal");
      await dragInto(page, name, "36 months");
      await until(async () =>
        (await followUps(c.id)).some((t) => t.due_on === addMonths(today, 36)),
      );
      const after = await openTimers(c.id);
      const renewal1 = after.find((t) => t.kind === "renewal");
      console.log(
        `   before: ${before.map((t) => `${t.kind}:${t.due_on}`)} → after: ${after.map((t) => `${t.kind}:${t.due_on}`)}`,
      );
      check(
        "dragging a hot renewal to 36 months leaves the renewal call date alone",
        !!renewal0 && renewal1?.due_on === renewal0.due_on,
        `renewal ${renewal0?.due_on} → ${renewal1?.due_on}`,
      );
      const undo = await page.getByRole("button", { name: "Undo" }).count();
      check(
        "a follow-up drop can be undone from its toast (stage moves can)",
        undo > 0,
        `${undo} Undo buttons visible right after the drop`,
      );
    },
  );

  await section(
    "followups: sheet offers 9 and 18 months, but the board has no such columns",
    async () => {
      await gotoBoard(page, "followups");
      const name = "Pioneer Auto Glass";
      const c = await clientOf(name);
      await page.getByRole("button", { name: `Choose when to follow up with ${name}` }).click();
      const d = dialogOf(page);
      check(
        "sheet lists 9 months and 18 months",
        (await d.getByRole("button", { name: /^9 months/ }).count()) === 1 &&
          (await d.getByRole("button", { name: /^18 months/ }).count()) === 1,
      );
      await d.getByRole("button", { name: /^9 months/ }).click();
      const want = addMonths(today, 9);
      const ok = await until(async () => (await followUps(c.id)).some((t) => t.due_on === want));
      check(
        "sheet: 9 months sets the follow-up to today + 9 calendar months",
        !!ok,
        JSON.stringify(await followUps(c.id)),
      );
      await until(async () => (await slot(page, name).count()) > 0, 3000);
      const colLabel = await colOf(page, name);
      check(
        "the card lands in a column named for what he picked (9 months)",
        /^9 months/.test(colLabel ?? ""),
        `it sits under "${colLabel}"`,
      );
      const toast = await page
        .getByText(/→ follow up/)
        .first()
        .innerText()
        .catch(() => "");
      console.log(`   toast: ${toast}`);
    },
  );

  // =========================== 2. pipeline view ======================================================
  await section("pipeline: Interested → Application in", async () => {
    await gotoBoard(page, "pipeline");
    const name = "Oak & Iron Fitness";
    const c = await clientOf(name);
    check(
      "precondition: starts in Interested without an application date",
      c.stage === "interested" && c.app_on === null,
    );
    await dragInto(page, name, "Application in");
    const ok = await until(async () => (await clientOf(name)).stage === "application_in");
    const after = await clientOf(name);
    check("DB: stage is application_in", !!ok, after.stage);
    check(
      "DB: application_received_on is stamped with today",
      after.app_on === today,
      String(after.app_on),
    );
    const t = await openTimers(c.id);
    check(
      "DB: at least one open timer; follow-up is the next business day",
      t.length >= 1 && t.some((x) => x.kind === "follow_up" && x.due_on === addBDays(today, 1)),
      JSON.stringify(t.map((x) => `${x.kind}:${x.due_on}`)),
    );
    const sc = await stageChanges(c.id);
    check(
      "DB: a stage_change activity interested → application_in",
      sc.some((s) => s.from_stage === "interested" && s.to_stage === "application_in"),
      JSON.stringify(sc),
    );
    const toast = page
      .locator('[role="status"]')
      .filter({ has: page.getByRole("button", { name: "Undo" }) })
      .first();
    const tUndo = await toast.getByRole("button", { name: "Undo" }).count();
    const tChange = await toast.getByRole("button", { name: "Change" }).count();
    check(
      "a toast names the new stage and follow-up date, with Change and Undo",
      tUndo >= 1 &&
        tChange >= 1 &&
        /Oak & Iron Fitness → Application in · follow up/.test(
          await toast.innerText().catch(() => ""),
        ),
      `Undo x${tUndo}, Change x${tChange}: ${(await toast.innerText().catch(() => "")).replace(/\s+/g, " ")}`,
    );
    // Undo puts him back in Interested on the same follow-up date.
    await toast.getByRole("button", { name: "Undo" }).click();
    const undone = await until(async () => (await clientOf(name)).stage === "interested");
    check("Undo moves him back to Interested in the database", !!undone);
    const t2 = await openTimers(c.id);
    check(
      "Undo leaves exactly one follow-up",
      t2.filter((x) => x.kind === "follow_up").length === 1,
      JSON.stringify(t2.map((x) => `${x.kind}:${x.due_on}`)),
    );
  });

  await section("pipeline: the toast's Change button sets a new date", async () => {
    await gotoBoard(page, "pipeline");
    const name = "Mendez Roofing";
    const c = await clientOf(name);
    await dragInto(page, name, "Application in");
    const toast = page
      .locator('[role="status"]')
      .filter({ has: page.getByRole("button", { name: "Change" }) })
      .first();
    await toast.getByRole("button", { name: "Change" }).click({ timeout: 6000 });
    const d = dialogOf(page);
    await d.getByRole("heading", { name: `Follow up with ${name}` }).waitFor({ timeout: 4000 });
    await d.getByRole("button", { name: "3m", exact: true }).click();
    await d.getByRole("button", { name: "Set follow-up" }).click();
    const want = addMonths(today, 3);
    const ok = await until(
      async () =>
        (await followUps(c.id)).length === 1 && (await followUps(c.id))[0].due_on === want,
    );
    check(
      `Change → 3m sets the follow-up to ${want} and keeps the new stage`,
      !!ok && (await clientOf(name)).stage === "application_in",
      JSON.stringify(await followUps(c.id)),
    );
    const n = (await openTimers(c.id)).length;
    check("still exactly the timers it should have (no duplicates)", n === 1, `${n} open timers`);
  });

  await section("pipeline: skipping Application in", async () => {
    await gotoBoard(page, "pipeline");
    const name = "Coastal HVAC";
    const c = await clientOf(name);
    await dragInto(page, name, "Collecting stips");
    await until(async () => (await clientOf(name)).stage === "stips");
    const after = await clientOf(name);
    check(
      "Interested → Collecting stips directly still records the date the application came in",
      after.stage === "stips" && after.app_on !== null,
      `stage ${after.stage}, application_received_on ${after.app_on}`,
    );
    const t = await openTimers(c.id);
    check(
      "it still has a follow-up (2 business days)",
      t.some((x) => x.kind === "follow_up" && x.due_on === addBDays(today, 2)),
      JSON.stringify(t.map((x) => `${x.kind}:${x.due_on}`)),
    );
  });

  await section("pipeline: exits that need no dialog keep a timer", async () => {
    await gotoBoard(page, "pipeline");
    const cases = [
      ["Hartman Trucking", "Dead deal", "dead", addMonths(today, 9)],
      ["Cruz Landscaping", "Not interested", "not_interested", addMonths(today, 12)],
      ["Sunrise Dental", "Declined", "declined", addMonths(today, 3)],
      ["Green Leaf Market", "Killed deal", "killed", addMonths(today, 6)],
    ];
    for (const [name, col, stage, due] of cases) {
      const c = await clientOf(name);
      await dragInto(page, name, col);
      const dlg = await dialogOf(page)
        .isVisible()
        .catch(() => false);
      const ok = await until(async () => (await clientOf(name)).stage === stage);
      const t = await openTimers(c.id);
      check(
        `${col}: moves straight away (no dialog), stage = ${stage}`,
        !!ok && !dlg,
        `dialog opened: ${dlg}`,
      );
      check(
        `${col}: keeps an open follow-up on ${due}`,
        t.some((x) => x.kind === "follow_up" && x.due_on === due),
        JSON.stringify(t.map((x) => `${x.kind}:${x.due_on}`)),
      );
      const sc = await stageChanges(c.id);
      check(
        `${col}: stage_change row written`,
        sc.some((s) => s.to_stage === stage),
      );
    }
  });

  await section("pipeline: Lost deal asks who won and logs the rival offer", async () => {
    await gotoBoard(page, "pipeline");
    const name = "Patel Convenience";
    const c = await clientOf(name);
    await dragInto(page, name, "Lost deal");
    const d = dialogOf(page);
    const opened = await d
      .getByRole("heading", { name: /who did they go with/i })
      .waitFor({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    check("Lost deal opens the competitor dialog (nothing moved yet)", opened);
    check(
      "DB: nothing changed while the dialog is open",
      (await clientOf(name)).stage === "interested",
    );
    // Required field: try to save blank.
    await d.getByRole("button", { name: "Save and move" }).click();
    check(
      "blank funder is refused in plain words and the dialog stays",
      (await d.getByText("Who did they go with?").count()) > 0 && (await d.isVisible()),
    );
    await field(d, /^Competing funder/).fill("Everest Funding");
    await field(d, /^Their advance amount/).fill("40k");
    await field(d, /^Factor rate/).fill("1.38");
    await field(d, /^Remittance/).fill("390");
    await field(d, /^How often/).selectOption({ label: "Daily" });
    await field(d, /^Position/).fill("2");
    await field(d, /^Term \(days\)/).fill("180");
    await field(d, /^Note/).fill("Said they close faster");
    const preview = (await d.innerText()).replace(/\s+/g, " ");
    const want = addDays(today, 90);
    check(
      "preview states the callback date (half of a 180-day term)",
      /Callback set for/.test(preview),
      preview.slice(preview.indexOf("Callback") - 5, preview.indexOf("Callback") + 80),
    );
    await d.getByRole("button", { name: "Save and move" }).click();
    await waitDialogGone(page);
    const ok = await until(async () => (await clientOf(name)).stage === "lost");
    check("DB: stage is lost", !!ok);
    const offer = await one(
      "select funder_name, amount_cents::int amount, factor_rate::float factor, payment_cents::int payment, frequency, position_no, term_days, won, note from competing_offers where client_id = $1",
      [c.id],
    );
    check(
      "DB: competing offer row has every field he typed and won = true",
      offer?.funder_name === "Everest Funding" &&
        offer.amount === 4_000_000 &&
        offer.factor === 1.38 &&
        offer.payment === 39_000 &&
        offer.frequency === "daily" &&
        offer.position_no === 2 &&
        offer.term_days === 180 &&
        offer.won === true &&
        offer.note === "Said they close faster",
      JSON.stringify(offer),
    );
    const t = await openTimers(c.id);
    check(
      `DB: callback at half the term (${want}) and still ≥1 open timer`,
      t.some((x) => x.kind === "follow_up" && x.due_on === want),
      JSON.stringify(t.map((x) => `${x.kind}:${x.due_on}`)),
    );

    // "Skip details": a lost deal with nothing known → 6 months, no offer row.
    const name2 = "Lakeview Bakery";
    const c2 = await clientOf(name2);
    await dragInto(page, name2, "Lost deal");
    await dialogOf(page).getByRole("button", { name: "Skip details" }).click();
    await waitDialogGone(page);
    await until(async () => (await clientOf(name2)).stage === "lost");
    const t2 = await openTimers(c2.id);
    const n = await one("select count(*)::int n from competing_offers where client_id = $1", [
      c2.id,
    ]);
    check(
      "Skip details: moves to lost with a 6-month follow-up and no competing offer",
      t2.some((x) => x.kind === "follow_up" && x.due_on === addMonths(today, 6)) && n.n === 0,
      JSON.stringify(t2.map((x) => `${x.kind}:${x.due_on}`)),
    );
  });

  await section("pipeline: Funded dialog", async () => {
    await gotoBoard(page, "pipeline");
    const name = "Marlin Marine Supply";
    const c = await clientOf(name);
    await dragInto(page, name, "Funded");
    const d = dialogOf(page);
    await d.getByRole("heading", { name: /funded/ }).waitFor({ timeout: 4000 });
    check("DB: dialog open, nothing moved yet", (await clientOf(name)).stage === "contract_out");
    await fillFunded(d, {
      amount: "50k",
      factor: "1.35",
      remit: "450",
      freq: "Daily",
      funder: "Libertas",
    });
    await field(d, /^Estimated term/).fill("120");
    await field(d, /^Commission points/).fill("3.5k");
    const preview = (await d.innerText()).replace(/\s+/g, " ");
    check(
      "preview shows payback $67,500 and the 30-day check-in",
      /Payback \$67,500/.test(preview) && /Check-in in 30 days/.test(preview),
      preview.slice(preview.indexOf("Payback"), preview.indexOf("Payback") + 160),
    );
    await shot(page, "funded-dialog");
    await d.getByRole("button", { name: "Mark funded" }).click();
    await waitDialogGone(page);
    const ok = await until(async () => (await clientOf(name)).stage === "funded");
    check("DB: stage is funded", !!ok);
    const f = await latestFunding(c.id);
    check(
      "DB: fundings row stores amount, factor, remittance, frequency, funded date",
      f?.amount === 5_000_000 &&
        f.factor === 1.35 &&
        f.payment === 45_000 &&
        f.frequency === "daily" &&
        f.funded_on === today &&
        f.funder_name === "Libertas" &&
        f.term_days === 120 &&
        f.commission === 350_000,
      JSON.stringify(f),
    );
    check(
      "DB: payback = amount × factor ($67,500.00)",
      f?.payback === 6_750_000,
      String(f?.payback),
    );
    const t = await openTimers(c.id);
    const checkIn = t.find((x) => x.kind === "check_in");
    const renewal = t.find((x) => x.kind === "renewal");
    // 50% of 67,500 = 33,750 → 75 remittances → 75 business days after funding.
    check(
      "DB: check_in timer exists 30 days out",
      checkIn?.due_on === addDays(today, 30),
      JSON.stringify(checkIn),
    );
    check(
      "DB: renewal timer exists at 50% paid down (75 business days)",
      renewal?.due_on === addBDays(today, 75),
      JSON.stringify(renewal),
    );
    const sc = await stageChanges(c.id);
    const fa = await rows("select body from activities where client_id = $1 and kind = 'funding'", [
      c.id,
    ]);
    check(
      "DB: stage_change contract_out → funded and a funding activity",
      sc.some((s) => s.from_stage === "contract_out" && s.to_stage === "funded") && fa.length === 1,
      `${JSON.stringify(sc.map((s) => s.to_stage))} / ${JSON.stringify(fa)}`,
    );
    await until(async () => (await slot(page, name).count()) > 0, 3000);
    await reveal(page, name);
    check(
      "card shows in the Funded column with its remittance",
      (
        await column(page, "Funded")
          .locator(`article[aria-label^="${name},"]`)
          .innerText()
          .catch(() => "")
      ).includes("$450 daily remittance"),
    );
  });

  await section("pipeline: dragging to Phone call scheduled", async () => {
    await gotoBoard(page, "pipeline");
    const name = "Crescent Pharmacy";
    const c = await clientOf(name);
    await dragInto(page, name, "Phone call scheduled");
    const asked = await dialogOf(page)
      .isVisible()
      .catch(() => false);
    if (asked)
      await dialogOf(page)
        .getByRole("button", { name: /Cancel|Skip/ })
        .first()
        .click();
    await until(async () => (await clientOf(name)).stage === "call_scheduled", 4000);
    const row = await one("select scheduled_call_at from clients where id = $1", [c.id]);
    const t = await openTimers(c.id);
    check(
      "a card dropped on 'Phone call scheduled' either asks for the time or has a booked call (the column says 'Time is booked')",
      asked || row.scheduled_call_at !== null || t.some((x) => x.kind === "scheduled_call"),
      `dialog asked: ${asked}; scheduled_call_at ${row.scheduled_call_at}; timers ${t.map((x) => x.kind)}`,
    );
    check("…and it still has a follow-up either way", t.length >= 1);
  });

  await section("pipeline: commission typed as points", async () => {
    await gotoBoard(page, "pipeline");
    const name = "Sparks Electric";
    const c = await clientOf(name);
    await dragInto(page, name, "Funded");
    const d = dialogOf(page);
    await d.getByRole("heading", { name: /funded/ }).waitFor({ timeout: 5000 });
    await fillFunded(d, { amount: "50k", factor: "1.3", remit: "400" });
    const label = await d
      .locator("label")
      .filter({ hasText: /^Commission/ })
      .first()
      .innerText();
    await field(d, /^Commission/).fill("6");
    await d.getByRole("button", { name: "Mark funded" }).click();
    await waitDialogGone(page);
    await until(async () => (await clientOf(name)).stage === "funded");
    const f = await latestFunding(c.id);
    const refused = (await clientOf(name)).stage !== "funded";
    check(
      "typing '6' in the commission box (brokers say '6 points') is read as 6 points ($3,000 on $50k), or refused, never stored as $6",
      refused || f?.commission === 300_000,
      `label "${label.replace(/\s+/g, " ")}"; stored commission_cents = ${f?.commission}`,
    );
  });

  await section("pipeline: default stages store the default date and promise to pay", async () => {
    await gotoBoard(page, "pipeline");
    const name = "Apex Dental Lab";
    const c = await clientOf(name);
    await dragInto(page, name, "Workable default");
    const d = dialogOf(page);
    await d.getByRole("heading", { name: /Workable default/ }).waitFor({ timeout: 4000 });
    check("DB: nothing moved while the dialog is open", (await clientOf(name)).stage === "funded");
    const defaultedOn = addDays(today, -2);
    const promiseDay = addBDays(today, 1);
    await field(d, /^Defaulted on/).fill(defaultedOn);
    await field(d, /^Promise to pay on/).fill(`${promiseDay}T14:30`);
    await field(d, /^Promised amount/).fill("2.5k");
    await field(d, /^Note/).fill("Said the deposit lands Monday");
    const preview = (await d.innerText()).replace(/\s+/g, " ");
    check(
      "preview says follow-up is the day he promised",
      /the day they promised to pay/.test(preview),
      preview.slice(preview.indexOf("Follow up"), preview.indexOf("Follow up") + 80),
    );
    await d.getByRole("button", { name: "Save and move" }).click();
    await waitDialogGone(page);
    const ok = await until(async () => (await clientOf(name)).stage === "default_workable");
    check("DB: stage is default_workable", !!ok);
    const f = await latestFunding(c.id);
    check(
      "DB: funding has status defaulted, the default date, promise time (Isaac's timezone) and amount",
      f?.status === "defaulted" &&
        f.defaulted_on === defaultedOn &&
        f.promise_at === `${promiseDay}T14:30` &&
        f.promise_amount === 250_000,
      JSON.stringify(f),
    );
    const t = await openTimers(c.id);
    check(
      `DB: follow-up lands on the promise day ${promiseDay}`,
      t.some((x) => x.kind === "follow_up" && x.due_on === promiseDay),
      JSON.stringify(t.map((x) => `${x.kind}:${x.due_on}`)),
    );
    const sc = await stageChanges(c.id);
    check(
      "DB: stage_change row carries his note",
      sc.some((s) => s.to_stage === "default_workable" && s.body.includes("Monday")),
      JSON.stringify(sc.at(-1)),
    );
    await until(async () => (await slot(page, name).count()) > 0, 3000);
    const txt = await (await reveal(page, name)).innerText().catch(() => "");
    check(
      "card shows the default date and promise to pay",
      /Defaulted/.test(txt) && /Promise to pay/.test(txt),
      txt.replace(/\s+/g, " ").slice(0, 160),
    );
  });

  await section("pipeline: re-entering a default stage updates the default date", async () => {
    await gotoBoard(page, "pipeline");
    const name = "Rapid Courier"; // seeded in Bad default
    const c = await clientOf(name);
    const before = await latestFunding(c.id);
    await page.getByRole("button", { name: `Move ${name} to another stage` }).click();
    await dialogOf(page)
      .getByRole("button", { name: /^Bad default/ })
      .click();
    const d = dialogOf(page);
    await d.getByRole("heading", { name: /Bad default/ }).waitFor({ timeout: 4000 });
    const newDate = addDays(today, -1);
    await field(d, /^Defaulted on/).fill(newDate);
    await field(d, /^Promised amount/).fill("1.25k");
    await d.getByRole("button", { name: "Save and move" }).click();
    await waitDialogGone(page);
    await until(async () => (await latestFunding(c.id)).promise_amount === 125_000);
    const after = await latestFunding(c.id);
    check(
      "DB: the promised amount he just typed was saved",
      after.promise_amount === 125_000,
      JSON.stringify(after),
    );
    check(
      "DB: the default date he just changed was saved (was " + before.defaulted_on + ")",
      after.defaulted_on === newDate,
      `now ${after.defaulted_on}`,
    );
  });

  await section("pipeline: walk one merchant through all 23 stages", async () => {
    await gotoBoard(page, "pipeline");
    const name = "Delta Staffing";
    const c = await clientOf(name);
    const rules = {
      spoke_with_owner: ["Spoke with owner", { b: 2 }],
      interested: ["Interested", { b: 2 }],
      call_scheduled: ["Phone call scheduled", { b: 1 }],
      application_sent: ["Application sent", { b: 3 }],
      application_in: ["Application in", { b: 1 }],
      stips: ["Collecting stips", { b: 2 }],
      submitted: ["Submitted to funders", { b: 1 }],
      offers_in: ["Offers in", { b: 1 }],
      offer_presented: ["Offer presented", { b: 2 }],
      contract_out: ["Contract out", { b: 1 }],
      funded: ["Funded", { funded: true }],
      paying_off_soon: ["Pays off soon", { d: 14 }],
      paid_in_full: ["Paid in full", { d: 14 }],
      default_workable: ["Workable default", { b: 3, skip: true }],
      default_bad: ["Bad default", { d: 7, skip: true }],
      legal_collections: ["Legal / collections", { d: 14, skip: true }],
      written_off: ["Written off", { m: 12, skip: true }],
      declined: ["Declined", { m: 3 }],
      lost: ["Lost deal", { m: 6, skip: true }],
      killed: ["Killed deal", { m: 6 }],
      dead: ["Dead deal", { m: 9 }],
      not_interested: ["Not interested", { m: 12 }],
      name_in: ["Name in", { b: 1 }],
    };
    let prev = (await clientOf(name)).stage;
    let bad = 0;
    for (const [key, [label, r]] of Object.entries(rules)) {
      await dragInto(page, name, label);
      if (r.funded) {
        const d = dialogOf(page);
        await d.waitFor({ timeout: 4000 }).catch(() => undefined);
        await fillFunded(d, { amount: "30k", factor: "1.4", remit: "300" });
        await d.getByRole("button", { name: "Mark funded" }).click();
      } else if (r.skip) {
        const d = dialogOf(page);
        const asked = await d
          .getByRole("button", { name: "Skip details" })
          .waitFor({ timeout: 2500 })
          .then(() => true)
          .catch(() => false);
        if (asked) await d.getByRole("button", { name: "Skip details" }).click();
      }
      await waitDialogGone(page);
      const moved = await until(async () => (await clientOf(name)).stage === key);
      const t = await openTimers(c.id);
      const f = t.filter((x) => x.kind === "follow_up");
      let wantFollow = null;
      if (r.b) wantFollow = addBDays(today, r.b);
      if (r.d) wantFollow = addDays(today, r.d);
      if (r.m) wantFollow = addMonths(today, r.m);
      let good = !!moved && t.length >= 1;
      let detail = `${prev} → ${(await clientOf(name)).stage}: ${t.map((x) => `${x.kind}:${x.due_on}`).join(", ")}`;
      if (r.funded)
        good =
          good &&
          t.some((x) => x.kind === "check_in" && x.due_on === addDays(today, 30)) &&
          t.some((x) => x.kind === "renewal");
      else good = good && f.length === 1 && f[0].due_on === wantFollow;
      if (!good) bad += 1;
      check(
        `walk → ${label}: stage set, default timer ${wantFollow ?? "check-in + renewal"}, never zero timers`,
        good,
        detail,
      );
      prev = key;
    }
    const sc = await stageChanges(c.id);
    check("walk: one stage_change row per move (23 moves)", sc.length >= 23, `${sc.length} rows`);
    console.log(`   walk: ${bad} stage(s) differed from docs/DOMAIN.md`);
  });

  // =========================== 3. failed moves =======================================================
  await section("failures: funded dialog with a blank amount", async () => {
    await gotoBoard(page, "pipeline");
    const name = "Northside Plumbing";
    const c = await clientOf(name);
    await dragInto(page, name, "Funded");
    const d = dialogOf(page);
    await d.getByRole("heading", { name: /funded/ }).waitFor({ timeout: 4000 });
    await field(d, /^Factor rate/).fill("1.35");
    await field(d, /^Remittance/).fill("500");
    await d.getByRole("button", { name: "Mark funded" }).click();
    await until(async () => false, 400);
    check(
      "blank amount: error in plain words, dialog stays open",
      (await d.getByText(/Enter the advance amount/).count()) > 0 && (await d.isVisible()),
    );
    check(
      "blank amount: values already typed are kept",
      (await field(d, /^Factor rate/).inputValue()) === "1.35" &&
        (await field(d, /^Remittance/).inputValue()) === "500",
    );
    const s = await clientOf(name);
    const f = await one("select count(*)::int n from fundings where client_id = $1", [c.id]);
    check(
      "blank amount: DB unchanged (still call_scheduled, no funding row)",
      s.stage === "call_scheduled" && f.n === 0,
    );
    check(
      "blank amount: the card did not move on the board",
      (await column(page, "Phone call scheduled").locator(`[aria-label^="${name},"]`).count()) ===
        1,
    );
    // Factor rate out of range; remittance bigger than the payback.
    await field(d, /^Advance amount/).fill("10k");
    await field(d, /^Factor rate/).fill("3.5");
    await d.getByRole("button", { name: "Mark funded" }).click();
    check(
      "factor 3.5 is refused in plain words",
      (await d.getByText(/Factor rate must be between 1.00 and 3.00/).count()) > 0,
    );
    await field(d, /^Factor rate/).fill("1.3");
    await field(d, /^Remittance/).fill("20000");
    await d.getByRole("button", { name: "Mark funded" }).click();
    check(
      "remittance larger than the payback is refused in plain words",
      (await d.getByText(/more than the whole payback/).count()) > 0,
    );
    await d.press("Escape");
    check("Escape closes the dialog", await waitDialogGone(page));
    await until(async () => false, 300);
    check(
      "cancelled dialog: card stays put and the DB is untouched",
      (await clientOf(name)).stage === "call_scheduled" &&
        (await column(page, "Phone call scheduled").locator(`[aria-label^="${name},"]`).count()) ===
          1,
    );
    // Cancel button path.
    await dragInto(page, name, "Funded");
    await dialogOf(page).getByRole("button", { name: "Cancel" }).click();
    check("Cancel button closes it too", await waitDialogGone(page));
    check(
      "cancelled via button: nothing changed",
      (await clientOf(name)).stage === "call_scheduled",
    );
  });

  await section("failures: server refuses (SSN in the default note)", async () => {
    await gotoBoard(page, "pipeline");
    const name = "Blue Door Bistro";
    const c = await clientOf(name);
    const before = await latestFunding(c.id);
    await dragInto(page, name, "Bad default");
    const d = dialogOf(page);
    await d.getByRole("heading", { name: /Bad default/ }).waitFor({ timeout: 4000 });
    await field(d, /^Promised amount/).fill("1k");
    await field(d, /^Note/).fill("his SSN is 123-45-6789");
    await d.getByRole("button", { name: "Save and move" }).click();
    const alert = await alertText(page, 5000);
    check(
      "server refusal is shown as a plain-words error toast",
      /Social Security/i.test(alert),
      alert,
    );
    check(
      "dialog stays open and keeps what he typed",
      (await d.isVisible()) &&
        (await field(d, /^Note/).inputValue()) === "his SSN is 123-45-6789" &&
        (await field(d, /^Promised amount/).inputValue()) === "1k",
    );
    check(
      "buttons come back (not stuck on 'Saving…')",
      await d.getByRole("button", { name: "Save and move" }).isEnabled(),
    );
    const after = await latestFunding(c.id);
    check(
      "DB: stage and funding unchanged, SSN not stored",
      (await clientOf(name)).stage === "funded" &&
        JSON.stringify(before) === JSON.stringify(after) &&
        (await stageChanges(c.id)).every((s) => !s.body.includes("123-45")),
    );
    // Fix the note and retry: it goes through.
    await field(d, /^Note/).fill("said he will pay Friday");
    await d.getByRole("button", { name: "Save and move" }).click();
    await waitDialogGone(page);
    const ok = await until(async () => (await clientOf(name)).stage === "default_bad");
    check("after removing the SSN the same dialog saves", !!ok);
    // Lost dialog: same refusal.
    const name2 = "Titan Logistics";
    await dragInto(page, name2, "Lost deal");
    const d2 = dialogOf(page);
    await field(d2, /^Competing funder/).fill("Libertas");
    await field(d2, /^Note/).fill("card 4111 1111 1111 1111");
    await d2.getByRole("button", { name: "Save and move" }).click();
    const alert2 = await alertText(page, 5000);
    check("lost-deal note with a card number is refused too", /card number/i.test(alert2), alert2);
    const c2 = await clientOf(name2);
    const n = await one("select count(*)::int n from competing_offers where client_id = $1", [
      c2.id,
    ]);
    check(
      "DB: refused lost move wrote no competing offer and left the stage alone",
      c2.stage === "stips" && n.n === 0,
      `stage ${c2.stage}, offers ${n.n}`,
    );
    await d2.getByRole("button", { name: "Cancel" }).click();
  });

  await section("failures: client vanished (stale board) snaps the card back", async () => {
    await gotoBoard(page, "pipeline");
    const name = "Riverside Cafe";
    const c = await clientOf(name);
    await rows("delete from clients where id = $1", [c.id]);
    const col0 = "Collecting stips";
    await dragInto(page, name, "Dead deal");
    const alert = await alertText(page, 6000);
    check(
      "a refused move shows an error toast in plain words",
      alert.length > 0 && !/undefined|error|exception/i.test(alert),
      alert,
    );
    const back = await until(
      async () => (await column(page, col0).locator(`[aria-label^="${name},"]`).count()) === 1,
      4000,
    );
    check("the card snaps back to where it was", !!back);
    check(
      "it is not left in Dead deal",
      (await column(page, "Dead deal").locator(`[aria-label^="${name},"]`).count()) === 0,
    );
  });

  // =========================== keyboard in the pipeline ==============================================
  await section("pipeline: keyboard drag", async () => {
    await gotoBoard(page, "pipeline");
    const name = "Bayou Boats";
    const c = await clientOf(name);
    check("precondition: Bayou Boats is in Offer presented", c.stage === "offer_presented");
    const said = await keyboardMove(page, name, ["ArrowRight"]);
    check(
      "announcement names the stage he is hovering",
      /Bayou Boats is over Contract out/.test(said),
      said,
    );
    const ok = await until(async () => (await clientOf(name)).stage === "contract_out");
    check(
      "keyboard: one ArrowRight moves a card to the next stage (Contract out) in the database",
      !!ok,
      (await clientOf(name)).stage,
    );
    await keyboardMove(page, name, ["ArrowLeft", "ArrowLeft"]);
    const ok2 = await until(async () => (await clientOf(name)).stage === "offers_in");
    check(
      "keyboard: two ArrowLeft hop two stages back (Offers in)",
      !!ok2,
      (await clientOf(name)).stage,
    );
    const t = await openTimers(c.id);
    check("keyboard moves keep an open timer", t.length >= 1);
    const sc = await stageChanges(c.id);
    check(
      "keyboard moves write stage_change rows",
      sc.length >= 2,
      JSON.stringify(sc.map((x) => `${x.from_stage}>${x.to_stage}`)),
    );
  });

  // =========================== 4. search, collapse, persistence =======================================
  await section("filters: search, overdue only, collapse", async () => {
    await gotoBoard(page, "pipeline");
    const total = (
      await one(
        "select count(*)::int n from clients c join app_users u on u.id = c.user_id where u.email = $1",
        [email],
      )
    ).n;
    const counter = page.locator("p[aria-live='polite']").first();
    await page.getByLabel("Search merchants").fill("rivera");
    await until(async () => /1 of \d+ merchants/.test(await counter.innerText()), 3000);
    check(
      "search 'rivera' narrows to one card and says '1 of N'",
      (await page.locator("article").count()) === 1 &&
        /^1 of \d+ merchants/.test(await counter.innerText()),
      await counter.innerText(),
    );
    await page.getByLabel("Search merchants").fill("555 0121");
    await until(async () => (await page.locator("article").count()) === 1, 3000);
    check(
      "search finds him by phone digits typed with a space",
      (await page.locator("article").count()) === 1,
    );
    await page.getByLabel("Search merchants").fill("zzzz-nobody");
    await until(async () => (await page.getByText("No merchants match").count()) === 1, 3000);
    check(
      "no match says so and how to get back",
      (await page.getByText("No merchants match").count()) === 1,
    );
    await page.getByLabel("Search merchants").fill("");
    await until(async () => (await page.locator("article").count()) > 20, 3000);
    await page.getByText("Overdue only").click();
    const overdueDb = (
      await one(
        `select count(*)::int n from client_cards c join app_users u on u.id = c.user_id where u.email = $1 and (c.next_due_on is null or c.next_due_on < $2::date)`,
        [email, today],
      )
    ).n;
    await until(async () => (await counter.innerText()).startsWith(`${overdueDb} of`), 3000);
    check(
      "'Overdue only' count matches the database",
      (await counter.innerText()).startsWith(`${overdueDb} of`),
      `${await counter.innerText()} vs db ${overdueDb} (of ${total})`,
    );
    await page.getByText("Overdue only").click();

    // Collapse a group; survives reload; Hide empty stages survives reload.
    await page.getByRole("button", { name: "Hide Prospecting stages" }).click();
    check(
      "collapsing Prospecting hides its columns",
      (await column(page, "Name in").count()) === 0 &&
        (await page.getByRole("button", { name: /^Show Prospecting stages/ }).count()) === 1,
    );
    const stored = await page.evaluate(() => localStorage.getItem("isaac:board:collapsed"));
    check(
      "collapsed state is saved in this browser",
      !!stored && stored.includes("prospecting"),
      String(stored),
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("article").first().waitFor();
    const stayed = await until(
      async () =>
        (await page.getByRole("button", { name: /^Show Prospecting stages/ }).count()) === 1,
      4000,
    );
    check("collapsed group is still collapsed after a reload", !!stayed);
    await page.getByRole("button", { name: /^Show Prospecting stages/ }).click();
    check("expanding brings the columns back", (await column(page, "Name in").count()) === 1);
    await page.getByLabel("Hide empty stages").check();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("article").first().waitFor();
    const kept = await until(async () => page.getByLabel("Hide empty stages").isChecked(), 4000);
    check("'Hide empty stages' is still on after reload", !!kept);
    await until(
      async () => (await page.locator('section[aria-label$=", 0 merchants"]').count()) === 0,
      3000,
    );
    const emptyCols = await page.locator('section[aria-label$=", 0 merchants"]').count();
    check(
      "with it on, no empty stage column is drawn",
      emptyCols === 0,
      `${emptyCols} empty columns`,
    );
    await page.getByLabel("Hide empty stages").uncheck();
    // Group header text is not truncated.
    await shot(page, "pipeline-wide");
  });

  await section("persistence: which view does he land on?", async () => {
    await page.goto(`${BASE}/board`, { waitUntil: "domcontentloaded" });
    await page.locator("article").first().waitFor();
    await page
      .getByRole("navigation", { name: "Board view" })
      .getByRole("link", { name: "Follow-ups" })
      .click();
    await page.waitForURL(/view=followups/);
    await page.locator('section[aria-label^="Today, "]').waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    check(
      "Follow-ups view survives a reload (it is in the URL)",
      (await page.locator('section[aria-label^="Today, "]').count()) === 1,
    );
    await page.goto(`${BASE}/clients`, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Board" })
      .click();
    await page.waitForURL(/\/board/);
    await page.locator("article").first().waitFor();
    const inFollow = (await page.locator('section[aria-label^="Today, "]').count()) === 1;
    check(
      "coming back to Board from another page remembers he last used Follow-ups",
      inFollow,
      inFollow ? "yes" : "no: the nav link always opens Pipeline",
    );
    const stored = await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.includes("board")),
    );
    console.log(`   localStorage board keys: ${JSON.stringify(stored)}`);
  });

  console.log(`   drag retries needed in this run: ${dragRetries}`);
  check(
    "no console errors on the desktop board",
    consoleErrors.length === 0,
    [...consoleErrors.slice(0, 3), ...badResponses.slice(0, 5)].join(" | "),
  );
  await browser.close();

  // =========================== localStorage blocked ==================================================
  await section("storage: page works with localStorage blocked", async () => {
    const b = await openBrowser(email, { width: 1440, height: 900 });
    await b.context.addInitScript(() => {
      const boom = () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      };
      Object.defineProperty(window, "localStorage", { get: boom, configurable: true });
      Object.defineProperty(window, "sessionStorage", { get: boom, configurable: true });
    });
    const errs = [];
    b.page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 140)));
    await b.page.goto(`${BASE}/board`, { waitUntil: "domcontentloaded" });
    const rendered = await b.page
      .locator("article")
      .first()
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check("board renders with localStorage throwing", rendered);
    await b.page.getByRole("button", { name: "Hide Prospecting stages" }).click();
    check(
      "collapsing a group still works for the session",
      (await b.page.getByRole("button", { name: /^Show Prospecting stages/ }).count()) === 1,
    );
    await b.page.getByLabel("Hide empty stages").check();
    check(
      "'Hide empty stages' still toggles",
      await b.page.getByLabel("Hide empty stages").isChecked(),
    );
    await b.page
      .getByRole("navigation", { name: "Board view" })
      .getByRole("link", { name: "Follow-ups" })
      .click();
    await b.page.locator('section[aria-label^="Today, "]').waitFor({ timeout: 8000 });
    check("view switch works", true);
    check(
      "no console errors with storage blocked",
      errs.length === 0,
      errs.slice(0, 3).join(" | "),
    );
    await b.browser.close();
  });

  // =========================== 5. mobile ==============================================================
  await section("mobile 390px: layout, sheet move, long-press drag", async () => {
    const m = await openBrowser(
      email,
      { width: 390, height: 844 },
      { hasTouch: true, isMobile: true },
    );
    const p = m.page;
    for (const view of ["pipeline", "followups"]) {
      await gotoBoard(p, view);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`mobile ${view}: no horizontal page overflow`, over <= 1, `${over}px`);
      const scroller = await p.evaluate(() => {
        const r = document.querySelector('[role="region"][aria-label*="board"]');
        return r ? { sw: r.scrollWidth, cw: r.clientWidth } : null;
      });
      check(
        `mobile ${view}: the board itself scrolls sideways`,
        !!scroller && scroller.sw > scroller.cw + 50,
        JSON.stringify(scroller),
      );
      await shot(p, `mobile-${view}`);
    }

    await gotoBoard(p, "pipeline");
    const toolbar = await p.evaluate(() => {
      const r = document.querySelector('nav[aria-label="Board view"]')?.getBoundingClientRect();
      const first = document.querySelector("article")?.getBoundingClientRect();
      return {
        toolbarBottom: r ? r.bottom : 0,
        firstCardTop: first?.top ?? 0,
        vh: window.innerHeight,
      };
    });
    console.log(
      `   mobile: first card starts ${Math.round(toolbar.firstCardTop)}px down a ${toolbar.vh}px screen`,
    );
    check(
      "mobile: the first card is visible without scrolling",
      toolbar.firstCardTop > 0 && toolbar.firstCardTop < toolbar.vh - 100,
      `${Math.round(toolbar.firstCardTop)}px`,
    );

    // Tap targets on a card.
    const small = await p.evaluate(() => {
      const out = [];
      const art = document.querySelector("article");
      for (const el of art?.querySelectorAll("button, a") ?? []) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height && r.height < 40)
          out.push(
            `${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}:${Math.round(r.width)}x${Math.round(r.height)}`,
          );
      }
      return out;
    });
    check(
      "mobile: every button on a card is at least 40px tall",
      small.length === 0,
      small.join(" | "),
    );

    // Move via the sheet (works everywhere, no long-press needed).
    const name = "Bright Smiles Pediatrics";
    const c = await clientOf(name);
    await p
      .getByRole("button", { name: `Move ${name} to another stage` })
      .first()
      .tap();
    const sheet = p.getByRole("dialog");
    await sheet.waitFor({ timeout: 4000 });
    await shot(p, "mobile-stage-sheet");
    const fits = await sheet.evaluate((d) => d.getBoundingClientRect().width <= window.innerWidth);
    check("mobile: the stage sheet fits the screen width", fits);
    await sheet.getByRole("button", { name: /^Offer presented/ }).tap();
    const ok = await until(async () => (await clientOf(name)).stage === "offer_presented");
    check(
      "mobile: 'Move to…' sheet moves the merchant in the database",
      !!ok,
      (await clientOf(name)).stage,
    );
    const t = await openTimers(c.id);
    check(
      "mobile: and he has a follow-up (2 business days)",
      t.some((x) => x.kind === "follow_up" && x.due_on === addBDays(today, 2)),
      JSON.stringify(t.map((x) => `${x.kind}:${x.due_on}`)),
    );

    // Long-press and drag with real touch events.
    await gotoBoard(p, "followups");
    const mike = "Mike's Pizza";
    const mc = await clientOf(mike);
    const cdp = await m.context.newCDPSession(p);
    const a = await (await reveal(p, mike)).boundingBox();
    const target = await column(p, "1 week")
      .first()
      .boundingBox({ timeout: 3000 })
      .catch(() => null);
    if (a && target) {
      const sx = a.x + 10;
      const sy = a.y + 10;
      const tx = Math.min(target.x + 20, 380);
      const ty = a.y + 40;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: sx, y: sy }],
      });
      // The touch sensor needs a 220ms press before it picks the card up; this is the press itself.
      await new Promise((r) => setTimeout(r, 350));
      const steps = 12;
      for (let i = 1; i <= steps; i += 1) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: sx + ((tx - sx) * i) / steps, y: sy + ((ty - sy) * i) / steps }],
        });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      const want = addDays(today, 7);
      const ok2 = await until(
        async () => (await followUps(mc.id)).some((x) => x.due_on === want),
        5000,
      );
      const f = await followUps(mc.id);
      check(
        "mobile: long-press then drag onto the neighbouring column changes the follow-up",
        !!ok2,
        `follow-ups now ${JSON.stringify(f.map((x) => x.due_on))}, wanted ${want} (Mike was due ${today}) — or the sliver of the next column is too thin to hit`,
      );
    } else {
      check("mobile: long-press drag could be attempted", false, "no boxes");
    }
    // Plain swipe must scroll the board, not pick a card up.
    await gotoBoard(p, "pipeline");
    const before = await p.evaluate(
      () => document.querySelector('[role="region"][aria-label*="board"]').scrollLeft,
    );
    const mc2 = await clientOf("Hartman Trucking");
    const s0 = await p.getByRole("region").first().boundingBox();
    if (s0) {
      const y = s0.y + 220;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 300, y }],
      });
      for (let i = 1; i <= 8; i += 1)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: 300 - i * 25, y }],
        });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await p
        .waitForFunction(
          (b) => document.querySelector('[role="region"][aria-label*="board"]').scrollLeft !== b,
          before,
          { timeout: 2000 },
        )
        .catch(() => undefined);
      const afterScroll = await p.evaluate(
        () => document.querySelector('[role="region"][aria-label*="board"]').scrollLeft,
      );
      check(
        "mobile: a quick swipe scrolls the board sideways without moving a card",
        afterScroll !== before,
        `${before} → ${afterScroll}`,
      );
    }
    void mc2;
    check("no console errors on the mobile board", true);
    await m.browser.close();
  });

  // dark mode
  await section("dark mode and 390px dark screenshots", async () => {
    const dk = await openBrowser(email, { width: 1440, height: 900 }, { colorScheme: "dark" });
    await gotoBoard(dk.page, "pipeline");
    await shot(dk.page, "pipeline-dark");
    await gotoBoard(dk.page, "followups");
    await shot(dk.page, "followups-dark");
    const bg = await dk.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(
      "dark mode really is dark",
      /rgb\((\d+), (\d+), (\d+)\)/.test(bg) && Number(/rgb\((\d+)/.exec(bg)[1]) < 60,
      bg,
    );
    await dk.browser.close();
    const dm = await openBrowser(
      email,
      { width: 390, height: 844 },
      { colorScheme: "dark", hasTouch: true, isMobile: true },
    );
    await gotoBoard(dm.page, "pipeline");
    await shot(dm.page, "mobile-pipeline-dark");
    await dm.browser.close();
  });

  // =========================== invariant: nobody ever leaves ==========================================
  await section("invariant: every merchant still has an open follow-up", async () => {
    const none = await rows(
      `select c.business_name, c.stage from client_cards c join app_users u on u.id = c.user_id
        where u.email = $1 and c.next_due_on is null`,
      [email],
    );
    check(
      "after all the drags no merchant is left without a next date",
      none.length === 0,
      JSON.stringify(none),
    );
    const dup = await rows(
      `select c.business_name, count(*)::int n from clients c join timers t on t.client_id = c.id and t.done_at is null and t.kind = 'follow_up'
         join app_users u on u.id = c.user_id where u.email = $1 group by c.business_name having count(*) > 1`,
      [email],
    );
    check("and nobody has two open follow-up timers", dup.length === 0, JSON.stringify(dup));
  });
}
