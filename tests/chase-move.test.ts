import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as m from "@/lib/data/mutations";
import { moveSchema } from "@/lib/data/schemas";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "UTC");
});
afterAll(async () => {
  await t.drop();
});

type Q = Parameters<Parameters<typeof t.db.withUser>[1]>[0];
const asA = <T>(fn: (q: Q) => Promise<T>) => t.db.withUser(a, fn);
const ctx = () => ({ today: t.today, timezone: "UTC" });
const move = (clientId: string, stage: string) =>
  asA((q) => m.moveClient(q, moveSchema.parse({ clientId, stage }), ctx()));
const chase = async (clientId: string) =>
  (
    await t.pool.query<{ id: string; due_on: string; done_reason: string | null; open: boolean }>(
      "select id, due_on::text, done_reason, done_at is null as open from timers where client_id = $1 and kind = 'chase' order by created_at, id",
      [clientId],
    )
  ).rows;

/** A merchant submitted to two funders, so two chase timers are open. */
async function submitted(name: string): Promise<string> {
  const id = await insertClient(t.db, a, name);
  await move(id, "stips");
  const funders: string[] = [];
  for (const n of ["One", "Two"]) {
    funders.push(
      (
        await t.pool.query<{ id: string }>(
          "insert into funders (user_id, name) values ($1, $2) returning id",
          [a, `${name} ${n}`],
        )
      ).rows[0]!.id,
    );
  }
  await asA((q) => q.query("select * from create_submissions($1, $2::uuid[])", [id, funders]));
  return id;
}

describe("a stage move and the funders still to answer", () => {
  it("moving within the funding pipeline leaves the SAME chase timers open, not copies", async () => {
    const id = await submitted("Pipeline Pizza");
    const before = await chase(id);
    expect(before.filter((c) => c.open)).toHaveLength(2);
    for (const stage of ["offers_in", "offer_presented", "contract_out", "stips"]) {
      await move(id, stage);
      const now = await chase(id);
      expect(
        now.map((c) => c.id),
        stage,
      ).toEqual(before.map((c) => c.id));
      expect(
        now.every((c) => c.open),
        stage,
      ).toBe(true);
    }
  });

  it("every move still leaves the merchant a follow-up of its own", async () => {
    const id = await submitted("Follow Pizza");
    await move(id, "offers_in");
    const { rows } = await t.pool.query(
      "select 1 from timers where client_id = $1 and kind = 'follow_up' and done_at is null",
      [id],
    );
    expect(rows).toHaveLength(1);
  });

  it.each(["lost", "dead", "killed", "not_interested", "declined"])(
    "moving out to %s closes the chase — nobody is left to wait for",
    async (stage) => {
      const id = await submitted(`Exit ${stage}`);
      await move(id, stage);
      const rows = await chase(id);
      expect(rows).toHaveLength(2);
      expect(rows.every((c) => !c.open && c.done_reason === "stage_moved")).toBe(true);
      const open = await t.pool.query(
        "select 1 from timers where client_id = $1 and done_at is null",
        [id],
      );
      expect(open.rowCount).toBeGreaterThanOrEqual(1);
    },
  );

  it("funding the deal closes the chase on the funders that didn't win", async () => {
    const id = await submitted("Funded Chase Pizza");
    await asA((q) =>
      m.moveClient(
        q,
        moveSchema.parse({
          clientId: id,
          stage: "funded",
          funding: {
            amount: "50k",
            factorRate: "1.32",
            payment: "550",
            frequency: "daily",
            funderName: "One",
          },
        }),
        ctx(),
      ),
    );
    expect((await chase(id)).every((c) => !c.open)).toBe(true);
  });

  it("a snooze leaves chase timers alone", async () => {
    const id = await submitted("Snooze Chase Pizza");
    await asA((q) => m.setFollowUp(q, { clientId: id, dueOn: addDays(t.today, 30) }, ctx()));
    expect((await chase(id)).filter((c) => c.open)).toHaveLength(2);
  });

  it("trash closes them and restore opens the same ones again", async () => {
    const id = await submitted("Trash Chase Pizza");
    const before = (await chase(id)).map((c) => `${c.id}:${c.due_on}`);
    await asA((q) => m.trashClient(q, id));
    expect((await chase(id)).filter((c) => c.open)).toEqual([]);
    await asA((q) => m.restoreClient(q, id));
    const after = await chase(id);
    expect(after.filter((c) => c.open).map((c) => `${c.id}:${c.due_on}`)).toEqual(before);
  });
});
