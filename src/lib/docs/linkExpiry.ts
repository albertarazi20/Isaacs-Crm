/**
 * The shapes the Documents panel shares with the server side of lender links: the expiry choices and a link row.
 * No database or Node imports here on purpose — a client component imports this file, never links.ts.
 */
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

/** The merchant's in-app application page (0530). Browser-safe: the rep's "copy application link" uses it too. */
export const applyLink = (appUrl: string, applicationToken: string): string =>
  `${appUrl}/apply/${applicationToken}`;
