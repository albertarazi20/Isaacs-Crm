import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importClients } from "@/lib/data/import";
import * as m from "@/lib/data/mutations";
import { findDuplicates, listTrashed } from "@/lib/data/queries";
import { importSchema, moveSchema, newClientSchema } from "@/lib/data/schemas";
import type { UserContext } from "@/lib/data/types";
import { ingestLead } from "@/lib/leads/intake";
import { leadSchema } from "@/lib/leads/schema";
import { addDays } from "@/lib/mca/dates";
import { loadCohort } from "@/lib/reports/queries";
import { buildDeathPoints } from "@/lib/reports/report";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let ctx: UserContext;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "UTC");
  ctx = { today: t.today, timezone: "UTC" };
});
afterAll(async () => {
  await t.drop();
});

type Q = Parameters<Parameters<typeof t.db.withUser>[1]>[0];
const asA = <T>(fn: (q: Q) => Promise<T>) => t.db.withUser(a, fn);
const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
const open = (id: string) =>
  rows(
    "select kind, due_on::text, note from timers where client_id = $1 and done_at is null order by kind",
    [id],
  );

/** A merchant with a known phone who then says "stop" and is cleaned out into the trash. */
async function trashedDnc(name: string, phone: string): Promise<string> {
  const id = await insertClient(t.db, a, name);
  await t.pool.query("update clients set phone = $2 where id = $1", [id, phone]);
  await asA((q) => m.setContactStatus(q, { clientId: id, status: "dnc", note: "asked to stop" }));
  await asA((q) => m.trashClient(q, id));
  return id;
}

describe("R-1: a do-not-contact merchant in the trash is still a do-not-contact merchant", () => {
  it("duplicate check still finds it, and says it is trashed", async () => {
    const id = await trashedDnc("Stop Diner", "+15557778801");
    const found = await asA((q) => findDuplicates(q, { phone: "(555) 777-8801" }));
    expect(found).toEqual([expect.objectContaining({ id, reason: "same phone", trashed: true })]);
  });
  it("an ordinary trashed merchant is still invisible to the duplicate check", async () => {
    const id = await insertClient(t.db, a, "Plain Trash");
    await t.pool.query("update clients set phone = '+15557778802' where id = $1", [id]);
    await asA((q) => m.trashClient(q, id));
    expect(await asA((q) => findDuplicates(q, { phone: "5557778802" }))).toEqual([]);
  });
  it("a re-import of the same number creates nothing and says why", async () => {
    await trashedDnc("Stop Import", "+15557778803");
    const before = (await rows("select count(*)::int n from clients"))[0]?.n;
    const res = await asA((q) =>
      importClients(
        q,
        importSchema.parse({
          rows: [
            {
              line: 2,
              businessName: "Stop Import Co",
              phone: "555-777-8803",
              stage: "name_in",
              followUpOn: addDays(t.today, 1),
            },
          ],
        }).rows,
        ctx,
      ),
    );
    expect(res).toEqual({ created: 0, skippedExisting: 0, skippedDoNotContact: 1, failed: [] });
    expect((await rows("select count(*)::int n from clients"))[0]?.n).toBe(before);
  });
  it("lead intake adds a note to the kept record, schedules nothing, and tells the sender", async () => {
    const id = await trashedDnc("Stop Lead", "+15557778804");
    const res = await asA((q) =>
      ingestLead(
        q,
        leadSchema.parse({ businessName: "Stop Lead", phone: "555-777-8804", source: "Vendor" }),
        ctx,
      ),
    );
    expect(res).toEqual({
      status: "duplicate",
      clientId: id,
      matchedOn: "phone",
      doNotContact: true,
    });
    expect(await open(id)).toEqual([]);
    expect(
      (
        await rows("select 1 from activities where client_id = $1 and body like 'Came in again%'", [
          id,
        ])
      ).length,
    ).toBe(1);
    expect((await rows("select 1 from clients where phone like '%7778804'")).length).toBe(1);
  });
  it("'Delete forever' refuses a do-not-contact merchant, and the record survives", async () => {
    const id = await trashedDnc("Stop Purge", "+15557778805");
    await expect(asA((q) => m.purgeClient(q, id))).rejects.toThrow(/asked not to be contacted/);
    expect((await rows("select 1 from clients where id = $1", [id])).length).toBe(1);
  });
  it("a merchant limited to 'no text' is kept the same way", async () => {
    const id = await insertClient(t.db, a, "No Text Co");
    await asA((q) => m.setContactStatus(q, { clientId: id, status: "no_text", note: "" }));
    await asA((q) => m.trashClient(q, id));
    await expect(asA((q) => m.purgeClient(q, id))).rejects.toThrow(/asked not to be contacted/);
  });
  it("the trash list says which merchants are kept for good", async () => {
    const list = await asA((q) => listTrashed(q));
    expect(list.find((c) => c.business_name === "Stop Purge")?.contact_status).toBe("dnc");
    expect(list.find((c) => c.business_name === "Plain Trash")?.contact_status).toBe("ok");
  });
});

describe("R-3: 'Delete forever' can't overtake a restore", () => {
  it("a purge that waits on a restore finds the merchant live and refuses", async () => {
    const id = await insertClient(t.db, a, "Race Pizza");
    await asA((q) => m.trashClient(q, id));
    const scoped = async () => {
      const c = await t.pool.connect();
      await c.query("begin");
      await c.query("set local role isaac_app");
      await c.query("select set_config('app.user_id', $1, true)", [a]);
      return c;
    };
    const restorer = await scoped();
    const purger = await scoped();
    try {
      await restorer.query("select restore_client($1)", [id]);
      const purge = purger.query("select purge_client($1)", [id]).then(
        () => "purged",
        (e: Error) => e.message,
      );
      await new Promise((r) => setTimeout(r, 150)); // the purge is now waiting on the row lock
      await restorer.query("commit");
      expect(await purge).toMatch(/not in the trash/);
    } finally {
      await purger.query("rollback").catch(() => undefined);
      restorer.release();
      purger.release();
    }
    expect((await rows("select 1 from clients where id = $1", [id])).length).toBe(1);
    expect((await open(id)).length).toBeGreaterThanOrEqual(1);
  });
});

describe("R-8: booking a call is part of the history", () => {
  it("a deal that booked a call and then died still counts as having reached the owner", async () => {
    const c = await asA((q) =>
      m.createClient(q, newClientSchema.parse({ businessName: "Booked Then Dead" }), ctx),
    );
    await asA((q) =>
      m.scheduleCall(
        q,
        { clientId: c.id, at: new Date(Date.now() + 2 * 86_400_000).toISOString(), note: "" },
        ctx,
      ),
    );
    await asA((q) => m.moveClient(q, moveSchema.parse({ clientId: c.id, stage: "lost" }), ctx));
    const hist = await rows(
      "select from_stage, to_stage from activities where client_id = $1 and kind = 'stage_change' order by occurred_at, id",
      [c.id],
    );
    expect(hist).toEqual([
      { from_stage: "name_in", to_stage: "call_scheduled" },
      { from_stage: "call_scheduled", to_stage: "lost" },
    ]);
    const cohort = (await asA((q) => loadCohort(q, null))).filter((x) => x.id === c.id);
    expect(buildDeathPoints(cohort)).toEqual([{ label: "After Interested", count: 1 }]);
  });
  it("booking a call on a deal that is already past that stage adds no stage change", async () => {
    const c = await asA((q) =>
      m.createClient(
        q,
        newClientSchema.parse({ businessName: "Already Further", stage: "stips" }),
        ctx,
      ),
    );
    await asA((q) =>
      m.scheduleCall(
        q,
        { clientId: c.id, at: new Date(Date.now() + 2 * 86_400_000).toISOString(), note: "" },
        ctx,
      ),
    );
    const n = (
      await rows(
        "select count(*)::int n from activities where client_id = $1 and kind = 'stage_change'",
        [c.id],
      )
    )[0]?.n;
    expect(n).toBe(0);
  });
});

describe("R-9: restoring a funded merchant keeps an OVERDUE renewal call", () => {
  it("brings it back due today; an overdue plain follow-up is replaced by one a week out", async () => {
    const id = await insertClient(t.db, a, "Overdue Renewal Pizza");
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
            funderName: "Alpha",
          },
        }),
        ctx,
      ),
    );
    await t.pool.query(
      "update timers set due_on = current_date - 3 where client_id = $1 and done_at is null and kind in ('renewal','check_in')",
      [id],
    );
    await t.pool.query(
      "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'follow_up', current_date - 4)",
      [a, id],
    );
    await asA((q) => m.trashClient(q, id));
    await asA((q) => m.restoreClient(q, id));
    expect((await open(id)).map((x) => [x.kind, x.due_on])).toEqual([
      ["check_in", t.today],
      ["renewal", t.today],
    ]);
  });
});

describe("R-10: a trashed merchant can't be given new timers", () => {
  it("every way of adding one is refused, and restoring still works afterwards", async () => {
    const id = await insertClient(t.db, a, "Frozen Pizza");
    await asA((q) => m.trashClient(q, id));
    await expect(
      asA((q) => m.setFollowUp(q, { clientId: id, dueOn: addDays(t.today, 3) }, ctx)),
    ).rejects.toThrow(/in the trash/);
    await expect(
      t.pool.query(
        "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'follow_up', current_date + 1)",
        [a, id],
      ),
    ).rejects.toThrow(/in the trash/);
    await expect(
      asA((q) =>
        q.query("select * from create_submissions($1, $2::uuid[])", [
          id,
          ["00000000-0000-0000-0000-000000000000"],
        ]),
      ),
    ).rejects.toThrow();
    expect(await open(id)).toEqual([]);
    await asA((q) => m.restoreClient(q, id));
    expect((await open(id)).length).toBe(1);
  });
});

describe("R-16: trashing a merchant takes its submissions out of the funder scoreboard", () => {
  it("counts come back when it is restored", async () => {
    const { funderScoreboard } = await import("@/lib/funders/queries");
    const id = await insertClient(t.db, a, "Scoreboard Pizza");
    const f = (
      await t.pool.query<{ id: string }>(
        "insert into funders (user_id, name) values ($1, 'Score Fund') returning id",
        [a],
      )
    ).rows[0]!.id;
    await asA((q) => q.query("select * from create_submissions($1, $2::uuid[])", [id, [f]]));
    const sent = async () => (await asA((q) => funderScoreboard(q, [f])))[f]?.submissions ?? 0;
    expect(await sent()).toBe(1);
    await asA((q) => m.trashClient(q, id));
    expect(await sent()).toBe(0);
    await asA((q) => m.restoreClient(q, id));
    expect(await sent()).toBe(1);
  });
});
