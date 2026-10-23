import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userContext } from "@/lib/data/queries";
import { loadWinback } from "@/lib/messaging/queries";
import { splitBatch } from "@/lib/messaging/winback";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let b: string;
const id: Record<string, string> = {};

const inDays = async (n: number) =>
  (await t.pool.query<{ d: string }>("select (current_date + $1::int)::text as d", [n])).rows[0]!.d;

/** A client in a given stage with its one open timer due `due` days from the database's today. */
async function make(
  owner: string,
  name: string,
  stage: string,
  due: number,
  extra: Record<string, unknown> = {},
) {
  // create_client refuses a date in the past, so start it today and then move the timer where the test wants it.
  const cid = await insertClient(t.db, owner, name, await inDays(Math.max(due, 0)));
  await t.pool.query(
    "update timers set due_on = current_date + $2::int where client_id = $1 and done_at is null",
    [cid, due],
  );
  await t.pool.query("update clients set stage = $2, stage_changed_at = now() where id = $1", [
    cid,
    stage,
  ]);
  if (extra.wanted) {
    await t.pool.query(
      "insert into client_asks (user_id, client_id, wanted_amount_cents) values ($1, $2, $3)",
      [owner, cid, extra.wanted],
    );
  }
  id[name] = cid;
  return cid;
}

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "a@x.com", "UTC");
  b = await insertUser(t.pool, "b@x.com", "UTC");

  await make(a, "Dead Small", "dead", 10, { wanted: 2_000_000 });
  await make(a, "Dead Big", "dead", -400, { wanted: 9_000_000 }); // a lead from long ago is a call today
  await make(a, "Declined Soon", "declined", 29, { wanted: 5_000_000 });
  await make(a, "Declined Later", "declined", 45);
  await make(a, "Killed", "killed", 0);
  await make(a, "Not Interested", "not_interested", 30);
  await make(a, "Written Off", "written_off", 5);
  await make(a, "Lost Rival", "lost", -3, { wanted: 1_000_000 });
  await make(a, "Interested", "interested", 3, { wanted: 99_000_000 }); // wrong stage, however big
  await make(a, "Funded Guy", "funded", 3);
  await make(a, "No Text", "dead", 5, { wanted: 50_000_000 });
  await make(a, "Dnc", "dead", 5, { wanted: 60_000_000 });
  await make(b, "Other User Dead", "dead", 1, { wanted: 70_000_000 });

  await t.db.withUser(a, async (q) => {
    await q.query("select * from set_contact_status($1, 'no_text', 'asked not to be texted')", [
      id["No Text"],
    ]);
    await q.query("select * from set_contact_status($1, 'dnc', 'stop')", [id["Dnc"]]);
    await q.query(
      `insert into competing_offers (user_id, client_id, funder_name, amount_cents, factor_rate, term_days, offered_on, won) values
         ($1, $2, 'Quote Only', 8000000, 1.30, 90, current_date - 100, false),
         ($1, $2, 'Rival Capital', 4000000, 1.42, 180, current_date - 90, true)`,
      [a, id["Lost Rival"]],
    );
  });
  // a lost deal belonging to the other user, with an offer of its own
  await make(b, "B Lost", "lost", 2);
  await t.db.withUser(b, (q) =>
    q.query(
      "insert into competing_offers (user_id, client_id, funder_name, amount_cents) values ($1, $2, 'B Rival', 1000000)",
      [b, id["B Lost"]],
    ),
  );
});
afterAll(async () => {
  await t.drop();
});

const load = (user: string, days: number) =>
  t.db.withUser(user, async (q) => loadWinback(q, await userContext(q), days));
const names = (rows: Awaited<ReturnType<typeof load>>) => rows.map((r) => r.card.business_name);

describe("loadWinback against a real database", () => {
  it("lists win-back stages due within 30 days — overdue included — biggest money first", async () => {
    const rows = await load(a, 30);
    expect(names(rows)).toEqual([
      "Dead Big", // $90k ask, 400 days overdue
      "Declined Soon", // $50k ask, due in 29 days
      "Lost Rival", // $40k: the offer the merchant took (the $80k quote he didn't take isn't his money)
      "Dead Small", // $20k
      // no money on file: the most recently moved first
      "Written Off",
      "Not Interested",
      "Killed",
    ]);
  });

  it("is the exact set: right stages, right window, nobody who asked to be left alone", async () => {
    const got = new Set(names(await load(a, 30)));
    expect(got).toEqual(
      new Set([
        "Dead Big",
        "Declined Soon",
        "Lost Rival",
        "Dead Small",
        "Not Interested",
        "Killed",
        "Written Off",
      ]),
    );
    expect(got.has("Declined Later")).toBe(false); // 45 days out
    expect(got.has("Interested")).toBe(false); // not an exit stage
    expect(got.has("Funded Guy")).toBe(false);
  });

  it("excludes a do-not-text merchant and a do-not-contact merchant entirely", async () => {
    const got = names(await load(a, 365));
    expect(got).not.toContain("No Text");
    expect(got).not.toContain("Dnc");
    // sanity: they really are in the database with the status set, in a win-back stage
    const { rows } = await t.pool.query<{
      business_name: string;
      stage: string;
      contact_status: string;
    }>(
      "select business_name, stage, contact_status from clients where user_id = $1 and business_name in ('No Text', 'Dnc') order by 1",
      [a],
    );
    expect(rows).toEqual([
      { business_name: "Dnc", stage: "dead", contact_status: "dnc" },
      { business_name: "No Text", stage: "dead", contact_status: "no_text" },
    ]);
  });

  it("widens with the window", async () => {
    expect(names(await load(a, 30))).not.toContain("Declined Later");
    expect(names(await load(a, 60))).toContain("Declined Later");
    expect(names(await load(a, 7))).toEqual(
      expect.arrayContaining(["Dead Big", "Killed", "Written Off", "Lost Rival"]),
    );
    expect(names(await load(a, 7))).not.toContain("Dead Small"); // 10 days
  });

  it("attaches the lost deal's offer: the one he took, not the biggest quote", async () => {
    const lost = (await load(a, 30)).find((r) => r.card.business_name === "Lost Rival");
    expect(lost?.offer).toMatchObject({
      funder_name: "Rival Capital",
      amount_cents: 4_000_000,
      factor_rate: 1.42,
      term_days: 180,
      won: true,
    });
    expect(lost?.moneyCents).toBe(4_000_000);
  });

  it("only ever shows this user's merchants and offers", async () => {
    expect(names(await load(b, 365)).sort()).toEqual(["B Lost", "Other User Dead"]);
    const bLost = (await load(b, 365)).find((r) => r.card.business_name === "B Lost");
    expect(bLost?.offer?.funder_name).toBe("B Rival");
    expect(names(await load(a, 365))).not.toContain("Other User Dead");
    expect(names(await load(a, 365))).not.toContain("B Lost");
  });

  it("moves a merchant out of the batch once a call or text is logged today", async () => {
    const before = splitBatch(await load(a, 30));
    expect(before.batch.map((r) => r.card.business_name)).toContain("Dead Small");
    expect(before.done).toEqual([]);
    await t.db.withUser(a, (q) =>
      q.query(
        "select * from log_touch($1, 'text', 'left_message', 'sent the win-back', current_date + 7)",
        [id["Dead Small"]],
      ),
    );
    const after = splitBatch(await load(a, 30));
    expect(after.done.map((r) => r.card.business_name)).toEqual(["Dead Small"]);
    expect(after.batch.map((r) => r.card.business_name)).not.toContain("Dead Small");
    // the touch really is in the database
    const real = await t.pool.query(
      "select kind, outcome from activities where client_id = $1 and kind = 'text'",
      [id["Dead Small"]],
    );
    expect(real.rows).toEqual([{ kind: "text", outcome: "left_message" }]);
  });

  it("is quick with a lot of merchants (one query for cards, one for offers)", async () => {
    const u = await insertUser(t.pool, "many@x.com", "UTC");
    await t.pool.query(
      `insert into clients (user_id, business_name, stage)
       select $1, 'Bulk ' || i, 'dead' from generate_series(1, 600) i`,
      [u],
    );
    await t.pool.query(
      `insert into timers (user_id, client_id, kind, due_on)
       select user_id, id, 'follow_up', current_date + (random() * 20)::int from clients where user_id = $1`,
      [u],
    );
    const started = Date.now();
    const rows = await load(u, 30);
    expect(rows).toHaveLength(600);
    expect(Date.now() - started).toBeLessThan(5000);
    const { batch, later } = splitBatch(rows);
    expect(batch).toHaveLength(10);
    expect(later).toHaveLength(590);
  });
});
