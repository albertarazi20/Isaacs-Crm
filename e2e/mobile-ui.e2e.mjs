// Phone fixes from docs/ISSUES.md: I-11 (disabled Call/Text says why), I-14 (Merchants on a phone), I-18 (follow-up
// picker starts empty), I-19 (styled file chooser).
// The 40px tap-target rule (I-12) and the note box position (I-13) are checked by client.e2e.
//   pnpm -s e2e mobile-ui        E2E_SHOTS=/some/dir to keep the 390px screenshots
import { mkdirSync, writeFileSync } from "node:fs";
import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const SHOTS = process.env.E2E_SHOTS ?? "/tmp/e2e-shots/mobile-ui";
mkdirSync(SHOTS, { recursive: true });
const rows = (sql, params = []) => withDb((db) => db.query(sql, params)).then((r) => r.rows);
const one = async (sql, params = []) => (await rows(sql, params))[0];
const until = async (fn, timeout = 7000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 120));
  }
};
const shot = (page, name, full = false) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full }).catch(() => undefined);
const ONLY = process.env.E2E_ONLY ?? "";
const on = (name) => !ONLY || ONLY.split("|").some((o) => name.includes(o));
const PHONE = { width: 390, height: 844 };
/** Waits for a smooth scroll to stop (the same scrollLeft twice, 120ms apart). */
/** A phone shrinks a too-wide page to fit (innerWidth grows past 390), so compare against 390 itself, not innerWidth. */
const pageFits = (p) =>
  p
    .evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }))
    .then((x) => ({ ...x, ok: x.sw <= 390 && x.iw === 390 }));
const TOUCH = { hasTouch: true, isMobile: true };

export default async function mobileUi({ email }) {
  const client = (name) =>
    one(
      `select c.id, c.phone from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = $2`,
      [email, name],
    );
  const followUps = async (id) =>
    (
      await rows(
        "select due_on::text due_on from timers where client_id = $1 and done_at is null and kind = 'follow_up'",
        [id],
      )
    ).map((r) => r.due_on);
  const today = (
    await one(
      "select (now() at time zone (select timezone from app_users where email = $1))::date::text d",
      [email],
    )
  ).d;
  const plusDays = (n) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  // ======================= I-14: Merchants on a phone =======================
  console.log("\n-- I-14 Merchants page on a phone");
  if (on("I-14")) {
    const total = (
      await one(
        "select count(*)::int n from clients c join app_users u on u.id = c.user_id where u.email = $1 and not exists (select 1 from trashed_clients t where t.client_id = c.id)",
        [email],
      )
    ).n;
    const m = await openBrowser(email, PHONE, TOUCH);
    const p = m.page;
    await p.goto(`${BASE}/clients`, { waitUntil: "domcontentloaded" });
    await p.getByRole("heading", { name: /^All merchants/ }).waitFor();
    check(
      "the downloads and Import are not loose buttons on the page",
      (await p.getByRole("link", { name: /^Download (merchants|notes) \(CSV\)/ }).count()) === 0 &&
        (await p.getByRole("main").getByRole("link", { name: "Import a file" }).count()) === 0,
    );
    const more = p.getByRole("button", { name: "Tools" });
    const box = await more.boundingBox();
    check(
      "one Tools menu button holds Import, at least 40px square",
      !!box && box.width >= 40 && box.height >= 40,
      JSON.stringify(box),
    );
    await more.tap();
    // the menu's own panel: the Menu and the cards have links of their own
    const panel = p.locator(`[id="${await more.getAttribute("aria-controls")}"]`);
    const items = (await panel.getByRole("link").allInnerTexts()).map((t) => t.trim());
    check(
      "a rep's menu has Import only: the downloads are for managers (New lead is its own button, Trash is in the Menu)",
      items.join("|") === "Import a file",
      JSON.stringify(items),
    );
    check(
      "New lead sits beside it as the page's one main button, at least 40px tall",
      ((await p.getByRole("main").getByRole("button", { name: "New lead" }).boundingBox())
        ?.height ?? 0) >= 40,
    );
    await shot(p, "clients-menu-open");
    await p.keyboard.press("Escape");
    check(
      "Escape closes the menu",
      (await panel.getByRole("link", { name: "Import a file" }).count()) === 0,
    );
    await more.tap();
    await panel.getByRole("link", { name: "Import a file" }).tap();
    await p.waitForURL(/\/import/);
    check("a menu item goes to its page", /\/import/.test(p.url()));
    await p.goBack();
    await p.getByRole("heading", { name: /^All merchants/ }).waitFor();
    // Trash moved from this menu to the phone's Menu, under Merchants.
    await p.getByRole("button", { name: "Menu" }).tap();
    const menu = p.getByRole("dialog", { name: "Menu" });
    await menu.getByRole("link", { name: /^Trash/ }).tap();
    await p.waitForURL(/\/trash/);
    check(
      "Trash is reached from the Menu, which closes behind it",
      /\/trash/.test(p.url()) && !!(await until(async () => !(await menu.isVisible()))),
    );
    await p.goBack();
    await p.getByRole("heading", { name: /^All merchants/ }).waitFor();

    const first = p.locator("ul[aria-label=Merchants] > li").first();
    await first.waitFor();
    const geo = await p.evaluate(() => {
      const li = document.querySelector("ul[aria-label=Merchants] > li");
      const r = li?.getBoundingClientRect();
      const links = [...document.querySelectorAll("ul[aria-label=Merchants] > li")].length;
      const over = document.documentElement.scrollWidth - innerWidth;
      return {
        top: r?.top ?? -1,
        height: r?.height ?? 0,
        links,
        over,
        vw: innerWidth,
        vh: innerHeight,
      };
    });
    check(
      "the list starts within the first half of the screen",
      geo.top > 0 && geo.top < geo.vh * 0.5,
      `${Math.round(geo.top)}px of ${geo.vh}px`,
    );
    const fit = await pageFits(p);
    check(
      "no sideways scrolling on the page (the phone did not have to shrink it)",
      fit.ok,
      JSON.stringify(fit),
    );
    check(`there is one card per merchant (${total})`, geo.links === total, `${geo.links}`);
    const cardText = await first.innerText();
    // The list opens in follow-up order, so the first card is the merchant due soonest: read his date from the database.
    const soonest = await one(
      `select c.business_name, c.next_due_on::text due from client_cards c join app_users u on u.id = c.user_id
        where u.email = $1 and c.next_due_on is not null order by c.next_due_on, c.business_name limit 1`,
      [email],
    );
    const gap = Math.round(
      (Date.parse(`${soonest.due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
    );
    const dueWords =
      gap === 0
        ? "Today"
        : gap === 1
          ? "Tomorrow"
          : gap < 0
            ? `${-gap} day${gap === -1 ? "" : "s"} overdue`
            : `in ${gap} days`;
    const dueChip = first.getByText(dueWords, { exact: true });
    check(
      "a card says when he is due, in words that match his date in the database",
      cardText.includes(soonest.business_name) && (await dueChip.count()) === 1,
      `${cardText.replace(/\s+/g, " ").slice(0, 120)} — expected "${dueWords}" (${soonest.due})`,
    );
    const visibleDue =
      (await dueChip.count()) === 1 &&
      (await dueChip.evaluate((chip) => {
        const r = chip.getBoundingClientRect();
        return r.width > 0 && r.left >= 0 && r.right <= innerWidth;
      }));
    check("and the due chip is fully on screen (no swipe needed)", visibleDue);
    check(
      "and the stage",
      /Interested|Application|Not interested/.test(cardText),
      cardText.replace(/\s+/g, " ").slice(0, 80),
    );
    const tiny = await p.evaluate(() =>
      [...document.querySelectorAll("main button, main a[href], main select, main input")]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && r.height < 40;
        })
        .map(
          (e) =>
            `${(e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 24)}(${Math.round(e.getBoundingClientRect().height)})`,
        ),
    );
    check(
      "every button, link and field on the page is at least 40px tall",
      tiny.length === 0,
      tiny.slice(0, 8).join(", "),
    );
    await shot(p, "clients-phone");
    await shot(p, "clients-phone-full", true);
    // Searching still narrows the cards.
    await p.getByRole("searchbox", { name: "Search merchants" }).fill("zzz-nobody");
    check(
      "search with no match shows 'No matches' and no cards",
      (await p.getByText("No matches").isVisible()) &&
        (await p.locator("ul[aria-label=Merchants] > li").count()) === 0,
    );
    await m.browser.close();

    const d = await openBrowser(email, { width: 1440, height: 900 });
    await d.page.goto(`${BASE}/clients`, { waitUntil: "domcontentloaded" });
    await d.page.getByRole("heading", { name: /^All merchants/ }).waitFor();
    // By design the desktop header folds Import into the same Tools menu, beside New lead (a rep has no downloads).
    const dMore = d.page.getByRole("button", { name: "Tools" });
    await dMore.click();
    const dItems = (
      await d.page
        .locator(`[id="${await dMore.getAttribute("aria-controls")}"]`)
        .getByRole("link")
        .allInnerTexts()
    ).map((t) => t.trim());
    check(
      "desktop has the same Tools menu beside New lead",
      dItems.join("|") === "Import a file" &&
        (await d.page.getByRole("main").getByRole("button", { name: "New lead" }).isVisible()),
      JSON.stringify(dItems),
    );
    await d.page.keyboard.press("Escape");
    const grid = d.page.getByRole("table", { name: "Merchants" });
    check(
      "desktop keeps the table, one row per merchant, and not the phone's cards",
      (await grid.getByRole("row").count()) === total + 1 &&
        (await grid.getByRole("columnheader", { name: /Next follow-up/ }).isVisible()) &&
        !(await d.page.locator("ul[aria-label=Merchants]").isVisible()),
      `${(await grid.getByRole("row").count()) - 1} rows`,
    );
    await shot(d.page, "clients-desktop");
    await d.browser.close();
  }

  // ======================= I-19: styled file chooser =======================
  console.log("\n-- I-19 Import page file chooser");
  if (on("I-19")) {
    const m = await openBrowser(email, PHONE, TOUCH);
    const p = m.page;
    await p.goto(`${BASE}/import`, { waitUntil: "domcontentloaded" });
    // the chooser is now a drop zone that is also the file input's label ("Drop a CSV here or choose a spreadsheet")
    const chooser = p.locator("label", { hasText: "choose a spreadsheet" });
    await chooser.waitFor();
    const b = await chooser.boundingBox();
    check(
      "a 'choose a spreadsheet' drop zone is there, at least 40px tall",
      !!b && b.height >= 40 && b.width >= 120,
      JSON.stringify(b),
    );
    const native = await p.evaluate(() => {
      const i = document.querySelector("input[type=file]");
      const r = i?.getBoundingClientRect();
      return { w: r?.width ?? -1, h: r?.height ?? -1, clipped: getComputedStyle(i).clip };
    });
    check(
      "the browser's own 'Choose File / No file chosen' control is not drawn",
      native.w <= 1 && native.h <= 1,
      JSON.stringify(native),
    );
    check(
      "it says no file yet in our own words",
      await p.getByText("No file chosen yet").isVisible(),
    );
    await shot(p, "import-before");
    const csv = `${SHOTS}/people.csv`;
    writeFileSync(csv, "Business,Owner,Phone,Amount\nZeta Plumbing,Ann Zeta,(212) 555-0111,25k\n");
    await p.setInputFiles("input[type=file]", csv);
    // a readable file now goes straight to the column check; its name is on the chooser one step back
    check(
      "after choosing a file the wizard reads it (the column check appears, step 2 is current)",
      !!(await until(() => p.getByRole("heading", { name: "Check the columns" }).isVisible())) &&
        /Match columns/.test(await p.locator("button[aria-current=step]").innerText()),
    );
    await shot(p, "import-after");
    await p.getByRole("button", { name: "Back", exact: true }).tap();
    check(
      "and its name shows on the chooser in place of 'No file chosen yet'",
      !!(await until(() => chooser.getByText("people.csv", { exact: true }).isVisible())) &&
        (await p.getByText("No file chosen yet").count()) === 0,
    );
    // Keyboard: tabbing onto the hidden input draws a visible focus ring on the button.
    await p.reload({ waitUntil: "domcontentloaded" });
    await chooser.waitFor();
    await p.keyboard.press("Tab");
    await p.keyboard.press("Tab");
    await p.evaluate(() => document.querySelector("input[type=file]")?.focus());
    const ring = await chooser.evaluate(
      (l) =>
        getComputedStyle(l).outlineStyle !== "none" &&
        parseFloat(getComputedStyle(l).outlineWidth) > 0,
    );
    check("keyboard focus on the chooser is visible (an outline on the button)", ring);
    await m.browser.close();
  }

  // ======================= I-18 and I-11 on the client page =======================
  console.log("\n-- I-18 follow-up picker, I-11 reasons");
  if (on("I-18")) {
    const rivera = await client("Rivera Auto Repair");
    const before = await followUps(rivera.id);
    const m = await openBrowser(email, PHONE, TOUCH);
    const p = m.page;
    await p.goto(`${BASE}/clients/${rivera.id}`, { waitUntil: "domcontentloaded" });
    await p.getByLabel("New note").waitFor({ timeout: 15000 });
    await p.waitForFunction(
      () =>
        !!document.querySelector("#new-note") &&
        Object.keys(document.querySelector("#new-note")).some((k) => k.startsWith("__react")),
    );
    const presets = p.getByRole("group", { name: "Follow-up in" });
    check(
      "on opening, no preset looks pressed",
      (await presets.locator("[aria-pressed=true]").count()) === 0,
    );
    const setBtn = p.getByRole("button", { name: "Set follow-up", exact: true });
    check("and 'Set follow-up' is disabled", await setBtn.isDisabled());
    check("the date box is empty", (await p.getByLabel("Follow-up date").inputValue()) === "");
    await setBtn.click({ force: true, timeout: 1500 }).catch(() => undefined);
    check(
      "DB: a tap on the disabled button changed nothing",
      JSON.stringify(await followUps(rivera.id)) === JSON.stringify(before),
      JSON.stringify(await followUps(rivera.id)),
    );
    const fit = await pageFits(p);
    check(
      "the client page fits a 390px phone without being shrunk (innerWidth stays 390)",
      fit.ok,
      JSON.stringify(fit),
    );
    await shot(p, "client-followup-empty");
    await presets.getByRole("button", { name: "1w", exact: true }).tap();
    check(
      "picking 1w presses it and fills the date",
      (await presets.locator("[aria-pressed=true]").innerText()) === "1w" &&
        (await p.getByLabel("Follow-up date").inputValue()) === plusDays(7),
    );
    check("and enables 'Set follow-up'", await setBtn.isEnabled());
    await setBtn.tap();
    const saved = await until(async () => {
      const f = await followUps(rivera.id);
      return f.length === 1 && f[0] === plusDays(7);
    });
    check(
      "DB: the follow-up is now a week out",
      !!saved,
      JSON.stringify(await followUps(rivera.id)),
    );
    check(
      "after saving, the button rests (that date is now the current one)",
      !!(await until(async () => setBtn.isDisabled(), 4000)),
    );

    // A number that cannot be dialed.
    await rows("update clients set phone = 'call his cell' where id = $1", [rivera.id]);
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.getByLabel("New note").waitFor({ timeout: 15000 });
    const callBtn = p.getByRole("button", { name: /^Call Rivera/ });
    check("with a bad number Call is disabled", await callBtn.isDisabled());
    check(
      "its tooltip says why",
      /phone number/i.test((await callBtn.getAttribute("title")) ?? ""),
      String(await callBtn.getAttribute("title")),
    );
    const hint = p.getByText(/Not a usable phone number/).first();
    check(
      "and a visible line under the buttons says why (a phone has no tooltips)",
      await hint.isVisible(),
    );
    check(
      "the hint is not clipped by the pinned bar (it is on screen and within the viewport width)",
      await hint.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.width > 100;
      }),
    );
    await shot(p, "client-bad-phone");
    await p.getByRole("button", { name: "Edit details" }).tap();
    const dlg = p.getByRole("dialog");
    check(
      "the Phone field in Edit details flags it too",
      /Not a usable phone number yet/.test(await dlg.innerText()),
    );
    await dlg.getByLabel(/^Phone/).fill("(305) 555-0199");
    check(
      "and the warning goes away once the number is good",
      !/Not a usable phone number yet/.test(await dlg.innerText()),
    );
    await dlg.getByRole("button", { name: "Cancel" }).tap();

    await rows("update clients set phone = $2 where id = $1", [rivera.id, rivera.phone]);
    await m.browser.close();
  }

  // ======================= dark mode at 390px (screenshots only; the checks above ran in light) =======================
  if (on("dark")) {
    console.log("\n-- dark mode screenshots");
    const m = await openBrowser(email, PHONE, { ...TOUCH, colorScheme: "dark" });
    const p = m.page;
    const rivera = await client("Rivera Auto Repair");
    for (const [name, path, ready] of [
      ["clients-dark", "/clients", "ul[aria-label=Merchants] > li"],
      ["import-dark", "/import", "label"],
      ["client-dark", `/clients/${rivera.id}`, "#new-note"],
    ]) {
      await p.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await p.locator(ready).first().waitFor({ timeout: 15000 });
      await p.waitForTimeout(600);
      await shot(p, name);
    }
    await p.goto(`${BASE}/clients`, { waitUntil: "domcontentloaded" });
    await p.getByRole("button", { name: "Tools" }).tap();
    await shot(p, "clients-menu-dark");
    check("dark screenshots taken", true);
    await m.browser.close();
  }
}
