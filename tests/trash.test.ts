import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { importClients } from "@/lib/data/import";
import { listTrashed, findDuplicates } from "@/lib/data/queries";
import * as m from "@/lib/data/mutations";
import { importSchema, moveSchema } from "@/lib/data/schemas";
import type { UserContext } from "@/lib/data/types";
import { addDays, addMonths, todayIn } from "@/lib/mca/dates";
import { runReminders, type DigestSender } from "@/lib/system/reminders";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let b: string;
let ctx: UserContext;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "America/New_York");
  b = await insertUser(t.pool, "other@x.com");
  ctx = { today: t.today, timezone: "America/New_York" };
});
afterAll(async () => {
  await t.drop();
});

const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
const asA = <T>(fn: (q: Parameters<Parameters<typeof t.db.withUser>[1]>[0]) => Promise<T>) =>
  t.db.withUser(a, fn);
const openTimers = (id: string) =>
  rows("select kind, due_on::text, note from timers where client_id = $1 and done_at is null", [
    id,
  ]);
const inCards = async (id: string) =>
  (await asA((q) => q.query("select 1 from client_cards where id = $1", [id]))).rowCount === 1;

describe("moving a client to the trash", () => {
  it("hides the card, closes every timer, clears the booked call, keeps the history", async () => {
    const id = await insertClient(t.db, a, "Trash Pizza");
    await t.pool.query(
      `insert into timers (user_id, client_id, kind, due_on) values
         ($1, $2, 'check_in', current_date + 30), ($1, $2, 'scheduled_call', current_date + 2)`,
      [a, id],
    );
    await t.pool.query(
      "update clients set scheduled_call_at = now() + interval '2 days' where id = $1",
      [id],
    );
    await asA((q) => m.addNote(q, { clientId: id, body: "he wants $40k" }));
    expect(await inCards(id)).toBe(true);

    await asA((q) => m.trashClient(q, id));

    expect(await inCards(id)).toBe(false);
    expect(await openTimers(id)).toEqual([]);
    expect((await rows("select scheduled_call_at from clients where id = $1", [id]))[0]).toEqual({
      scheduled_call_at: null,
    });
    const kept = await rows(
      "select kind, body from activities where client_id = $1 order by occurred_at",
      [id],
    );
    expect(kept.map((r) => r.body)).toEqual(["Client added", "he wants $40k", "Moved to trash"]);
  });

  it("is safe to do twice — one trash entry, one history line", async () => {
    const id = await insertClient(t.db, a, "Twice Pizza");
    await asA((q) => m.trashClient(q, id));
    await asA((q) => m.trashClient(q, id));
    expect(await rows("select 1 from trashed_clients where client_id = $1", [id])).toHaveLength(1);
    expect(
      await rows("select 1 from activities where client_id = $1 and body = 'Moved to trash'", [id]),
    ).toHaveLength(1);
  });

  it("leaves other clients alone", async () => {
    const keep = await insertClient(t.db, a, "Keep Pizza");
    const gone = await insertClient(t.db, a, "Gone Pizza");
    await asA((q) => m.trashClient(q, gone));
    expect(await inCards(keep)).toBe(true);
    expect(await openTimers(keep)).toHaveLength(1);
  });

  it("lists trashed clients newest first", async () => {
    const first = await insertClient(t.db, a, "Older Trash");
    const second = await insertClient(t.db, a, "Newer Trash");
    await asA((q) => m.trashClient(q, first));
    await new Promise((r) => setTimeout(r, 15));
    await asA((q) => m.trashClient(q, second));
    const list = await asA((q) => listTrashed(q));
    const names = list.map((c) => c.business_name);
    expect(names.indexOf("Newer Trash")).toBeLessThan(names.indexOf("Older Trash"));
    expect(list.find((c) => c.id === second)).toMatchObject({
      business_name: "Newer Trash",
      contact_name: "Mike",
      stage: "name_in",
    });
  });
});

describe("restoring", () => {
  it("gives back the follow-ups the trash closed, exactly as they were", async () => {
    const id = await insertClient(t.db, a, "Back Pizza");
    await t.pool.query(
      "insert into timers (user_id, client_id, kind, due_on, note) values ($1, $2, 'check_in', current_date + 30, 'thirty days')",
      [a, id],
    );
    const before = await openTimers(id);
    await asA((q) => m.trashClient(q, id));
    expect(await openTimers(id)).toEqual([]);
    await asA((q) => m.restoreClient(q, id));
    expect(await inCards(id)).toBe(true);
    expect(await openTimers(id)).toEqual(before);
    expect(await rows("select 1 from trashed_clients where client_id = $1", [id])).toEqual([]);
    const last = await rows(
      "select body from activities where client_id = $1 order by occurred_at desc limit 1",
      [id],
    );
    expect(last[0]?.body).toBe("Restored from trash");
  });

  it("a funded merchant keeps its renewal call", async () => {
    const id = await insertClient(t.db, a, "Funded Back Pizza");
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
    const before = await openTimers(id);
    expect(before.map((x) => x.kind).sort()).toEqual(["check_in", "renewal"]);
    await asA((q) => m.trashClient(q, id));
    await asA((q) => m.restoreClient(q, id));
    expect(await openTimers(id)).toEqual(before);
  });

  it("a timer already past due is not brought back as overdue; a follow-up a week out replaces it", async () => {
    const id = await insertClient(t.db, a, "Late Pizza");
    await t.pool.query(
      "update timers set due_on = current_date - 5 where client_id = $1 and done_at is null",
      [id],
    );
    await asA((q) => m.trashClient(q, id));
    await asA((q) => m.restoreClient(q, id));
    expect(await openTimers(id)).toEqual([
      {
        kind: "follow_up",
        due_on: addDays(todayIn("America/New_York"), 7),
        note: "Restored from trash — pick the next step",
      },
    ]);
  });

  it("a booked call stays cancelled: no timer and no call time", async () => {
    const id = await insertClient(t.db, a, "Booked Pizza");
    await t.pool.query(
      "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'scheduled_call', current_date + 2)",
      [a, id],
    );
    await t.pool.query(
      "update clients set scheduled_call_at = now() + interval '2 days' where id = $1",
      [id],
    );
    await asA((q) => m.trashClient(q, id));
    await asA((q) => m.restoreClient(q, id));
    expect((await openTimers(id)).map((x) => x.kind)).toEqual(["follow_up"]);
    expect((await rows("select scheduled_call_at from clients where id = $1", [id]))[0]).toEqual({
      scheduled_call_at: null,
    });
  });

  it("a do-not-contact merchant comes back 36 months out, never next week", async () => {
    const id = await insertClient(t.db, a, "Stop Pizza");
    await asA((q) => m.setContactStatus(q, { clientId: id, status: "dnc", note: "asked to stop" }));
    await asA((q) => m.trashClient(q, id));
    await asA((q) => m.restoreClient(q, id));
    const [timer, ...rest] = await openTimers(id);
    expect(rest).toEqual([]);
    // The app counts from the user's New York day, which differs from the database's UTC day after 8 PM there.
    expect(timer?.due_on).toBe(addMonths(todayIn("America/New_York"), 36));
  });

  it("only reopens what THIS trash closed, not timers closed earlier", async () => {
    const id = await insertClient(t.db, a, "History Pizza");
    await asA((q) => m.setFollowUp(q, { clientId: id, dueOn: addDays(t.today, 20) }, ctx));
    await asA((q) => m.trashClient(q, id));
    await asA((q) => m.restoreClient(q, id));
    const open = await openTimers(id);
    expect(open).toHaveLength(1);
    expect(open[0]?.due_on).toBe(addDays(t.today, 20));
  });

  it("every restored client has at least one open timer", async () => {
    const id = await insertClient(t.db, a, "Always Pizza");
    await asA((q) => m.trashClient(q, id));
    await asA((q) => m.restoreClient(q, id));
    expect((await openTimers(id)).length).toBeGreaterThanOrEqual(1);
  });

  it("refuses a client that is not in the trash", async () => {
    const id = await insertClient(t.db, a, "Live Pizza");
    await expect(asA((q) => m.restoreClient(q, id))).rejects.toThrow(/not in the trash/);
    expect(await openTimers(id)).toHaveLength(1);
  });
});

describe("deleting forever", () => {
  it("only works on a trashed client and cascades", async () => {
    const id = await insertClient(t.db, a, "Forever Pizza");
    await expect(asA((q) => m.purgeClient(q, id))).rejects.toThrow(/not in the trash/);
    await asA((q) => m.trashClient(q, id));
    await asA((q) => m.purgeClient(q, id));
    for (const table of ["clients", "timers", "activities", "trashed_clients"]) {
      const col = table === "clients" ? "id" : "client_id";
      expect(await rows(`select 1 from ${table} where ${col} = $1`, [id]), table).toEqual([]);
    }
  });
});

describe("one user can't touch another's trash", () => {
  it("B cannot trash, restore, purge or list A's clients", async () => {
    const live = await insertClient(t.db, a, "A Live");
    const trashed = await insertClient(t.db, a, "A Trashed");
    await asA((q) => m.trashClient(q, trashed));
    const asB = <T>(fn: (q: Parameters<Parameters<typeof t.db.withUser>[1]>[0]) => Promise<T>) =>
      t.db.withUser(b, fn);
    await expect(asB((q) => m.trashClient(q, live))).rejects.toThrow(/no longer exists/);
    await expect(asB((q) => m.restoreClient(q, trashed))).rejects.toThrow(/not in the trash/);
    await expect(asB((q) => m.purgeClient(q, trashed))).rejects.toThrow(/not in the trash/);
    expect(await asB((q) => listTrashed(q))).toEqual([]);
    expect(await inCards(live)).toBe(true);
    expect(
      await rows("select 1 from trashed_clients where client_id = $1", [trashed]),
    ).toHaveLength(1);
  });

  it("B cannot write a trash row for A's client straight into the table", async () => {
    const live = await insertClient(t.db, a, "A Live Two");
    await expect(
      t.db.withUser(b, (q) =>
        q.query("insert into trashed_clients (client_id, user_id) values ($1, $2)", [live, a]),
      ),
    ).rejects.toThrow();
    expect(await inCards(live)).toBe(true);
  });
});

describe("a trashed client is really gone from everything else", () => {
  it("no duplicate warning, and a re-import creates a new client instead of skipping", async () => {
    const id = await insertClient(t.db, a, "Echo Diner");
    await t.pool.query("update clients set phone = '5557778888' where id = $1", [id]);
    await asA((q) => m.trashClient(q, id));
    expect(await asA((q) => findDuplicates(q, { phone: "(555) 777-8888" }))).toEqual([]);
    const res = await asA((q) =>
      importClients(
        q,
        importSchema.parse({
          rows: [
            {
              line: 2,
              businessName: "Echo Diner",
              phone: "5557778888",
              stage: "name_in",
              followUpOn: addDays(t.today, 1),
            },
          ],
        }).rows,
        ctx,
      ),
    );
    expect(res).toMatchObject({ created: 1, skippedExisting: 0 });
  });

  it("the digest never lists a trashed client, even if a timer were left open", async () => {
    const user = await insertUser(t.pool, "digest@x.com", "America/New_York");
    const live = await insertClient(t.db, user, "Visible Pizza", t.today);
    const ghost = await insertClient(t.db, user, "Ghost Pizza", t.today);
    // Simulate the worst case: trashed but a timer left open.
    await t.pool.query("insert into trashed_clients (client_id, user_id) values ($1, $2)", [
      ghost,
      user,
    ]);
    const send = vi.fn(async () => "resend_1") as unknown as DigestSender &
      ReturnType<typeof vi.fn>;
    const now = `${t.today}T13:00:00Z`;
    await runReminders({ db: t.db, now: new Date(now), appUrl: "https://app.test", send });
    // other users in this file also have calls due today; take this user's digest, not the first one sent
    const mine = send.mock.calls.find((c) => c[0] === "digest@x.com");
    const text: string = mine?.[1]?.text ?? "";
    expect(text).toContain("Visible Pizza");
    expect(text).not.toContain("Ghost Pizza");
    expect(live).not.toBe(ghost);
  });
});
