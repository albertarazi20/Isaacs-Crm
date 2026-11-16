import type { Db } from "../db";
import { latestApplication } from "../docs/apply";

/**
 * The merchant's in-app application (0530) as the merchant page shows it: the permanent token behind the link
 * (`applyLink(appUrl, token)` builds the URL in the browser), the latest signed application with its PDF in
 * Documents, and the deal whose Documents tab holds it.
 */
export interface MerchantApplication {
  token: string;
  latest: {
    id: string;
    signer_name: string;
    signed_at: string;
    /** The PDF in Documents (`/api/docs/<id>`); null when the file was deleted. */
    document_id: string | null;
  } | null;
  /** The deal to open for the Documents tab: the one the application was signed for, else the newest. */
  deal_id: string | null;
}

export async function merchantApplication(
  q: Db,
  clientId: string,
): Promise<MerchantApplication | null> {
  const { rows } = await q.query<{ application_token: string }>(
    "select application_token from clients where id = $1",
    [clientId],
  );
  const token = rows[0]?.application_token;
  if (!token) return null;
  const latest = await latestApplication(q, clientId);
  const deal = (
    await q.query<{ id: string }>(
      `select coalesce(
                (select a.deal_id from applications a where a.id = $2),
                (select d.id from deals d where d.client_id = $1 order by d.queued_at desc limit 1)) as id`,
      [clientId, latest?.id ?? null],
    )
  ).rows[0]?.id;
  return { token, latest, deal_id: deal ?? null };
}
