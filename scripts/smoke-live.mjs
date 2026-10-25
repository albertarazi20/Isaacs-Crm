// Public-surface smoke test for a deployed Isaac. Needs no login and changes nothing.
//
//   node scripts/smoke-live.mjs https://your-app.vercel.app
//   CRON_SECRET=... node scripts/smoke-live.mjs https://your-app.vercel.app --run-cron
//
// --run-cron calls the reminder job once with the real secret. That is the normal hourly job: it sends the real
// emails that are due and writes the heartbeat. The secret is read from the environment, never from the command line.
// Exit code 1 when any check fails. "warn" lines do not fail the run.

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const runCron = process.argv.includes("--run-cron");
if (!/^https?:\/\//.test(base)) {
  console.error("usage: node scripts/smoke-live.mjs <https://app-url> [--run-cron]");
  process.exit(2);
}
const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base);

let failed = 0;
const say = (tag, name, extra = "") =>
  console.log(`${tag.padEnd(5)} ${name}${extra ? ` — ${extra}` : ""}`);
const ok = (name, extra) => say("ok", name, extra);
const warn = (name, extra) => say("warn", name, extra);
const fail = (name, extra) => {
  failed += 1;
  say("FAIL", name, extra);
};
const check = (cond, name, extra) => (cond ? ok(name) : fail(name, extra));

const get = (path, init = {}) =>
  fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(20_000), ...init });

try {
  check(base.startsWith("https://") || local, "served over https", "http on a public host");

  const root = await get("/");
  const where = root.headers.get("location") ?? "";
  check(
    [301, 302, 303, 307, 308].includes(root.status) && where.includes("/login"),
    "signed-out visitor is sent to /login",
    `status ${root.status} location ${where || "(none)"}`,
  );

  const login = await get("/login");
  const html = await login.text();
  check(login.status === 200, "/login loads", `status ${login.status}`);
  check(/google/i.test(html), "/login offers Google sign-in");

  const wanted = ["content-security-policy", "x-content-type-options", "referrer-policy"];
  if (!local) wanted.push("strict-transport-security");
  for (const h of wanted) {
    if (login.headers.get(h)) ok(`header ${h}`);
    else warn(`header ${h} missing`);
  }

  const manifest = await get("/manifest.webmanifest");
  check(
    manifest.status === 200,
    "app manifest (install to phone) loads",
    `status ${manifest.status}`,
  );

  // Google configured: the start route must redirect to Google with the exact callback URL, and set the state cookie.
  const start = await get("/api/auth/google");
  const to = start.headers.get("location") ?? "";
  if (to.startsWith("https://accounts.google.com/")) {
    const q = new URL(to).searchParams;
    check(
      q.get("redirect_uri") === `${base}/api/auth/callback`,
      "Google redirect URI is exactly APP_URL/api/auth/callback",
      `got ${q.get("redirect_uri")}`,
    );
    check(
      Boolean(q.get("client_id")) && Boolean(q.get("state")),
      "Google start has a client id and a state",
    );
    const cookie = start.headers.get("set-cookie") ?? "";
    check(/httponly/i.test(cookie), "OAuth state cookie is HttpOnly");
    if (!local) check(/secure/i.test(cookie), "OAuth state cookie is Secure");
  } else if (to.includes("google_not_configured")) {
    fail(
      "Google sign-in is configured",
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on the host",
    );
  } else {
    fail("Google start redirects to Google", `status ${start.status} location ${to || "(none)"}`);
  }

  for (const [path, init] of [
    ["/api/export/backup", {}],
    ["/api/export/clients", {}],
    ["/api/leads", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }],
    ["/api/cron/reminders", {}],
  ]) {
    const r = await get(path, init);
    check(
      r.status === 401 || (r.status >= 300 && r.status < 400),
      `${path} refuses a stranger`,
      `status ${r.status}`,
    );
  }
  const wrong = await get("/api/cron/reminders", {
    headers: { authorization: "Bearer not-the-secret" },
  });
  check(
    wrong.status === 401,
    "/api/cron/reminders refuses a wrong secret",
    `status ${wrong.status}`,
  );

  if (!local) {
    const dev = await get("/api/dev-login");
    check(dev.status >= 400, "dev login is off", `status ${dev.status}`);
  }

  if (runCron) {
    const secret = process.env.CRON_SECRET;
    if (!secret) fail("--run-cron needs CRON_SECRET in the environment");
    else {
      const r = await get("/api/cron/reminders", {
        headers: { authorization: `Bearer ${secret}` },
      });
      const text = (await r.text()).slice(0, 300);
      check(r.status === 200, "reminder job ran and sent cleanly", `status ${r.status} ${text}`);
    }
  }
} catch (e) {
  fail("could not reach the site", e instanceof Error ? e.message : String(e));
}

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
