import type { Db } from "../db";
import { latestApplication } from "../docs/apply";

/**
 * What the Documents tab shows about the merchant's application (0530): the permanent link the merchant signs on,
 * and the latest signed one with its PDF. The token is the key to the public page, so only a person who can see
 * the merchant reads it (RLS on clients).
 */
export interface ApplicationInfo {
  token: string;
  latest: {
    id: string;
    signer_name: string;
    signed_at: string;
    document_id: string | null;
  } | null;
}

export async function loadApplicationInfo(
  q: Db,
  clientId: string,
): Promise<ApplicationInfo | null> {
  const row = (
    await q.query<{ application_token: string }>(
      "select application_token from clients where id = $1",
      [clientId],
    )
  ).rows[0];
  if (!row) return null;
  return { token: row.application_token, latest: await latestApplication(q, clientId) };
}
