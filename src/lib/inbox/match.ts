import { nameKey } from "../data/nameKey";

/**
 * The matching ladder: which deal does an inbound email belong to? Decided by code, in this order, never by the
 * AI. Each rung returns a match with how it was made, so the receipt on the deal says "matched by thread".
 */

export interface InboundHeaders {
  threadId: string | null;
  inReplyTo: string | null;
  references: readonly string[];
  fromAddress: string;
  subject: string;
  text: string;
}

export interface Candidate {
  submissionId: string;
  dealId: string;
  clientId: string;
  funderId: string;
  /** Gmail thread id of the submission we sent, if sent from the CRM. */
  threadId: string | null;
  /** RFC Message-ID of the submission we sent. */
  messageId: string | null;
  dealNumber: number;
  businessName: string;
  dba: string;
  funderDomain: string;
}

export type MatchedBy = "thread" | "reply_headers" | "deal_token" | "funder_name";

export interface Match {
  by: MatchedBy;
  candidate: Candidate;
}

export const DEAL_TOKEN = /\[D-(\d+)\]/;

/** The deal number stamped in a subject line, if any. */
export function dealTokenIn(subject: string): number | null {
  const m = DEAL_TOKEN.exec(subject);
  return m ? Number(m[1]) : null;
}

export function domainOf(address: string): string {
  const m = /@([^>\s]+)/.exec(address);
  return (m?.[1] ?? "").toLowerCase();
}

/** Trigram similarity between two business names, 0..1. Suffixes (LLC, Inc) and punctuation are ignored. */
export function nameSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    nameKey(
      s
        .toLowerCase()
        .replace(/\b(llc|inc|corp|co|ltd|dba|the|and)\b/g, " ")
        .replace(/\s+/g, " "),
    );
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string) => {
    const g = new Set<string>();
    const p = `  ${s} `;
    for (let i = 0; i < p.length - 2; i += 1) g.add(p.slice(i, i + 3));
    return g;
  };
  const gx = grams(x);
  const gy = grams(y);
  let shared = 0;
  for (const g of gx) if (gy.has(g)) shared += 1;
  return shared / Math.max(gx.size, gy.size);
}

/**
 * Pick the deal for an email. `candidates` are the open submissions (across the shop) the sync loaded. Returns the
 * match or null when nothing is certain enough; the caller puts null in the triage tray.
 */
export function matchEmail(h: InboundHeaders, candidates: readonly Candidate[]): Match | null {
  // 1. same Gmail thread as a submission we sent
  if (h.threadId) {
    const c = candidates.find((x) => x.threadId && x.threadId === h.threadId);
    if (c) return { by: "thread", candidate: c };
  }
  // 2. reply headers point at the submission's Message-ID
  const ids = new Set([h.inReplyTo, ...h.references].filter((x): x is string => Boolean(x)));
  if (ids.size) {
    const c = candidates.find((x) => x.messageId && ids.has(x.messageId));
    if (c) return { by: "reply_headers", candidate: c };
  }
  // 3. the [D-1042] token, narrowed to the sender's funder when several lenders have the deal
  const token = dealTokenIn(h.subject);
  if (token !== null) {
    const same = candidates.filter((x) => x.dealNumber === token);
    const dom = domainOf(h.fromAddress);
    const c =
      same.find((x) => x.funderDomain && x.funderDomain === dom) ??
      (same.length === 1 ? same[0] : undefined);
    if (c) return { by: "deal_token", candidate: c };
  }
  // 4. sender is a known funder domain and the subject/body names the business closely
  const dom = domainOf(h.fromAddress);
  if (dom) {
    const fromFunder = candidates.filter((x) => x.funderDomain === dom);
    const hay = `${h.subject}\n${h.text.slice(0, 4000)}`;
    let best: { c: Candidate; score: number } | null = null;
    for (const c of fromFunder) {
      const names = [c.businessName, c.dba].filter(Boolean);
      // a name that appears in the email (ignoring punctuation) is as good as a thread
      // "Mike's Pizza" and "Mikes Pizza" are the same name: apostrophes vanish, everything else non-alphanumeric is a space
      const squash = (x: string) =>
        x
          .toLowerCase()
          .replace(/['’]/g, "")
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
      const hayS = squash(hay);
      const core = (x: string) =>
        squash(x)
          .replace(/\b(llc|inc|corp|corporation|co|ltd|dba)\b/g, "")
          .replace(/\s+/g, " ")
          .trim();
      let score = names.some((n) => core(n).length >= 4 && hayS.includes(core(n))) ? 0.95 : 0;
      if (!score) {
        // otherwise compare against each line of the subject/body that might be the business
        for (const line of hay.split(/\n|[|·•]/).slice(0, 60)) {
          for (const n of names) score = Math.max(score, nameSimilarity(n, line.trim()));
        }
      }
      if (!best || score > best.score) best = { c, score };
    }
    if (best && best.score >= 0.8) return { by: "funder_name", candidate: best.c };
  }
  return null;
}

/** Decode a Gmail Authentication-Results header into pass/fail for SPF and DKIM. */
export function authResults(header: string | null): { spf: boolean | null; dkim: boolean | null } {
  if (!header) return { spf: null, dkim: null };
  const h = header.toLowerCase();
  const spf = /spf=pass/.test(h) ? true : /spf=(fail|softfail|none|neutral)/.test(h) ? false : null;
  const dkim = /dkim=pass/.test(h) ? true : /dkim=(fail|none|neutral)/.test(h) ? false : null;
  return { spf, dkim };
}
