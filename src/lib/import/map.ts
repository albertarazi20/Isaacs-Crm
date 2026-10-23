import { addDays, addMonths, parseISODate, toISODate, type ISODate } from "../mca/dates";
import { normalizeUS } from "../mca/phone";
import { STAGES, type StageKey } from "../mca/stages";
import { parseMoney } from "../money";

export const IMPORT_FIELDS = [
  "businessName",
  "contactName",
  "phone",
  "email",
  "wantedAmount",
  "industry",
  "state",
  "notes",
  "stage",
  "followUpOn",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const FIELD_LABELS: Record<ImportField, string> = {
  businessName: "Business name",
  contactName: "Merchant's name",
  phone: "Phone",
  email: "Email",
  wantedAmount: "How much they want",
  industry: "Industry",
  state: "State",
  notes: "Notes",
  stage: "Status / stage",
  followUpOn: "Follow-up date",
};

const SYNONYMS: Record<ImportField, string[]> = {
  businessName: [
    "business",
    "business name",
    "company",
    "company name",
    "dba",
    "legal name",
    "name of business",
    "merchant business",
  ],
  contactName: [
    "contact",
    "contact name",
    "owner",
    "owner name",
    "merchant",
    "merchant name",
    "full name",
    "client",
    "client name",
    "name",
  ],
  phone: ["phone", "phone number", "mobile", "cell", "cell phone", "tel", "telephone", "number"],
  email: ["email", "e-mail", "email address"],
  wantedAmount: [
    "amount",
    "amount wanted",
    "how much",
    "funding amount",
    "requested",
    "request",
    "ask",
    "amount requested",
    "wants",
  ],
  industry: ["industry", "business type", "type"],
  state: ["state", "st"],
  notes: ["notes", "note", "comments", "comment", "last call notes", "call notes", "memo"],
  stage: ["status", "stage"],
  followUpOn: [
    "follow up",
    "follow-up",
    "followup",
    "next follow up",
    "follow up date",
    "next call",
    "callback",
    "call back",
    "next contact",
  ],
};

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ");

/** Best-guess column for each field. Unmatched fields are null; the UI lets Isaac fix any of them. */
export function guessMapping(headers: readonly string[]): Record<ImportField, number | null> {
  const mapping = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null])) as Record<
    ImportField,
    number | null
  >;
  const taken = new Set<number>();
  const normed = headers.map(norm);
  for (const field of IMPORT_FIELDS) {
    for (const syn of SYNONYMS[field]) {
      const idx = normed.findIndex((h, i) => h === norm(syn) && !taken.has(i));
      if (idx >= 0) {
        mapping[field] = idx;
        taken.add(idx);
        break;
      }
    }
  }
  // A sheet with a single "Name" column is a list of businesses, not of contacts.
  if (
    mapping.businessName === null &&
    mapping.contactName !== null &&
    normed[mapping.contactName] === "name"
  ) {
    mapping.businessName = mapping.contactName;
    mapping.contactName = null;
  }
  return mapping;
}

const STAGE_WORDS: [RegExp, StageKey][] = [
  [/^(new|lead|name in)$/, "name_in"],
  [/spoke|talked|contacted/, "spoke_with_owner"],
  [/^interested|hot|warm/, "interested"],
  [/call (scheduled|booked)|scheduled|appointment/, "call_scheduled"],
  [/app(lication)? (sent|out)|sent app/, "application_sent"],
  [/app(lication)? (in|back|received)|signed app/, "application_in"],
  [/stips?|docs?|statements?/, "stips"],
  [/submitted|sent to (funders?|lenders?)/, "submitted"],
  [/offers?|approved|approval/, "offers_in"],
  [/presented/, "offer_presented"],
  [/contract/, "contract_out"],
  [/paid (in full|off)|paid$/, "paid_in_full"],
  [/declined|denied|rejected/, "declined"],
  [/^lost|went (with|elsewhere)|funded elsewhere|competitor/, "lost"],
  [/killed|withdrew|pulled/, "killed"],
  [/dead|no response|ghost/, "dead"],
  [/not interested|no thanks/, "not_interested"],
];

/** Stages that can be imported with no extra data. Funded and default stages need terms, so they can't be. */
const IMPORTABLE = new Set<StageKey>(
  STAGES.filter((s) => ["prospecting", "underwriting", "exit"].includes(s.group)).map((s) => s.key),
);
IMPORTABLE.add("paid_in_full");

export function parseStageWord(raw: string): { stage: StageKey | null; unsupported: boolean } {
  const w = norm(raw);
  if (!w) return { stage: null, unsupported: false };
  const byKey = STAGES.find((s) => s.key === w.replace(/ /g, "_") || norm(s.label) === w);
  const hit = byKey?.key ?? STAGE_WORDS.find(([re]) => re.test(w))?.[1] ?? null;
  if (hit && IMPORTABLE.has(hit)) return { stage: hit, unsupported: false };
  return {
    stage: null,
    unsupported:
      /funded|default|collections|written/.test(w) || (hit !== null && !IMPORTABLE.has(hit)),
  };
}

/** YYYY-MM-DD, M/D/YYYY or M/D/YY. Null when it isn't a date. */
export function parseLooseDate(raw: string): ISODate | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  let y: number, m: number, d: number;
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us) {
    [m, d] = [Number(us[1]), Number(us[2])];
    y = Number(us[3]);
    if (y < 100) y += 2000;
  } else return null;
  const out = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  try {
    return toISODate(parseISODate(out));
  } catch {
    return null;
  }
}

/** A status that means "stop contacting this person". Those rows are never imported as leads. */
const DO_NOT_CONTACT =
  /\b(do not|don'?t) (call|contact|text|email)\b|\bdnc\b|\bcease\b|\bstop (calling|texting|contacting)\b|\bremove me\b|\bunsubscribe/i;

export function isDoNotContact(raw: string): boolean {
  return DO_NOT_CONTACT.test(raw);
}

export interface ImportRow {
  line: number;
  businessName: string;
  contactName: string;
  phone: string;
  email: string;
  wantedAmount: string;
  industry: string;
  state: string;
  notes: string;
  stage: StageKey;
  followUpOn: ISODate;
  /** Set when the sheet's status couldn't be imported as-is (e.g. "Funded"), so the note says so. */
  statusNote: string;
}

export interface RowProblem {
  line: number;
  message: string;
}

export interface BuildResult {
  rows: ImportRow[];
  problems: RowProblem[];
  /** Rows dropped because the same phone appeared earlier in the file. */
  duplicatesInFile: number;
  /** Rows the sheet marked do-not-call / do-not-contact: never imported, so they can't be texted by a timer. */
  doNotContact: number;
}

export interface BuildOptions {
  today: ISODate;
  /** Imported rows with no date are spread over this many days so Isaac isn't buried on day one. */
  spreadDays: number;
}

/** Turn parsed CSV records (header row excluded) into validated rows. Never throws on bad data — it reports it. */
export function buildRows(
  records: readonly (readonly string[])[],
  mapping: Record<ImportField, number | null>,
  opts: BuildOptions,
): BuildResult {
  const rows: ImportRow[] = [];
  const problems: RowProblem[] = [];
  const seenPhones = new Set<string>();
  let duplicatesInFile = 0;
  let doNotContact = 0;
  const get = (r: readonly string[], f: ImportField) =>
    mapping[f] === null ? "" : (r[mapping[f] as number] ?? "").trim();
  const spread = Math.max(1, opts.spreadDays);
  const horizon = addMonths(opts.today, 36);

  records.forEach((r, i) => {
    const line = i + 2; // header is line 1
    const businessName =
      get(r, "businessName") || (mapping.businessName === null ? get(r, "contactName") : "");
    if (!businessName) {
      problems.push({ line, message: "No business name" });
      return;
    }
    const statusRaw = `${get(r, "stage")} ${get(r, "notes")}`;
    if (isDoNotContact(statusRaw)) {
      doNotContact += 1;
      problems.push({
        line,
        message: `${businessName} is marked do-not-contact in your sheet — NOT imported`,
      });
      return;
    }
    const phoneRaw = get(r, "phone");
    const e164 = phoneRaw ? normalizeUS(phoneRaw) : null;
    if (phoneRaw && !e164) {
      problems.push({
        line,
        message: `"${phoneRaw}" isn't a US phone number — imported without it`,
      });
    }
    if (e164) {
      if (seenPhones.has(e164)) {
        duplicatesInFile += 1;
        return;
      }
      seenPhones.add(e164);
    }
    const amount = get(r, "wantedAmount");
    if (amount && parseMoney(amount) === null)
      problems.push({ line, message: `"${amount}" isn't an amount — imported without it` });

    const stageRaw = get(r, "stage");
    const { stage, unsupported } = parseStageWord(stageRaw);
    const statusNote =
      stageRaw && (unsupported || stage === null) ? `Imported status: ${stageRaw}` : "";

    let followUpOn: ISODate = addDays(opts.today, (rows.length % spread) + 1);
    const dateRaw = get(r, "followUpOn");
    if (dateRaw) {
      const parsed = parseLooseDate(dateRaw);
      if (!parsed)
        problems.push({
          line,
          message: `"${dateRaw}" isn't a date — spread it over the next ${spread} days`,
        });
      else if (parsed > horizon) {
        problems.push({
          line,
          message: `${dateRaw} is more than 36 months out — set to 36 months`,
        });
        followUpOn = horizon;
      } else followUpOn = parsed < opts.today ? opts.today : parsed;
    }

    rows.push({
      line,
      businessName,
      contactName: get(r, "contactName"),
      phone: e164 ?? "",
      email: get(r, "email"),
      wantedAmount: parseMoney(amount) === null ? "" : amount,
      industry: get(r, "industry"),
      state: get(r, "state"),
      notes: get(r, "notes"),
      stage: stage ?? "name_in",
      followUpOn,
      statusNote,
    });
  });
  return { rows, problems, duplicatesInFile, doNotContact };
}
