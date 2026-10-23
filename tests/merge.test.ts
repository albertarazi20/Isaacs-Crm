import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertClient, insertUser, timersJson, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let b: string;
const d = (n: number) => addDays(t.today, n);

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "UTC");
  b = await insertUser(t.pool, "other@x.com", "UTC");
});
afterAll(async () => {
  await t.drop();
});

type Q = Parameters<Parameters<typeof t.db.withUser>[1]>[0];
const asA = <T>(fn: (q: Q) => Promise<T>) => t.db.withUser(a, fn);
const merge = (keep: string, drop: string) =>
  asA((q) => q.query("select * from merge_clients($1, $2)", [keep, drop]));
const count = async (sql: string, params: unknown[]) =>
  Number((await t.pool.query<{ n: string }>(sql, params)).rows[0]?.n);
const row = async (id: string) =>
  (await t.pool.query("select * from clients where id = $1", [id])).rows[0];

let seq = 0;
async function merchant(name: string, fields: Record<string, string> = {}) {
  seq += 1;
  const id = await insertClient(t.db, a, `${name} ${seq}`);
  for (const [col, val] of Object.entries(fields)) {
    await t.pool.query(`update clients set ${col} = $2 where id = $1`, [id, val]);
  }
  return id;
}
async function funder(name: string) {
  const { rows } = await t.pool.query<{ id: string }>(
    "insert into funders (user_id, name) values ($1, $2) returning id",
    [a, `${name} ${(seq += 1)}`],
  );
  return rows[0]?.id as string;
}

describe("merging two cards for one merchant", () => {
  it("moves everything over, fills blanks, and the second card is gone", async () => {
    const keep = await merchant("Mike's Pizza", { phone: "3055550100" });
    const drop = await merchant("Mikes Pizza LLC", {
      email: "mike@pizza.com",
      contact_name: "Mike Ross",
      industry: "Restaurant",
      phone: "3055559999",
    });
    // things on the second card
    await t.pool.query(
      "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'note', 'He wants 40k by Friday')",
      [a, drop],
    );
    await t.pool.query(
      "insert into client_asks (user_id, client_id, wanted_amount_cents) values ($1, $2, 4000000)",
      [a, drop],
    );
    await t.pool.query(
      "insert into positions (user_id, client_id, position_no, funder_name) values ($1, $2, 1, 'Old Funder')",
      [a, drop],
    );
    await t.pool.query(
      "insert into competing_offers (user_id, client_id, funder_name, amount_cents, factor_rate) values ($1, $2, 'Rival', 3000000, 1.4)",
      [a, drop],
    );
    await t.pool.query(
      "insert into stips (user_id, client_id, kind, period, required, received_at) values ($1, $2, 'bank_statement', '2026-09-01', true, now())",
      [a, drop],
    );
    await asA((q) =>
      q.query("select * from record_funding($1, $2::jsonb, $3::jsonb)", [
        drop,
        JSON.stringify({
          funded_on: d(-30),
          funder_name: "Alpha",
          amount_cents: 5_000_000,
          factor_rate: 1.3,
          payment_cents: 50_000,
          frequency: "daily",
          position_no: 1,
        }),
        timersJson({ kind: "check_in", due_on: d(5) }),
      ]),
    );
    const before = {
      notes: await count(
        "select count(*) n from activities where client_id = $1 and kind = 'note'",
        [drop],
      ),
    };

    const merged = (await merge(keep, drop)).rows[0];
    expect(merged.id).toBe(keep);

    // the second card is really gone, and every child now hangs off the first
    expect(await row(drop)).toBeUndefined();
    for (const table of ["client_asks", "positions", "competing_offers", "fundings", "stips"]) {
      expect(
        await count(`select count(*) n from ${table} where client_id = $1`, [keep]),
        table,
      ).toBe(1);
      expect(
        await count(`select count(*) n from ${table} where client_id = $1`, [drop]),
        table,
      ).toBe(0);
    }
    expect(
      await count(
        "select count(*) n from activities where client_id = $1 and body = 'He wants 40k by Friday'",
        [keep],
      ),
    ).toBe(before.notes);
    // blanks filled, filled fields kept
    expect(await row(keep)).toMatchObject({
      phone: "3055550100",
      email: "mike@pizza.com",
      contact_name: "Mike", // the kept card already had one: it stays
      industry: "Restaurant",
    });
    // the merge is written down
    const { rows } = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'system' and body like 'Merged with%'",
      [keep],
    );
    expect(rows[0]?.body).toMatch(
      /^Merged with Mikes Pizza LLC \d+ \(3055559999\): \d+ notes, 1 advances/,
    );
    // and the advance counts as the merchant's: his funding shows on the card
    const card = await t.pool.query("select funding_id from client_cards where id = $1", [keep]);
    expect(card.rows[0]?.funding_id).not.toBeNull();
  });

  it("a stop wins: do-not-contact on either card makes the merged card do-not-contact", async () => {
    const keep = await merchant("Careful Keep");
    const drop = await merchant("Careful Drop");
    await asA((q) =>
      q.query("select * from set_contact_status($1, 'dnc', 'asked us to stop')", [drop]),
    );
    await merge(keep, drop);
    expect((await row(keep)).contact_status).toBe("dnc");
    // and the review timer that goes with it exists
    expect(
      await count("select count(*) n from timers where client_id = $1 and done_at is null", [keep]),
    ).toBeGreaterThan(0);
  });

  it("two different limits become do-not-contact; a limit on the kept card alone stays", async () => {
    const keep = await merchant("Limit Keep");
    const drop = await merchant("Limit Drop");
    await asA((q) => q.query("select * from set_contact_status($1, 'no_text', '')", [keep]));
    await asA((q) => q.query("select * from set_contact_status($1, 'no_call', '')", [drop]));
    await merge(keep, drop);
    expect((await row(keep)).contact_status).toBe("dnc");
    const k2 = await merchant("Limit Keep 2");
    const d2 = await merchant("Limit Drop 2");
    await asA((q) => q.query("select * from set_contact_status($1, 'no_text', '')", [k2]));
    await merge(k2, d2);
    expect((await row(k2)).contact_status).toBe("no_text");
  });

  it("never loses a date: an earlier follow-up on the second card becomes the kept card's", async () => {
    const keep = await merchant("Date Keep");
    const drop = await merchant("Date Drop");
    await asA((q) => q.query("select * from set_follow_up($1, $2)", [keep, d(30)]));
    await asA((q) => q.query("select * from set_follow_up($1, $2)", [drop, d(2)]));
    await merge(keep, drop);
    const { rows } = await t.pool.query<{ due_on: string }>(
      "select due_on::text from timers where client_id = $1 and done_at is null and kind = 'follow_up'",
      [keep],
    );
    expect(rows).toEqual([{ due_on: d(2) }]);
  });

  it("a later follow-up on the second card changes nothing on the kept card", async () => {
    const keep = await merchant("Later Keep");
    const drop = await merchant("Later Drop");
    await asA((q) => q.query("select * from set_follow_up($1, $2)", [keep, d(3)]));
    await asA((q) => q.query("select * from set_follow_up($1, $2)", [drop, d(40)]));
    await merge(keep, drop);
    const { rows } = await t.pool.query<{ due_on: string }>(
      "select due_on::text from timers where client_id = $1 and done_at is null",
      [keep],
    );
    expect(rows).toEqual([{ due_on: d(3) }]);
  });

  it("stips: a received one beats a missing one, and none is duplicated", async () => {
    const keep = await merchant("Stip Keep");
    const drop = await merchant("Stip Drop");
    const ins = (client: string, period: string, received: boolean) =>
      t.pool.query(
        `insert into stips (user_id, client_id, kind, period, required, received_at)
         values ($1, $2, 'bank_statement', $3, true, ${received ? "now()" : "null"})`,
        [a, client, period],
      );
    await ins(keep, "2026-08-01", false); // same month on both: the drop's is received
    await ins(drop, "2026-08-01", true);
    await ins(drop, "2026-09-01", false); // only on the second card: moves over
    await merge(keep, drop);
    const { rows } = await t.pool.query<{ period: string; got: boolean }>(
      "select period::text, received_at is not null as got from stips where client_id = $1 order by period",
      [keep],
    );
    expect(rows).toEqual([
      { period: "2026-08-01", got: true },
      { period: "2026-09-01", got: false },
    ]);
  });

  it("submissions and their offers follow; a duplicate submission to the same funder that day is not doubled", async () => {
    const keep = await merchant("Sub Keep");
    const drop = await merchant("Sub Drop");
    const f1 = await funder("F1");
    const f2 = await funder("F2");
    const sendTo = (client: string, funders: string[]) =>
      asA((q) =>
        q.query<{ id: string }>("select * from create_submissions($1, $2::uuid[], $3::date, '')", [
          client,
          funders,
          d(-1),
        ]),
      );
    await sendTo(keep, [f1]);
    const dropSubs = (await sendTo(drop, [f1, f2])).rows; // f1 duplicates the kept card's; f2 is new
    const offer = await asA((q) =>
      q.query<{ id: string }>("select * from record_offer($1, $2::jsonb)", [
        dropSubs[1]?.id,
        JSON.stringify({ amount_cents: 2_000_000, factor_rate: 1.35 }),
      ]),
    );
    await merge(keep, drop);
    const { rows } = await t.pool.query<{ funder_id: string }>(
      "select funder_id from submissions where client_id = $1 order by funder_id",
      [keep],
    );
    expect(rows.map((r) => r.funder_id).sort()).toEqual([f1, f2].sort());
    expect(
      await count("select count(*) n from offers where id = $1 and client_id = $2", [
        offer.rows[0]?.id,
        keep,
      ]),
    ).toBe(1);
    // the chase for the moved submission is on the kept card now
    expect(
      await count(
        "select count(*) n from timers where client_id = $1 and kind = 'chase' and done_at is null",
        [keep],
      ),
    ).toBeGreaterThanOrEqual(1);
  });

  it("a booked call on the second card survives when the kept card has none", async () => {
    const keep = await merchant("Call Keep");
    const drop = await merchant("Call Drop");
    await asA((q) =>
      q.query("select * from schedule_call($1, $2::timestamptz, 'review offers')", [
        drop,
        `${d(2)}T15:00:00Z`,
      ]),
    );
    await merge(keep, drop);
    expect((await row(keep)).scheduled_call_at).not.toBeNull();
    expect(
      await count(
        "select count(*) n from timers where client_id = $1 and kind = 'scheduled_call' and done_at is null",
        [keep],
      ),
    ).toBe(1);
  });

  it("refuses the same card twice, a trashed card, and someone else's card", async () => {
    const keep = await merchant("Refuse Keep");
    const drop = await merchant("Refuse Drop");
    await expect(merge(keep, keep)).rejects.toThrow(/two different merchants/);
    await asA((q) => q.query("select trash_client($1)", [drop]));
    await expect(merge(keep, drop)).rejects.toThrow(/in the trash/);
    const theirs = await insertClient(t.db, b, "Not Yours");
    await expect(merge(keep, theirs)).rejects.toThrow(/not found/);
    expect(await row(theirs)).toBeDefined();
    expect(await row(keep)).toBeDefined();
  });

  it("two merges at once on the same pair never deadlock: one wins, the other is told it's gone", async () => {
    let deadlocks = 0;
    for (let i = 0; i < 15; i += 1) {
      const x = await merchant("Race X");
      const y = await merchant("Race Y");
      const results = await Promise.allSettled([merge(x, y), merge(y, x)]);
      for (const r of results)
        if (r.status === "rejected" && (r.reason as { code?: string }).code === "40P01")
          deadlocks += 1;
      // exactly one card is left
      const left = await count("select count(*) n from clients where id = any($1::uuid[])", [
        [x, y],
      ]);
      expect(left).toBe(1);
    }
    expect(deadlocks).toBe(0);
  });
});
