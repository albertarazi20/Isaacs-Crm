/**
 * Lender download links as the Documents panel manages them: mint one for a lender on the deal, list the live
 * ones under each document, and revoke one that went to the wrong desk. Every query runs under RLS
 * (`document_links_by_doc`: a link is visible when its document is).
 */
import { UserError } from "../data/mutations";
import type { Db } from "../db";
import { mintDownloadLink } from "./upload";

/** Expiry choices the panel offers, in minutes. */
export const LINK_EXPIRY_MINUTES = {
  "2h": 120,
  "24h": 1440,
  "7d": 7 * 24 * 60,
} as const;
export type LinkExpiry = keyof typeof LINK_EXPIRY_MINUTES;
export const LINK_EXPIRY_LABELS: Record<LinkExpiry, string> = {
  "2h": "2 hours",
  "24h": "24 hours",
  "7d": "7 days",
};

export interface DocumentLinkRow {
  id: string;
  document_id: string;
  lender_id: string | null;
  /** The funder's name from its record (null when the link was minted for a typed name). */
  lender_name: string | null;
  watermark: string;
  expires_at: string;
  downloads: number;
  max_downloads: number;
  created_at: string;
  created_by_name: string | null;
}

/** Every live link (not revoked, not expired) on the merchant's documents, newest first. */
export async function listLiveDocumentLinks(q: Db, clientId: string): Promise<DocumentLinkRow[]> {
  const { rows } = await q.query<{ j: DocumentLinkRow }>(
    `select to_jsonb(x) as j from (
       select l.id, l.document_id, l.lender_id, f.name as lender_name, l.watermark, l.expires_at, l.downloads,
              l.max_downloads, l.created_at, u.name as created_by_name
         from document_links l
         join documents d on d.id = l.document_id
         left join funders f on f.id = l.lender_id
         left join app_users u on u.id = l.created_by
        where d.client_id = $1 and d.deleted_at is null and l.revoked_at is null and l.expires_at > now()
        order by l.created_at desc
     ) x`,
    [clientId],
  );
  return rows.map((r) => r.j);
}

/**
 * Mint a lender's link. With `lenderId` the watermark and `document_links.lender_id` come from the funder's
 * record; a typed `lenderName` still works for callers that have no record to point at.
 */
export async function mintLenderLink(
  q: Db,
  a: {
    documentId: string;
    createdBy: string;
    lenderId?: string | null;
    lenderName?: string;
    minutes?: number;
  },
): Promise<{ token: string; expiresAt: string; lenderName: string }> {
  let name = (a.lenderName ?? "").trim();
  if (a.lenderId) {
    const { rows } = await q.query<{ name: string }>("select name from funders where id = $1", [
      a.lenderId,
    ]);
    const found = rows[0]?.name;
    if (!found) throw new UserError("That lender is no longer on the list");
    name = found;
  }
  const minted = await mintDownloadLink(q, {
    documentId: a.documentId,
    createdBy: a.createdBy,
    lenderId: a.lenderId ?? null,
    watermark: name ? `Prepared for ${name}` : "Confidential",
    minutes: a.minutes,
  });
  return { ...minted, lenderName: name };
}

/** Kill a link now: the next download with it is refused. Already-dead links say so instead of pretending. */
export async function revokeDocumentLink(q: Db, linkId: string): Promise<void> {
  const res = await q.query(
    "update document_links set revoked_at = now() where id = $1 and revoked_at is null returning id",
    [linkId],
  );
  if (res.rowCount === 0) throw new UserError("That link is already gone");
}
