// Times every page and export for the 5,000-merchant benchmark user, against a PRODUCTION build.
//   psql "$DATABASE_URL" -f scripts/bench/seed-5k.sql      (creates perf5k@example.com with 5,000 merchants)
//   pnpm build && ALLOWED_EMAILS=isaac@example.com,perf5k@example.com PORT=3100 pnpm start -p 3100
//   SECRET=<SESSION_SECRET> node scripts/bench/pages.mjs     (BASE=http://localhost:3100)
// Build in a COPY of the repo if a dev server is running: `next build` overwrites its .next folder.
import { SignJWT } from "jose";
import pg from "pg";
const secret = new TextEncoder().encode(process.env.SECRET);
const db = new pg.Client({ connectionString: "postgres://postgres@localhost:5433/isaac_dev" });
await db.connect();
const u = (
  await db.query(
    "select id, email, session_epoch from app_users where email = 'perf5k@example.com'",
  )
).rows[0];
await db.end();
const now = Math.floor(Date.now() / 1000);
const token = await new SignJWT({ email: u.email, ep: u.session_epoch })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(u.id)
  .setIssuedAt(now)
  .setExpirationTime(now + 3600)
  .sign(secret);
const BASE = process.env.BASE ?? "http://localhost:3100";
const paths = [
  "/",
  "/board",
  "/clients",
  "/dial",
  "/earnings",
  "/funders",
  "/renewals",
  "/reports",
  "/reports?days=all",
  "/winback",
  "/long-game",
  "/settings",
  "/trash",
  "/api/export/clients",
  "/api/export/activity",
];
for (const p of paths) {
  const times = [];
  let size = 0,
    status = 0;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const r = await fetch(BASE + p, {
      headers: { cookie: `isaac_session=${token}` },
      redirect: "manual",
    });
    const body = await r.arrayBuffer();
    times.push(Math.round(performance.now() - t0));
    size = body.byteLength;
    status = r.status;
  }
  console.log(
    `${p.padEnd(24)} ${status}  ${times.join(" / ").padEnd(16)} ms   ${(size / 1e6).toFixed(2)} MB`,
  );
}
