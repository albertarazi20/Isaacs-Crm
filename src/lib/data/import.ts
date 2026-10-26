import type { Db } from "../db";
import { normalizeUS } from "../mca/phone";
import { toActionError } from "./errors";
import { addNote, createClient } from "./mutations";
import { newClientSchema, type ImportRowInput } from "./schemas";
import type { UserContext } from "./types";

import { nameKey } from "./nameKey";

export interface ImportResult {
  created: number;
  /** Rows already in the CRM (same phone, or same business name when there's no phone) — left alone. */
  skippedExisting: number;
  /** Rows that match a do-not-contact merchant in the trash — never re-added as fresh leads. */
  skippedDoNotContact: number;
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
  // Live merchants, plus trashed ones that are do-not-contact or limited: a "stop" must survive a clean-up.
  const all = (
    await q.query<{ phone: string; business_name: string; trashed: boolean }>(
      `select phone, business_name,
              exists (select 1 from trashed_clients t where t.client_id = clients.id) as trashed
         from clients
        where contact_status <> 'ok'
           or not exists (select 1 from trashed_clients t where t.client_id = clients.id)`,
    )
  ).rows;
  const phonesOf = (list: typeof all) =>
    new Set(list.map((r) => normalizeUS(r.phone)).filter((p): p is string => p !== null));
  // A row with no usable phone can only be matched by name — otherwise every re-import would duplicate it.
  const namesOf = (list: typeof all) =>
    new Set(list.filter((r) => normalizeUS(r.phone) === null).map((r) => nameKey(r.business_name)));
  const live = all.filter((r) => !r.trashed);
  const held = all.filter((r) => r.trashed);
  const existing = phonesOf(live);
  const existingNames = namesOf(live);
  const heldPhones = phonesOf(held);
  const heldNames = namesOf(held);
  const result: ImportResult = {
    created: 0,
    skippedExisting: 0,
    skippedDoNotContact: 0,
    failed: [],
  };

  for (const row of rows) {
    const e164 = row.phone ? normalizeUS(row.phone) : null;
    if ((e164 && heldPhones.has(e164)) || (!e164 && heldNames.has(nameKey(row.businessName)))) {
      result.skippedDoNotContact += 1;
      continue;
    }
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
        source: row.source || "Imported",
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
        message: toActionError(e),
      });
    }
  }
  return result;
}
