import type { Db } from "../db";
import { missingDocsPhrase, type StipKind } from "../mca/stips";

/** The {missing_docs} merge value for one merchant: their required, not yet received checklist items, in words. */
export async function missingDocsFor(q: Db, clientId: string): Promise<string> {
  const { rows } = await q.query<{ kind: StipKind; period: string | null }>(
    `select kind, period::text as period from stips
      where client_id = $1 and required and received_at is null`,
    [clientId],
  );
  return missingDocsPhrase(rows);
}
