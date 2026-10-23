import type { Db } from "../db";
import { normalizeUS } from "../mca/phone";
import { addNote, createClient } from "./mutations";
import { newClientSchema, type ImportRowInput } from "./schemas";
import type { UserContext } from "./types";

/** "Mike's Pizza, LLC" and "mikes pizza llc" are the same business. */
const nameKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export interface ImportResult {
  created: number;
  /** Rows already in the CRM (same phone, or same business name when there's no phone) — left alone. */
  skippedExisting: number;
  failed: { line: number; message: string }[];
}

/**
 * Creates one client per row, each in its own savepoint: a bad row is reported and skipped, the rest
 * still import. Safe to run twice with the same file.
 */
export async function importClients(
  q: Db,
  rows: readonly ImportRowInput[],
  ctx: UserContext,
): Promise<ImportResult> {
  const all = (
    await q.query<{ phone: string; business_name: string }>(
      "select phone, business_name from clients",
    )
  ).rows;
  const existing = new Set(
    all.map((r) => normalizeUS(r.phone)).filter((p): p is string => p !== null),
  );
  // A row with no usable phone can only be matched by name — otherwise every re-import would duplicate it.
  const existingNames = new Set(
    all.filter((r) => normalizeUS(r.phone) === null).map((r) => nameKey(r.business_name)),
  );
  const result: ImportResult = { created: 0, skippedExisting: 0, failed: [] };

  for (const row of rows) {
    const e164 = row.phone ? normalizeUS(row.phone) : null;
    if ((e164 && existing.has(e164)) || (!e164 && existingNames.has(nameKey(row.businessName)))) {
      result.skippedExisting += 1;
      continue;
    }
    await q.query("savepoint import_row");
    try {
      const input = newClientSchema.parse({
        businessName: row.businessName,
        contactName: row.contactName,
        phone: row.phone,
        email: row.email,
        industry: row.industry,
        state: row.state,
        stage: row.stage,
        followUpOn: row.followUpOn,
        wantedAmount: row.wantedAmount,
        source: "Imported",
      });
      const card = await createClient(q, input, ctx);
      const note = [row.statusNote, row.notes].filter(Boolean).join("\n");
      if (note) await addNote(q, { clientId: card.id, body: note });
      await q.query("release savepoint import_row");
      if (e164) existing.add(e164);
      else existingNames.add(nameKey(row.businessName));
      result.created += 1;
    } catch (e) {
      await q.query("rollback to savepoint import_row");
      result.failed.push({
        line: row.line,
        message: e instanceof Error ? e.message : "Couldn't import this row",
      });
    }
  }
  return result;
}
