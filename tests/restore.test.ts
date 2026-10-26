import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKUP_TABLES, buildBackup, type Backup } from "@/lib/export/backup";
import { checkBackup, RestoreError, restoreBackup } from "@/lib/export/restore";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertClient, insertUser, timersJson, type TestDb } from "./helpers/db";

let src: TestDb;
let dst: TestDb;
let srcUser: string;
let dstUser: string;
let backup: Backup;
const d = (n: number) => addDays(src.today, n);

beforeAll(async () => {
  src = await createTestDb();
  dst = await createTestDb();
  srcUser = await insertUser(src.pool, "isaac@x.com", "America/New_York");
  dstUser = await insertUser(dst.pool, "isaac-new@x.com", "America/New_York");

  const q = <T>(fn: (c: Parameters<Parameters<typeof src.db.withUser>[1]>[0]) => Promise<T>) =>
    src.db.withUser(srcUser, fn);

  // a funded merchant with a renewal call, notes and an ask
  const funded = await insertClient(src.db, srcUser, "Funded Pizza");
  await q(async (c) => {
    await c.query("select * from move_client($1, 'application_in', $2::jsonb)", [
      funded,
      timersJson({ kind: "follow_up", due_on: d(2) }),
    ]);
    await c.query("select * from record_funding($1, $2::jsonb, $3::jsonb)", [
      funded,
      JSON.stringify({
        funded_on: d(-20),
        funder_name: "Alpha",
        amount_cents: 5_000_000,
        factor_rate: 1.251,
        payment_cents: 55_000,
        frequency: "daily",
        position_no: 1,
        commission_cents: 250_000,
      }),
      timersJson({ kind: "check_in", due_on: d(10) }, { kind: "renewal", due_on: d(60) }),
    ]);
    await c.query(
      "insert into activities (user_id, client_id, kind, body) values (app.current_user_id(), $1, 'note', 'He said call after the 5th — “quoted” text, ünïcode')",
      [funded],
    );
    await c.query(
      "insert into client_asks (user_id, client_id, wanted_amount_cents, wanted_terms) values (app.current_user_id(), $1, 6000000, '6 months')",
      [funded],
    );
  });

  // offers: two funders, one accepted (so the other carries declined_by → a self-reference)
  const deal = await insertClient(src.db, srcUser, "Offer Deli");
  await q(async (c) => {
    await c.query("select * from move_client($1, 'application_in', $2::jsonb)", [
      deal,
      timersJson({ kind: "follow_up", due_on: d(2) }),
    ]);
    const f = [
      (
        await c.query<{ id: string }>(
          "insert into funders (user_id, name) values (app.current_user_id(), 'F1') returning id",
        )
      ).rows[0]?.id,
      (
        await c.query<{ id: string }>(
          "insert into funders (user_id, name) values (app.current_user_id(), 'F2') returning id",
        )
      ).rows[0]?.id,
    ];
    const subs = (
      await c.query<{ id: string }>("select * from create_submissions($1, $2::uuid[], null, '')", [
        deal,
        f,
      ])
    ).rows;
    const offers: string[] = [];
    for (const s of subs) {
      offers.push(
        (
          await c.query<{ id: string }>("select * from record_offer($1, $2::jsonb)", [
            s.id,
            JSON.stringify({ amount_cents: 3_000_000, factor_rate: 1.3 }),
          ])
        ).rows[0]?.id as string,
      );
    }
    await c.query("select * from accept_offer($1)", [offers[0]]);
    await c.query(
      "insert into snippets (user_id, title, kind, body, sort) values (app.current_user_id(), 'Hi', 'text', 'Hi {first_name}', 0)",
    );
  });

  // a merchant in the trash: his closed timers must come back even though the flag blocks new timers
  const gone = await insertClient(src.db, srcUser, "Trashed Taqueria");
  await q((c) => c.query("select trash_client($1)", [gone]));

  backup = await src.db.withUser(srcUser, (c) => buildBackup(c));
  // round-trip through JSON exactly as the file would
  backup = JSON.parse(JSON.stringify(backup)) as Backup;
});
afterAll(async () => {
  await src.drop();
  await dst.drop();
});

const strip = (rows: Record<string, unknown>[]) =>
  rows
    .map((r) => {
      const rest = { ...r };
      delete rest.user_id;
      return JSON.stringify(rest, Object.keys(rest).sort());
    })
    .sort();

describe("restoring a backup", () => {
  it("puts every table back exactly, under the new account", async () => {
    // the fixture really is rich: a trashed merchant, a funded one, and an offer tied to another by declined_by
    expect(backup.counts).toMatchObject({
      clients: 3,
      trashed_clients: 1,
      fundings: 1,
      offers: 2,
      snippets: 1,
    });
    expect(backup.tables.offers?.some((o) => o.declined_by !== null)).toBe(true);
    const client = await dst.pool.connect();
    try {
      await client.query("begin");
      const counts = await restoreBackup(client, backup, dstUser);
      await client.query("commit");
      for (const name of BACKUP_TABLES) expect(counts[name], name).toBe(backup.counts[name]);
    } finally {
      client.release();
    }
    // the destination database now holds the same rows (ignoring whose they are) — read back through the app role
    const again = await dst.db.withUser(dstUser, (c) => buildBackup(c));
    for (const name of BACKUP_TABLES) {
      expect(strip(again.tables[name] ?? []), name).toEqual(strip(backup.tables[name] ?? []));
      for (const row of again.tables[name] ?? []) expect(row.user_id, name).toBe(dstUser);
    }
    // the generated payback was recomputed, not copied: $50,000 × 1.251
    const f = await dst.pool.query<{ payback_cents: string }>(
      "select payback_cents::text from fundings",
    );
    expect(f.rows[0]?.payback_cents).toBe("6255000");
    // the trashed merchant is still trashed, the renewal call is still there
    expect(again.counts.trashed_clients).toBe(1);
    expect(again.tables.timers?.some((t) => t.kind === "renewal" && t.done_at === null)).toBe(true);
  });

  it("the restored account works: the merchants list and an edit behave normally", async () => {
    const r = await dst.pool.query<{ n: number }>(
      "select count(*)::int n from client_cards where user_id = $1",
      [dstUser],
    );
    // the trashed merchant is hidden from the card view, the other two are there
    expect(r.rows[0]?.n).toBe(2);
    await dst.db.withUser(dstUser, (c) =>
      c.query("select * from set_follow_up($1, $2)", [
        backup.tables.clients?.find((x) => x.business_name === "Funded Pizza")?.id,
        addDays(dst.today, 30),
      ]),
    );
  });

  it("refuses to restore twice, or onto an account that already has merchants", async () => {
    const client = await dst.pool.connect();
    try {
      await expect(restoreBackup(client, backup, dstUser)).rejects.toThrow(/already has merchants/);
    } finally {
      client.release();
    }
  });

  it("refuses into a database that still holds the originals", async () => {
    const other = await insertUser(src.pool, "second@x.com", "UTC");
    const client = await src.pool.connect();
    try {
      await expect(restoreBackup(client, backup, other)).rejects.toThrow(/already exist/);
    } finally {
      client.release();
    }
  });

  it("refuses a file that is not a backup, or from another version", () => {
    expect(() => checkBackup({ hello: 1 })).toThrow(RestoreError);
    expect(() => checkBackup({ ...backup, version: 99 })).toThrow(/version 99/);
    const broken = { ...backup, tables: { ...backup.tables, offers: undefined } };
    expect(() => checkBackup(broken)).toThrow(/missing its "offers"/);
  });

  it("the app role can't call the restore function (it would write rows under anyone's id)", async () => {
    await expect(
      dst.db.withUser(dstUser, (c) => c.query("select app.restore_rows('snippets', '[]'::jsonb)")),
    ).rejects.toThrow(/permission denied/);
  });

  it("an unknown table name is refused by the function itself", async () => {
    await expect(
      dst.pool.query("select app.restore_rows('app_users', '[{}]'::jsonb)"),
    ).rejects.toThrow(/not a table a backup can restore into/);
  });
});
