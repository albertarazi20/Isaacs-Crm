import { createHash, randomBytes } from "node:crypto";
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

const hash = (t) => createHash("sha256").update(t).digest("hex");

export default async function leadsFlow({ email }) {
  const token = `isl_${randomBytes(32).toString("base64url")}`;
  const userId = await withDb((db) =>
    db.query("select id from app_users where email = $1", [email]).then((r) => r.rows[0].id),
  );
  await withDb((db) =>
    db.query("insert into lead_tokens (user_id, label, token_hash) values ($1, 'e2e', $2)", [
      userId,
      hash(token),
    ]),
  );
  const post = (body, headers = {}) =>
    fetch(`${BASE}/api/leads`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const count = (where, params = []) =>
    withDb((db) =>
      db
        .query(`select count(*)::int n from client_cards c where c.user_id = $1 and ${where}`, [
          userId,
          ...params,
        ])
        .then((r) => r.rows[0].n),
    );

  let res = await post({
    businessName: "E2E Lead Diner",
    phone: "(305) 555-7771",
    contactName: "Pat",
    wantedAmount: "40k",
    source: "E2E vendor",
    notes: "Needs equipment",
  });
  let body = await res.json();
  check(
    "a good lead is created (201)",
    res.status === 201 && body.status === "created",
    JSON.stringify(body),
  );
  const row = await withDb((db) =>
    db
      .query(
        "select c.stage, c.source, c.next_due_on = current_date as due_today, c.wanted_amount_cents w from client_cards c where c.id = $1",
        [body.clientId],
      )
      .then((r) => r.rows[0]),
  );
  check(
    "DB: due today, in Name in, with its source and the amount wanted",
    row?.stage === "name_in" &&
      row.source === "E2E vendor" &&
      row.due_today === true &&
      Number(row.w) === 4_000_000,
    JSON.stringify(row),
  );

  res = await post({ businessName: "E2E Lead Diner Again", phone: "305-555-7771" });
  body = await res.json();
  check(
    "the same phone is a duplicate (200), not a second card",
    res.status === 200 && body.status === "duplicate",
  );
  check(
    "DB: still one card for that phone",
    (await count("regexp_replace(c.phone, '[^0-9]', '', 'g') like '%3055557771'")) === 1,
  );

  res = await post({ businessName: "No Contact Co" });
  check(
    "a lead with no phone or email is refused (400) with plain words",
    res.status === 400 && /phone number or an email/.test((await res.json()).error),
  );
  res = await post({ businessName: "SSN Co", phone: "3055557772", notes: "ssn 123-45-6789" });
  check("an SSN in the notes is refused (400)", res.status === 400);
  check(
    "DB: neither refused lead was stored",
    (await count("c.business_name in ('No Contact Co','SSN Co')")) === 0,
  );
  res = await post("{not json");
  check("bad JSON is refused (400)", res.status === 400);
  res = await post({ businessName: "x", phone: "1", notes: "y".repeat(25000) });
  check("an oversized body is refused (413)", res.status === 413);

  res = await fetch(`${BASE}/api/leads`, { method: "POST", body: "{}" });
  check("no token → 401", res.status === 401);
  res = await post(
    { businessName: "x", phone: "1" },
    { authorization: `Bearer isl_${randomBytes(32).toString("base64url")}` },
  );
  check("a token nobody made → 401", res.status === 401);
  res = await fetch(`${BASE}/api/leads`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  check("GET is not allowed (405)", res.status === 405);

  await withDb((db) =>
    db.query("update lead_tokens set revoked_at = now() where token_hash = $1", [hash(token)]),
  );
  res = await post({ businessName: "After Revoke", phone: "3055557773" });
  check("a revoked token stops working at once (401)", res.status === 401);
  check(
    "DB: nothing was added after revoking",
    (await count("c.business_name = 'After Revoke'")) === 0,
  );

  // The Lead intake page: make a connection, see the token once, use it, turn it off.
  await setRole(email, "manager"); // the web connections panel is a manager's
  const { browser, page } = await openBrowser(email);
  await page.goto(`${BASE}/lead-intake`, { waitUntil: "networkidle" });
  await page.getByText("Web lead connections").click(); // folded under a details block on the intake page
  await page.getByLabel("Where will the leads come from?").fill("E2E panel");
  await page.getByRole("button", { name: "Make a connection" }).click();
  const shown = await page.getByRole("alert").locator("code").first().innerText();
  check(
    "the new token is shown once, in the right shape",
    /^isl_[A-Za-z0-9_-]{43}$/.test(shown),
    shown.slice(0, 12),
  );
  const stored = await withDb((db) =>
    db
      .query("select token_hash from lead_tokens where label = 'E2E panel'")
      .then((r) => r.rows[0]?.token_hash),
  );
  check("DB: only the fingerprint is stored", stored === hash(shown) && !stored.includes(shown));
  const live = await fetch(`${BASE}/api/leads`, {
    method: "POST",
    headers: { authorization: `Bearer ${shown}`, "content-type": "application/json" },
    body: JSON.stringify({ businessName: "Panel Token Lead", phone: "3055557780" }),
  });
  check("the token from the page works", live.status === 201, String(live.status));
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Web lead connections").click();
  check(
    "after a reload the token is gone from the page",
    (await page.content()).includes(shown) === false,
  );
  check("the connection is listed", await page.getByText("E2E panel").first().isVisible());
  await page.getByRole("button", { name: "Turn off" }).first().click();
  await page.getByRole("button", { name: "Yes, turn it off" }).click();
  await page.getByText("Connection turned off").waitFor({ timeout: 8000 });
  const off = await fetch(`${BASE}/api/leads`, {
    method: "POST",
    headers: { authorization: `Bearer ${shown}`, "content-type": "application/json" },
    body: JSON.stringify({ businessName: "Panel Token Lead 2", phone: "3055557781" }),
  });
  check("after turning it off the token is refused", off.status === 401, String(off.status));
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  check("no sideways page scroll at 390px", !overflow);
  await browser.close();
}
