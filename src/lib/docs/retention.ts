/**
 * Dead-deal document retention (plan §13.3; audit S3-8). Statements and IDs of a merchant whose deals all ended
 * dead, declined or lost, with no advance live, are purged once the shop's retention period has passed since the
 * last deal closed: the bytes leave the store, the row is marked deleted (the pointer stays, as the record that a
 * file existed), the stip forgets its key, and the timeline says so. Nightly, as the system.
 */
import type { Db, DbAccess } from "../db";
import type { BlobStore } from "./storage";

export interface PurgeSummary {
  candidates: number;
  purged: number;
  failed: number;
}

/** What is purged: the merchant's own paperwork. Contracts and offer sheets are the deal's record and stay. */
export const PURGED_KINDS = [
  "bank_statement",
  "drivers_license",
  "voided_check",
  "tax_return",
  "proof_of_ownership",
  "processing_statement",
] as const;

interface DeadDocument {
  id: string;
  user_id: string;
  client_id: string;
  kind: string;
  period: string | null;
  filename: string;
  storage_key: string;
  retention_days: number;
}

export async function listDeadDocuments(q: Db, now: Date): Promise<DeadDocument[]> {
  const { rows } = await q.query<DeadDocument>(
    `select d.id, d.user_id, d.client_id, d.kind, d.period::text as period, d.filename, d.storage_key, s.document_retention_days as retention_days
       from documents d join clients c on c.id = d.client_id cross join shop_settings s
      where d.deleted_at is null and d.kind = any($2::text[])
        and exists (select 1 from deals x where x.client_id = d.client_id and x.outcome in ('dead', 'declined', 'lost'))
        and not exists (select 1 from deals x where x.client_id = d.client_id and x.outcome = 'open')
        and not exists (select 1 from deals x where x.client_id = d.client_id and x.outcome = 'funded'
                          and x.closed_at > $1::timestamptz - make_interval(days => s.document_retention_days))
        and not exists (select 1 from fundings f where f.client_id = d.client_id and f.status = 'active')
        and greatest(d.created_at, (select max(x.closed_at) from deals x where x.client_id = d.client_id))
            < $1::timestamptz - make_interval(days => s.document_retention_days)
      order by d.created_at`,
    [now.toISOString(), [...PURGED_KINDS]],
  );
  return rows;
}

/** The nightly sweep. Each document is its own transaction: one bad key does not stop the rest. */
export async function purgeDeadDocuments(args: {
  db: DbAccess;
  store: BlobStore;
  now?: Date;
}): Promise<PurgeSummary> {
  const now = args.now ?? new Date();
  const dead = await args.db.withSystem((q) => listDeadDocuments(q, now));
  const s: PurgeSummary = { candidates: dead.length, purged: 0, failed: 0 };
  for (const d of dead) {
    try {
      await args.store.delete(d.storage_key);
      await args.db.withSystem(async (q) => {
        await q.query(
          `update documents set deleted_at = $2, scan_note = left('purged after ' || $3 || ' days (retention)', 300)
            where id = $1 and deleted_at is null`,
          [d.id, now.toISOString(), String(d.retention_days)],
        );
        await q.query("update stips set doc_key = null where client_id = $1 and doc_key = $2", [
          d.client_id,
          d.storage_key,
        ]);
        await q.query(
          "insert into document_views (document_id, action, viewer_user_id, at) values ($1, 'delete', null, $2)",
          [d.id, now.toISOString()],
        );
        await q.query(
          `insert into activities (user_id, client_id, kind, body, occurred_at)
           values ($1, $2, 'system', 'Purged ' || app.document_label($3, $4::date) || ' — ' || $5 || ' after ' || $6 || ' days (retention, deal dead)', $7)`,
          [
            d.user_id,
            d.client_id,
            d.kind,
            d.period,
            d.filename,
            String(d.retention_days),
            now.toISOString(),
          ],
        );
      });
      s.purged += 1;
    } catch (e) {
      s.failed += 1;
      console.error(`purge failed for document ${d.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return s;
}
