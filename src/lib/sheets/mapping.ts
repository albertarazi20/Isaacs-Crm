import { parseMoney } from "../money";
import { normalizeUS } from "../mca/phone";
import { normalizeState } from "../funders/states";

/**
 * Turning a sheet's rows into lead fields. Pure: no Google, no database. The mapping is guessed from the header
 * row by words a lead vendor would use, and a manager can correct it in Settings. Matching by phone is exact
 * (last ten digits), never a guess.
 */

export const LEAD_FIELDS = [
  "business_name",
  "contact_name",
  "first_name",
  "last_name",
  "phone",
  "phone2",
  "email",
  "email2",
  "industry",
  "state",
  "monthly_revenue",
  "time_in_business",
  "wanted",
  "notes",
] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];

/** field → zero-based column index */
export type Mapping = Partial<Record<LeadField, number>>;

const HINTS: Record<LeadField, RegExp[]> = {
  business_name: [
    /^(business|company|merchant|dba|legal)\b.*name|^business$|^company$|^merchant$|^dba$/i,
  ],
  contact_name: [/^(contact|owner|full)\s*name$|^name$|^owner$|^contact$/i],
  first_name: [/^first\s*name$|^first$|^fname$/i],
  last_name: [/^last\s*name$|^last$|^lname$|^surname$/i],
  phone: [
    /^(phone|cell|mobile|tel|telephone|number|phone\s*number|primary\s*phone|phone\s*1)$/i,
    /phone/i,
  ],
  phone2: [
    /^(phone\s*2|secondary\s*phone|alt\s*phone|other\s*phone|cell\s*2)$/i,
    /(second|alt|other).*(phone|number)/i,
  ],
  email: [/^(e-?mail|email\s*address|primary\s*email|email\s*1)$/i, /e-?mail/i],
  email2: [/^(e-?mail\s*2|secondary\s*e-?mail|alt\s*e-?mail)$/i, /(second|alt|other).*e-?mail/i],
  industry: [/industry|business\s*type|type\s*of\s*business|vertical/i],
  state: [/^state$|^st$|^province$/i],
  monthly_revenue: [/revenue|monthly\s*sales|gross|deposits|sales/i],
  time_in_business: [
    /time\s*in\s*business|years?\s*in\s*business|months?\s*in\s*business|tib|established|start\s*date/i,
  ],
  wanted: [/amount|requested|looking\s*for|how\s*much|funding|loan\s*amount|desired/i],
  notes: [/notes?|comments?|details|remarks|message/i],
};

const clean = (h: unknown) =>
  String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ");

/** Best guess per field from the header row. Earlier hints are stronger; a column is used once. */
export function guessMapping(header: readonly unknown[]): Mapping {
  const cols = header.map(clean);
  const taken = new Set<number>();
  const out: Mapping = {};
  // pass 1: exact-ish hints (first regex); pass 2: loose hints
  for (const pass of [0, 1]) {
    for (const field of LEAD_FIELDS) {
      if (out[field] !== undefined) continue;
      const re = HINTS[field][pass];
      if (!re) continue;
      const idx = cols.findIndex((c, i) => !taken.has(i) && c !== "" && re.test(c));
      if (idx >= 0) {
        out[field] = idx;
        taken.add(idx);
      }
    }
  }
  return out;
}

export interface ParsedRow {
  business_name: string;
  contact_name: string;
  email: string;
  phone: string;
  phone2: string;
  email2: string;
  industry: string;
  state: string;
  monthly_revenue_cents: number | null;
  time_in_business_months: number | null;
  wanted: string;
  notes: string;
  /** Last ten digits of the primary phone (or the secondary when the primary is unusable); null = no usable phone. */
  phone_key: string | null;
}

const cell = (row: readonly unknown[], i: number | undefined): string =>
  i === undefined ? "" : String(row[i] ?? "").trim();

/** "3 years", "36", "2 yrs 4 mos", "2019" (a start year) → months. Null when it cannot be read. */
export function parseMonthsInBusiness(
  raw: string,
  nowYear = new Date().getUTCFullYear(),
): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const y = /(\d+(?:\.\d+)?)\s*(y|yr|yrs|year|years)\b/.exec(s);
  const m = /(\d+)\s*(m|mo|mos|month|months)\b/.exec(s);
  if (y || m) return Math.round((y ? Number(y[1]) * 12 : 0) + (m ? Number(m[1]) : 0));
  if (/^(19|20)\d\d$/.test(s)) return Math.max(0, (nowYear - Number(s)) * 12);
  if (/^\d+$/.test(s))
    return Number(s) > 60
      ? Number(s)
      : Number(s) * 12 > 600
        ? Number(s)
        : Number(s) <= 40
          ? Number(s) * 12
          : Number(s);
  return null;
}

export function parseRow(row: readonly unknown[], map: Mapping): ParsedRow {
  const first = cell(row, map.first_name);
  const last = cell(row, map.last_name);
  const contact = cell(row, map.contact_name) || [first, last].filter(Boolean).join(" ");
  const phone = cell(row, map.phone);
  const phone2 = cell(row, map.phone2);
  const key = (p: string) => {
    const e = normalizeUS(p);
    return e ? e.slice(2) : null;
  };
  const rev = cell(row, map.monthly_revenue);
  return {
    business_name: cell(row, map.business_name) || contact,
    contact_name: contact,
    email: cell(row, map.email).toLowerCase(),
    phone,
    phone2,
    email2: cell(row, map.email2).toLowerCase(),
    industry: cell(row, map.industry),
    state: normalizeState(cell(row, map.state)) ?? cell(row, map.state),
    monthly_revenue_cents: rev ? parseMoney(rev) : null,
    time_in_business_months: parseMonthsInBusiness(cell(row, map.time_in_business)),
    wanted: cell(row, map.wanted),
    notes: cell(row, map.notes),
    phone_key: key(phone) ?? key(phone2),
  };
}

/** A row is a lead when it has a name of some kind and a way to reach them. */
export function isLeadRow(r: ParsedRow): boolean {
  return (
    (r.business_name !== "" || r.contact_name !== "") && (r.phone_key !== null || r.email !== "")
  );
}

/** The sheet id from a pasted URL, or the value itself when it already looks like an id. */
export function spreadsheetIdFrom(input: string): string | null {
  const s = input.trim();
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) return m[1] ?? null;
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}

/** The tab from a pasted URL's #gid=… is a number, not a title; the API wants a title, so it is looked up by gid. */
export function gidFrom(input: string): number | null {
  const m = /[#&]gid=(\d+)/.exec(input);
  return m ? Number(m[1]) : null;
}
