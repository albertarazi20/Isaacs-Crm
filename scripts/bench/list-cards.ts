// Times the card-list query through the app's own DB layer:  npx tsx scripts/bench/list-cards.ts
import pg from "../../src/lib/db/pg";
import { makeDb } from "../../src/lib/db";
import { listCards, userContext, dueCount } from "../../src/lib/data/queries";

const pool = new pg.Pool({
  connectionString: "postgres://postgres@localhost:5433/isaac_dev",
  max: 4,
});
const db = makeDb(pool);
const { rows } = await pool.query("select id from app_users where email = 'perf5k@example.com'");
const uid = rows[0].id as string;
const time = async (label: string, fn: () => Promise<unknown>) => {
  const ts: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await fn();
    ts.push(Math.round(performance.now() - t0));
  }
  console.log(label.padEnd(28), ts.join(" / "), "ms");
};
await time("listCards", () => db.withUser(uid, (q) => listCards(q)));
await time("userContext", () => db.withUser(uid, (q) => userContext(q)));
await time("dueCount", () =>
  db.withUser(uid, async (q) => dueCount(q, (await userContext(q)).today)),
);
await time("setup only", () => db.withUser(uid, async () => undefined));
await pool.end();
