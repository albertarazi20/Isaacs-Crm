import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listDeadDocuments, purgeDeadDocuments } from "@/lib/docs/retention";
import { LocalStore } from "@/lib/docs/storage";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let dir: string;
let store: LocalStore;
let rep: string;

const NOW = new Date("2026-11-16T15:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

async function document(
  clientId: string,
  kind: string,
  name: string,
  createdDaysAgo: number,
): Promise<{ id: string; key: string }> {
  const bytes = new TextEncoder().encode(`statement ${name}`);
  const key = `${clientId}/${name}`;
  await store.put(key, bytes, "application/pdf");
  const { rows } = await t.pool.query<{ id: string }>(
    `insert into documents (user_id, client_id, kind, period, filename, content_type, size_bytes, sha256, storage_key, source, scan_status, created_at)
     values ($1, $2, $3, case when $3 = 'bank_statement' then '2024-01-01'::date end, $4, 'application/pdf', $5, $6, $7, 'staff', 'clean', $8) returning id`,
    [
      rep,
      clientId,
      kind,
      name,
      bytes.length,
      createHash("sha256").update(bytes).digest("hex"),
      key,
      ago(createdDaysAgo),
    ],
  );
  return { id: rows[0]!.id, key };
}

async function deal(
  clientId: string,
  outcome: string,
  closedDaysAgo: number | null,
): Promise<void> {
  await t.pool.query(
    `insert into deals (user_id, client_id, kind, ops_status, outcome, closed_at, queued_at)
     values ($1, $2, 'new', $3, $4, $5, $6)`,
    [
      rep,
      clientId,
      outcome === "open" ? "queued" : "closed",
      outcome,
      closedDaysAgo === null ? null : ago(closedDaysAgo),
      ago(closedDaysAgo ?? 1),
    ],
  );
}

beforeAll(async () => {
  t = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "isaac-retention-"));
  store = new LocalStore(dir);
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
});
afterAll(async () => {
  await t.drop();
  rmSync(dir, { recursive: true, force: true });
});

describe("S3-8 dead-deal document retention", () => {
  it("purges statements and IDs on a deal dead longer than the shop's retention, logs it, and leaves the rest", async () => {
    const dead = await insertClient(t.db, rep, "Dead Deli");
    await deal(dead, "dead", 800);
    const stmt = await document(dead, "bank_statement", "jan.pdf", 820);
    const license = await document(dead, "drivers_license", "id.jpg", 820);
    const contract = await document(dead, "signed_contract", "contract.pdf", 820); // the deal's record stays
    // the documents trigger filed the statement as a received stip carrying the storage key
    expect(
      (await t.pool.query("select doc_key from stips where client_id = $1", [dead])).rows[0],
    ).toEqual({ doc_key: stmt.key });
    // a recent dead deal, an open deal, and a funded merchant: all keep their files
    const recent = await insertClient(t.db, rep, "Recent Dead");
    await deal(recent, "declined", 100);
    const recentDoc = await document(recent, "bank_statement", "r.pdf", 120);
    const live = await insertClient(t.db, rep, "Live Deal");
    await deal(live, "dead", 800);
    await deal(live, "open", null);
    const liveDoc = await document(live, "drivers_license", "l.jpg", 900);
    const funded = await insertClient(t.db, rep, "Funded Co");
    await deal(funded, "dead", 900);
    await t.pool.query(
      "insert into fundings (user_id, client_id, funded_on, amount_cents, factor_rate, payment_cents, frequency) values ($1, $2, current_date - 30, 1000000, 1.3, 10000, 'daily')",
      [rep, funded],
    );
    const fundedDoc = await document(funded, "bank_statement", "f.pdf", 900);

    const candidates = await t.db.withSystem((q) => listDeadDocuments(q, NOW));
    expect(candidates.map((c) => c.id).sort()).toEqual([stmt.id, license.id].sort());

    const s = await purgeDeadDocuments({ db: t.db, store, now: NOW });
    expect(s).toEqual({ candidates: 2, purged: 2, failed: 0 });
    expect(await store.get(stmt.key)).toBeNull();
    expect(await store.get(license.key)).toBeNull();
    expect(await store.get(contract.key)).not.toBeNull();
    for (const keep of [recentDoc, liveDoc, fundedDoc])
      expect(await store.get(keep.key)).not.toBeNull();

    const rows = (
      await t.pool.query<{ id: string; deleted_at: Date | null; scan_note: string }>(
        "select id, deleted_at, scan_note from documents where client_id = $1 order by filename",
        [dead],
      )
    ).rows;
    expect(rows.find((r) => r.id === stmt.id)).toMatchObject({
      deleted_at: NOW,
      scan_note: "purged after 730 days (retention)",
    });
    expect(rows.find((r) => r.id === license.id)?.deleted_at).toEqual(NOW);
    expect(rows.find((r) => r.id === contract.id)?.deleted_at).toBeNull();
    expect(
      (
        await t.pool.query(
          "select count(*)::int as n from documents where deleted_at is not null and client_id <> $1",
          [dead],
        )
      ).rows[0]?.n,
    ).toBe(0);
    // the stip forgets its key but stays received; the view log and the timeline say what happened
    expect(
      (await t.pool.query("select doc_key, received_at from stips where client_id = $1", [dead]))
        .rows[0],
    ).toMatchObject({ doc_key: null });
    expect(
      (
        await t.pool.query(
          "select count(*)::int as n from document_views where action = 'delete' and document_id = any($1::uuid[])",
          [[stmt.id, license.id]],
        )
      ).rows[0]?.n,
    ).toBe(2);
    const acts = (
      await t.pool.query<{ body: string }>(
        "select body from activities where client_id = $1 and body like 'Purged%' order by body",
        [dead],
      )
    ).rows.map((r) => r.body);
    expect(acts).toEqual([
      "Purged Driver's license / ID — id.jpg after 730 days (retention, deal dead)",
      "Purged Jan 2024 bank statement — jan.pdf after 730 days (retention, deal dead)",
    ]);
    // a second sweep finds nothing
    expect(await purgeDeadDocuments({ db: t.db, store, now: NOW })).toEqual({
      candidates: 0,
      purged: 0,
      failed: 0,
    });
  });
  it("the shop's retention setting is the clock: a longer period keeps the files", async () => {
    const old = await insertClient(t.db, rep, "Old Lost");
    await deal(old, "lost", 800);
    const doc = await document(old, "voided_check", "check.png", 800);
    await t.pool.query("update shop_settings set document_retention_days = 1000");
    expect(await purgeDeadDocuments({ db: t.db, store, now: NOW })).toEqual({
      candidates: 0,
      purged: 0,
      failed: 0,
    });
    expect(await store.get(doc.key)).not.toBeNull();
    await t.pool.query("update shop_settings set document_retention_days = 730");
    expect((await purgeDeadDocuments({ db: t.db, store, now: NOW })).purged).toBe(1);
    expect(await store.get(doc.key)).toBeNull();
  });
});
