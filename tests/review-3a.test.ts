import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/mca/dates";
import { findDuplicates } from "@/lib/data/queries";
import { NAME_KEY_SQL, nameKey } from "@/lib/data/nameKey";
import { createTestDb, insertClient, insertUser, timersJson, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
const d = (n: number) => addDays(t.today, n);

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "UTC");
});
afterAll(async () => {
  await t.drop();
});

type Q = Parameters<Parameters<typeof t.db.withUser>[1]>[0];
const asA = <T>(fn: (q: Q) => Promise<T>) => t.db.withUser(a, fn);
let seq = 0;

async function merchant(name: string, stage = "application_in"): Promise<string> {
  seq += 1;
  const id = await insertClient(t.db, a, `${name} ${seq}`);
  await asA((q) =>
    q.query("select * from move_client($1, $2, $3::jsonb)", [
      id,
      stage,
      timersJson({ kind: "follow_up", due_on: d(2) }),
    ]),
  );
  return id;
}

describe("A-15: the duplicate check reads names the same way in TypeScript and in the database", () => {
  const NAMES = [
    "Mike's Pizza, LLC",
    "MIKES PIZZA LLC",
    "Café Núñez",
    "CAFÉ NÚÑEZ",
    "Peña's Taquería",
    "7-Eleven #4412",
    "A&B Auto (Miami)",
    "王记餐厅",
    "  spaced   out  ",
    "O'Brien & Sons",
  ];
  it("nameKey equals the SQL expression for every name", async () => {
    for (const n of NAMES) {
      const { rows } = await t.pool.query<{ k: string }>(
        `select ${NAME_KEY_SQL("$1::text")} as k`,
        [n],
      );
      expect(rows[0]?.k, n).toBe(nameKey(n));
    }
  });
  it("accented spellings of one business find each other; a name with no letters has no key", async () => {
    await insertClient(t.db, a, "Café Núñez");
    const hit = await asA((q) => findDuplicates(q, { businessName: "CAFÉ  NÚÑEZ!" }));
    expect(hit.map((m) => m.business_name)).toEqual(["Café Núñez"]);
    expect(nameKey("王记餐厅")).toBe("");
    expect(await asA((q) => findDuplicates(q, { businessName: "王记餐厅" }))).toEqual([]);
  });
});

describe("QA I-7: cancelling a booked call puts the merchant back where he was", () => {
  const book = (id: string, at: string) =>
    asA((q) => q.query("select * from schedule_call($1, $2::timestamptz, '')", [id, at]));
  const cancel = (id: string) => asA((q) => q.query("select * from cancel_call($1)", [id]));
  const stageOf = async (id: string) =>
    (
      await t.pool.query<{ stage: string; scheduled_call_at: string | null }>(
        "select stage, scheduled_call_at from clients where id = $1",
        [id],
      )
    ).rows[0];
  const at = () => `${d(2)}T15:00:00Z`;

  it("Interested → reminder set → cancelled stays Interested, and no stage move is written", async () => {
    const id = await merchant("Cancel me", "interested");
    const moves = async () =>
      (
        await t.pool.query(
          "select 1 from activities where client_id = $1 and kind = 'stage_change'",
          [id],
        )
      ).rowCount;
    const before = await moves();
    await book(id, at());
    expect((await stageOf(id))?.stage).toBe("interested");
    await cancel(id);
    expect(await stageOf(id)).toMatchObject({ stage: "interested", scheduled_call_at: null });
    expect(await moves()).toBe(before);
  });

  it("with no record of where he was, he goes back to 'Spoke with owner'", async () => {
    const id = await merchant("No history", "interested");
    await t.pool.query("update clients set stage = 'call_scheduled' where id = $1", [id]);
    await t.pool.query("delete from activities where client_id = $1 and kind = 'stage_change'", [
      id,
    ]);
    await cancel(id);
    expect((await stageOf(id))?.stage).toBe("spoke_with_owner");
  });

  it("a merchant who has moved on since keeps his stage", async () => {
    const id = await merchant("Moved on", "interested");
    await book(id, at());
    await asA((q) =>
      q.query("select * from move_client($1, 'application_in', $2::jsonb)", [
        id,
        timersJson({ kind: "follow_up", due_on: d(3) }),
      ]),
    );
    await cancel(id);
    expect((await stageOf(id))?.stage).toBe("application_in");
  });
});

describe("A-21: 'today' inside the database is the user's day", () => {
  /** A zone whose calendar date is NOT the server's (UTC) date right now. */
  async function farZone() {
    const utc = (
      await t.pool.query<{ d: string }>("select (now() at time zone 'UTC')::date::text d")
    ).rows[0]?.d;
    for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      const local = (
        await t.pool.query<{ d: string }>("select (now() at time zone $1)::date::text d", [tz])
      ).rows[0]?.d;
      if (local !== utc) return { tz, local: local as string };
    }
    throw new Error("no zone differs from UTC right now");
  }

  it("app.local_today() follows the signed-in user's time zone", async () => {
    const { tz, local } = await farZone();
    const u = await insertUser(t.pool, `far-${seq}@x.com`, tz);
    const { rows } = await t.db.withUser(u, (q) =>
      q.query<{ d: string }>("select app.local_today()::text d"),
    );
    expect(rows[0]?.d).toBe(local);
  });

  it("a cancelled call's generic follow-up is 'tomorrow' on his calendar", async () => {
    const { tz, local } = await farZone();
    const u = await insertUser(t.pool, `far2-${seq}@x.com`, tz);
    const id = await insertClient(t.db, u, "Far away");
    await t.db.withUser(u, (q) =>
      q.query("select * from move_client($1, 'interested', $2::jsonb)", [
        id,
        timersJson({ kind: "follow_up", due_on: addDays(local, 5) }),
      ]),
    );
    await t.db.withUser(u, (q) =>
      q.query("select * from schedule_call($1, $2::timestamptz, '')", [
        id,
        `${addDays(local, 3)}T15:00:00Z`,
      ]),
    );
    await t.pool.query(
      "update timers set done_at = now(), done_reason = 'replaced' where client_id = $1 and kind <> 'scheduled_call' and done_at is null",
      [id],
    );
    await t.db.withUser(u, (q) => q.query("select * from cancel_call($1)", [id]));
    const { rows } = await t.pool.query<{ due_on: string }>(
      "select due_on::text from timers where client_id = $1 and done_at is null",
      [id],
    );
    expect(rows).toEqual([{ due_on: addDays(local, 1) }]);
  });
});
