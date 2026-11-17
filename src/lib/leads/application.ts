import type { Db } from "../db";
import { latestApplication } from "../docs/apply";

/**
 * The merchant's in-app application (0530) as the merchant page shows it: the permanent token behind the link
 * (`applyLink(appUrl, token)` builds the URL in the browser), the latest signed application with its PDF in
 * Documents.
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
  return { token, latest };
}
