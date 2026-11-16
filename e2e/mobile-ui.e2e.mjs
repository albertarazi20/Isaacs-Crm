// Phone fixes from docs/ISSUES.md: I-9 (Board remembers its view), I-11 (disabled Call/Text says why), I-14 (Clients on a
// phone), I-18 (follow-up picker starts empty), I-19 (styled file chooser), I-20 (stage-group tabs on the phone Board).
// The 40px tap-target rule (I-12) and the note box position (I-13) are checked by board.e2e / client.e2e.
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

  // ======================= I-14: Clients on a phone =======================
  console.log("\n-- I-14 Clients page on a phone");
  if (on("I-14")) {
    const m = await openBrowser(email, PHONE, TOUCH);
    const p = m.page;
    await p.goto(`${BASE}/clients`, { waitUntil: "domcontentloaded" });
    await p.getByRole("heading", { name: "Clients", exact: true }).waitFor();
    check(
      "the six toolbar buttons are not on the page",
      (await p.getByRole("link", { name: "Download clients (CSV)" }).count()) === 0,
    );
    const more = p.getByRole("button", { name: "More actions" });
    const box = await more.boundingBox();
    check(
      "a '…' button replaces them, at least 40px square",
      !!box && box.width >= 40 && box.height >= 40,
      JSON.stringify(box),
    );
    await more.tap();
    // the menu's own panel: a merchant card in the Trash stage is also a link with "Trash" in its name
    const panel = p.locator(`[id="${await more.getAttribute("aria-controls")}"]`);
    const items = await panel.getByRole("link").allInnerTexts();
    check(
      "the menu has all six: both downloads, Import, Lead intake, Reports, Trash",
      items.length === 6,
      JSON.stringify(items),
    );
    await shot(p, "clients-menu-open");
    await p.keyboard.press("Escape");
    check(
      "Escape closes the menu",
      (await panel.getByRole("link", { name: "Trash" }).count()) === 0,
    );
    await more.tap();
    await panel.getByRole("link", { name: "Trash" }).tap();
    await p.waitForURL(/\/trash/);
    check("a menu item goes to its page", /\/trash/.test(p.url()));
    await p.goBack();
    await p.getByRole("heading", { name: "Clients", exact: true }).waitFor();

    const first = p.locator("ul[aria-label=Clients] > li").first();
    await first.waitFor();
    const geo = await p.evaluate(() => {
      const li = document.querySelector("ul[aria-label=Clients] > li");
      const r = li?.getBoundingClientRect();
      const links = [...document.querySelectorAll("ul[aria-label=Clients] > li")].length;
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
    check("there is one card per merchant (51)", geo.links === 51, `${geo.links}`);
    const cardText = await first.innerText();
    check(
      "a card shows the date he is due (a chip like 'Today' / 'in 3 days' plus the date)",
      /Today|Tomorrow|overdue|in \d+ (days|weeks|months)|No follow-up/.test(cardText) &&
        /[A-Z][a-z]{2} \d{1,2}/.test(cardText),
      cardText.replace(/\s+/g, " ").slice(0, 120),
    );
    const visibleDue = await first.evaluate((li) => {
      const chip = li.querySelector("span.rounded-md");
      const r = chip?.getBoundingClientRect();
      return !!r && r.left >= 0 && r.right <= innerWidth;
    });
    check("and the due chip is fully on screen (no swipe needed)", visibleDue);
    check(
      "and the stage",
      /Interested|Name in|Funded|Submitted|Collecting|Application|Offer|Lost|Dead|Trash|Declined|Killed|Default|Paid|Phone|Contract|Not interested|Paying/.test(
        cardText,
      ),
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
    await p.getByRole("searchbox", { name: "Search clients" }).fill("zzz-nobody");
    check(
      "search with no match shows 'No matches' and no cards",
      (await p.getByText("No matches").isVisible()) &&
        (await p.locator("ul[aria-label=Clients] > li").count()) === 0,
    );
    await m.browser.close();

    const d = await openBrowser(email, { width: 1440, height: 900 });
    await d.page.goto(`${BASE}/clients`, { waitUntil: "domcontentloaded" });
    await d.page.getByRole("heading", { name: "Clients", exact: true }).waitFor();
    check(
      "desktop keeps the six buttons in a row and no '…' menu",
      (await d.page.getByRole("link", { name: "Download clients (CSV)" }).isVisible()) &&
        !(await d.page.getByRole("button", { name: "More actions" }).isVisible()),
    );
    check("desktop keeps the table", (await d.page.locator("table tbody tr").count()) === 51);
    await shot(d.page, "clients-desktop");
    await d.browser.close();
  }

  // ======================= I-19: styled file chooser =======================
  console.log("\n-- I-19 Import page file chooser");
  if (on("I-19")) {
    const m = await openBrowser(email, PHONE, TOUCH);
    const p = m.page;
    await p.goto(`${BASE}/import`, { waitUntil: "domcontentloaded" });
    const chooser = p.locator("label", { hasText: "Choose a spreadsheet" });
    await chooser.waitFor();
    const b = await chooser.boundingBox();
    check(
      "a 'Choose a spreadsheet' button is there, at least 40px tall",
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
    check(
      "after choosing a file its name shows",
      await p.getByText("people.csv", { exact: true }).isVisible(),
    );
    check(
      "and the wizard reads it (step 2 appears)",
      await p.getByText("2. Check the columns").isVisible(),
    );
    await shot(p, "import-after");
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
      ["clients-dark", "/clients", "ul[aria-label=Clients] > li"],
      ["import-dark", "/import", "label"],
      ["client-dark", `/clients/${rivera.id}`, "#new-note"],
    ]) {
      await p.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await p.locator(ready).first().waitFor({ timeout: 15000 });
      await p.waitForTimeout(600);
      await shot(p, name);
    }
    await p.goto(`${BASE}/clients`, { waitUntil: "domcontentloaded" });
    await p.getByRole("button", { name: "More actions" }).tap();
    await shot(p, "clients-menu-dark");
    check("dark screenshots taken", true);
    await m.browser.close();
  }
}
