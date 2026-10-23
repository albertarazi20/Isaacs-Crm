import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKUP_TABLES, BACKUP_VERSION, buildBackup } from "@/lib/export/backup";
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

describe("full backup", () => {
  it("holds every table of the user's own data, and nothing of anyone else's", async () => {
    const id = await insertClient(t.db, a, "Backed Up Pizza");
    await insertClient(t.db, b, "Somebody Else's Deli");
    await t.db.withUser(a, async (q) => {
      await q.query("select * from move_client($1, 'application_in', $2::jsonb)", [
        id,
        timersJson({ kind: "follow_up", due_on: d(2) }),
      ]);
      await q.query("select * from record_funding($1, $2::jsonb, $3::jsonb)", [
        id,
        JSON.stringify({
          funded_on: d(-10),
          funder_name: "Alpha",
          amount_cents: 5_000_000,
          factor_rate: 1.32,
          payment_cents: 55_000,
          frequency: "daily",
          position_no: 1,
        }),
        timersJson({ kind: "check_in", due_on: d(20) }),
      ]);
      await q.query(
        "insert into snippets (user_id, title, kind, body, sort) values (app.current_user_id(), 'Hello', 'text', 'Hi {first_name}', 0)",
      );
      await q.query(
        "insert into funders (user_id, name) values (app.current_user_id(), 'Pearl Funding')",
      );
    });

    const backup = await t.db.withUser(a, (q) => buildBackup(q, new Date("2026-10-23T12:00:00Z")));
    expect(backup).toMatchObject({
      app: "isaac",
      version: BACKUP_VERSION,
      exportedAt: "2026-10-23T12:00:00.000Z",
    });
    expect(Object.keys(backup.tables)).toEqual([...BACKUP_TABLES]);
    expect(backup.profile).toMatchObject({ email: "isaac@x.com", timezone: "UTC" });

    // The file agrees with the database, table by table, for THIS user.
    for (const name of BACKUP_TABLES) {
      const { rows } = await t.pool.query<{ n: number }>(
        `select count(*)::int n from ${name} where user_id = $1`,
        [a],
      );
      expect(backup.counts[name], name).toBe(rows[0]?.n);
      expect(backup.tables[name]?.length, name).toBe(rows[0]?.n);
    }
    expect(backup.counts.clients).toBe(1);
    expect(backup.counts.fundings).toBe(1);
    expect(backup.counts.snippets).toBe(1);
    expect(backup.counts.funders).toBe(1);
    expect(backup.counts.timers).toBeGreaterThan(0);
    expect(backup.counts.activities).toBeGreaterThan(0);

    const text = JSON.stringify(backup);
    expect(text).toContain("Backed Up Pizza");
    expect(text).not.toContain("Somebody Else's Deli");
    for (const row of backup.tables.clients ?? []) expect(row.user_id).toBe(a);
  });

  it("carries nothing that can act on an account: no tokens, hashes or sessions", async () => {
    await t.pool.query(
      "insert into lead_tokens (user_id, label, token_hash) values ($1, 'site', 'deadbeef-hash')",
      [a],
    );
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc) values ($1, 'isaac@gmail.com', 'secret-refresh')",
      [a],
    );
    const text = JSON.stringify(await t.db.withUser(a, (q) => buildBackup(q)));
    for (const bad of [
      "deadbeef-hash",
      "token_hash",
      "secret-refresh",
      "refresh_token",
      "session_epoch",
    ])
      expect(text, bad).not.toContain(bad);
  });

  it("an empty account still backs up (empty tables, not an error)", async () => {
    const c = await insertUser(t.pool, "empty@x.com", "UTC");
    const backup = await t.db.withUser(c, (q) => buildBackup(q));
    expect(Object.values(backup.counts).every((n) => n === 0)).toBe(true);
    expect(backup.profile).toMatchObject({ email: "empty@x.com" });
  });
});
