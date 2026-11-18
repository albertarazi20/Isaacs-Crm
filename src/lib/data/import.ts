import type { Db } from "../db";
import { refuseAnotherReps } from "../leads/owner";
import { normalizeUS } from "../mca/phone";
import { toActionError } from "./errors";
import { addNote, createClient, UserError } from "./mutations";
import { importRowSchema, newClientSchema, type ImportRowInput } from "./schemas";
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
 * What the person's book already holds, the way an import judges a row (read under row security, so a rep is
 * matched against their own merchants): live phones and names, and the phones and names of trashed merchants who
 * are do-not-contact or limited.
 */
async function loadKnown(q: Db) {
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
  return { existing, existingNames, heldPhones, heldNames };
}

export interface ImportCheck {
  /** File lines whose merchant is already in the person's CRM: the import skips them. */
  existing: number[];
  /** File lines that match a do-not-contact merchant in the trash: never re-added. */
  doNotContact: number[];
}

/**
 * The review step's look-ahead: which rows the import would skip, judged exactly as importClients judges them (by
 * phone, or by business name when a row has no phone), so "Ready to import" counts only rows that will land.
 */
export async function checkImportRows(
  q: Db,
  rows: readonly { line: number; phone: string; businessName: string }[],
): Promise<ImportCheck> {
  const { existing, existingNames, heldPhones, heldNames } = await loadKnown(q);
  const out: ImportCheck = { existing: [], doNotContact: [] };
  for (const row of rows) {
    const e164 = row.phone ? normalizeUS(row.phone) : null;
    const name = nameKey(row.businessName);
    if ((e164 && heldPhones.has(e164)) || (!e164 && heldNames.has(name))) {
      out.doNotContact.push(row.line);
      continue;
    }
    if ((e164 && existing.has(e164)) || (!e164 && existingNames.has(name))) {
      out.existing.push(row.line);
      continue;
    }
    // a later row of the same file with the same name and no phone is skipped once this one lands
    if (e164) existing.add(e164);
    else existingNames.add(name);
  }
  return out;
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
  const { existing, existingNames, heldPhones, heldNames } = await loadKnown(q);
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
      // another rep's merchant is not imported a second time: the row is listed as failed, with whose it is
      await refuseAnotherReps(q, { phone: input.phone, email: input.email });
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

/**
 * What the import action receives: every row is checked on its own, so one row that fails the schema (a bad value
 * the review step could not see) lands in `failed` with its file line instead of rejecting the whole batch.
 */
export async function importRawRows(
  q: Db,
  input: unknown,
  ctx: UserContext,
): Promise<ImportResult> {
  const raw = (input as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(raw) || raw.length === 0) throw new UserError("Nothing to import");
  if (raw.length > 2000) throw new UserError("Import up to 2,000 clients at a time");
  const good: ImportRowInput[] = [];
  const bad: { line: number; message: string }[] = [];
  for (const r of raw) {
    const parsed = importRowSchema.safeParse(r);
    if (parsed.success) good.push(parsed.data);
    else {
      const line = (r as { line?: unknown } | null)?.line;
      bad.push({
        line: typeof line === "number" && Number.isInteger(line) ? line : 0,
        message: toActionError(parsed.error),
      });
    }
  }
  const result = good.length
    ? await importClients(q, good, ctx)
    : { created: 0, skippedExisting: 0, skippedDoNotContact: 0, failed: [] };
  result.failed.push(...bad);
  return result;
}
