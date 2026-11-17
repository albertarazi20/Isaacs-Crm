import type { Db } from "../db";
import { missingDocsPhrase, type StipKind } from "../mca/stips";

/**
 * What a checklist bucket asks for when the merchant has no checklist yet (a lead filed straight into the bucket, a
 * merchant moved there by hand): the stock wording those emails used before {missing_docs} existed.
 */
const BUCKET_ASKS: Record<string, string> = {
  missing_app: "the signed application",
  missing_statements: "your recent bank statements",
  missing_newest: "your newest bank statement",
  missing_id: "a photo of your driver's license and a voided check",
};

/**
 * The {missing_docs} merge value for one merchant: their required, not yet received checklist items, in words. With
 * nothing on the checklist, a checklist bucket's own ask (bucketKey); otherwise "" (the field is reported, the email
 * is not sent half-filled).
 */
export async function missingDocsFor(
  q: Db,
  clientId: string,
  bucketKey?: string | null,
): Promise<string> {
  const { rows } = await q.query<{ kind: StipKind; period: string | null }>(
    `select kind, period::text as period from stips
      where client_id = $1 and required and received_at is null`,
    [clientId],
  );
  return missingDocsPhrase(rows) || (bucketKey ? (BUCKET_ASKS[bucketKey] ?? "") : "");
}
