import { findSensitive } from "../data/sensitive";
import { addDays, addMonths, parseISODate, toISODate, type ISODate } from "../mca/dates";
import { normalizeUS } from "../mca/phone";
import {
  defaultTimers,
  IMPORT_STAGES,
  isStageKey,
  STAGES,
  stageDef,
  type StageKey,
} from "../mca/stages";
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
  "source",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** The server's limits per field. A longer value would reject the WHOLE import, so it is cut here, with a note. */
// the same shape the server accepts (one address)
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

const MAX_LENGTH: Partial<Record<ImportField, number>> = {
  businessName: 200,
  contactName: 200,
  email: 200,
  industry: 100,
  state: 40,
  source: 100,
  notes: 5000,
};

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
  source: "Where they came from",
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
  source: [
    "source",
    "lead source",
    "origin",
    "campaign",
    "list",
    "list name",
    "vendor",
    "lead vendor",
    "referral source",
    "referred by",
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
  [
    /declined|denied|rejected|killed|withdrew|pulled|^lost|went (with|elsewhere)|competitor/,
    "dead",
  ],
  // "Trash" was this stage's old label: a sheet exported then still says it
  [/dead|no response|ghost|^trash$/, "dead"],
  [/not interested|no thanks/, "not_interested"],
];

/** A status from a sheet that is about a file being worked elsewhere; it can't become a stage here, so the note says it. */
const WORKED_ELSEWHERE =
  /submitted|sent to|offers?|approved|approval|presented|contract|funded|default|collections|written|paid/;

const IMPORTABLE = new Set<StageKey>(IMPORT_STAGES);

export function parseStageWord(raw: string): { stage: StageKey | null; unsupported: boolean } {
  const w = norm(raw);
  if (!w) return { stage: null, unsupported: false };
  const key = w.replace(/ /g, "_");
  // a stage's own key first ("not_interested" is a stage of its own), then the label a sheet copied from the app
  const hit =
    STAGES.find((s) => s.key === key)?.key ??
    (isStageKey(key) && IMPORTABLE.has(key) ? key : null) ??
    STAGES.find((s) => norm(s.label) === w)?.key ??
    STAGE_WORDS.find(([re]) => re.test(w))?.[1] ??
    null;
  if (hit && IMPORTABLE.has(hit) && !WORKED_ELSEWHERE.test(w))
    return { stage: hit, unsupported: false };
  return {
    stage: null,
    unsupported: WORKED_ELSEWHERE.test(w) || (hit !== null && !IMPORTABLE.has(hit)),
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
  /** Where the merchant came from: the sheet's column, else the list name typed in the wizard. */
  source: string;
  /** Set when the sheet's status couldn't be imported as-is (e.g. "Submitted"), so the note says so. */
  statusNote: string;
}

export interface RowProblem {
  line: number;
  message: string;
}

export interface BuildResult {
  rows: ImportRow[];
  /**
   * Rows with neither a phone nor an email: nobody could reach the merchant, so they are listed under "To look at"
   * and held back unless the person chooses to import them anyway.
   */
  unreachable: ImportRow[];
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
  /** Used for rows whose sheet has no source of its own — e.g. "Lead vendor, Oct 2026". */
  defaultSource?: string;
}

/** Turn parsed CSV records (header row excluded) into validated rows. Never throws on bad data — it reports it. */
export function buildRows(
  records: readonly (readonly string[])[],
  mapping: Record<ImportField, number | null>,
  opts: BuildOptions,
): BuildResult {
  const rows: ImportRow[] = [];
  const unreachable: ImportRow[] = [];
  const problems: RowProblem[] = [];
  const seenPhones = new Set<string>();
  let duplicatesInFile = 0;
  let doNotContact = 0;
  let currentLine = 0;
  const cut = new Set<string>();
  const get = (r: readonly string[], f: ImportField) => {
    const raw = mapping[f] === null ? "" : (r[mapping[f] as number] ?? "").trim();
    const max = MAX_LENGTH[f];
    if (!max) return raw;
    // One-line fields can't hold line breaks or control characters; notes keep theirs.
    const text =
      f === "notes"
        ? raw
        : raw
            .replace(/[\u0000-\u001f\u007f]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    // What the shop never stores (SSNs, card and account numbers) is dropped from the row, not the whole file.
    const secret = findSensitive(text);
    if (secret) {
      if (!cut.has(`${currentLine}:${f}:secret`)) {
        cut.add(`${currentLine}:${f}:secret`);
        problems.push({
          line: currentLine,
          message: `"${FIELD_LABELS[f]}" looks like it holds a ${secret.kind === "card" ? "card" : secret.kind === "account" ? "bank account" : "Social Security"} number, so it was left out`,
        });
      }
      return "";
    }
    if (text.length <= max) return text;
    if (!cut.has(`${currentLine}:${f}`)) {
      cut.add(`${currentLine}:${f}`);
      problems.push({
        line: currentLine,
        message: `"${FIELD_LABELS[f]}" is longer than ${max} characters, so it was cut to fit`,
      });
    }
    return text.slice(0, max);
  };
  const spread = Math.max(1, opts.spreadDays);
  const horizon = addMonths(opts.today, 36);

  records.forEach((r, i) => {
    const line = i + 2; // header is line 1
    currentLine = line;
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
        message: `${businessName} is marked do-not-contact in your sheet, so it was NOT imported`,
      });
      return;
    }
    const phoneRaw = get(r, "phone");
    const e164 = phoneRaw ? normalizeUS(phoneRaw) : null;
    const emailRaw = get(r, "email");
    // "n/a", "none" or two addresses in one cell is not an email: it is left out, not allowed to sink the batch
    const email = EMAIL.test(emailRaw) ? emailRaw : "";
    if (emailRaw && !email)
      problems.push({
        line,
        message: `"${emailRaw}" isn't an email address, so it was imported without it`,
      });
    const reachable = Boolean(e164 || email);
    if (phoneRaw && !e164 && reachable) {
      problems.push({
        line,
        message: `"${phoneRaw}" isn't a US phone number, so it was imported without it`,
      });
    }
    if (!reachable)
      problems.push({
        line,
        message: phoneRaw
          ? `"${phoneRaw}" isn't a US phone number and there is no email: no way to reach ${businessName}, so it is held back`
          : `No phone or email: no way to reach ${businessName}, so it is held back`,
      });
    if (e164) {
      if (seenPhones.has(e164)) {
        duplicatesInFile += 1;
        return;
      }
      seenPhones.add(e164);
    }
    const amount = get(r, "wantedAmount");
    if (amount && parseMoney(amount) === null)
      problems.push({
        line,
        message: `"${amount}" isn't an amount, so it was imported without it`,
      });

    const stageRaw = get(r, "stage");
    const { stage, unsupported } = parseStageWord(stageRaw);
    const statusNote =
      stageRaw && (unsupported || stage === null) ? `Imported status: ${stageRaw}` : "";

    // a merchant who said no waits as long as the stage says (months), instead of landing on Today as a call to make
    const longWait = stageDef(stage ?? "name_in").followUp.kind === "months";
    let followUpOn: ISODate = longWait
      ? (defaultTimers(stage ?? "name_in", { today: opts.today })[0]?.dueOn ??
        addDays(opts.today, (rows.length % spread) + 1))
      : addDays(opts.today, (rows.length % spread) + 1);
    const dateRaw = get(r, "followUpOn");
    if (dateRaw) {
      const parsed = parseLooseDate(dateRaw);
      if (!parsed)
        problems.push({
          line,
          message: `"${dateRaw}" isn't a date, so it was spread over the next ${spread} days`,
        });
      else if (parsed > horizon) {
        problems.push({
          line,
          message: `${dateRaw} is more than 36 months out, so it was set to 36 months`,
        });
        followUpOn = horizon;
      } else followUpOn = parsed < opts.today ? opts.today : parsed;
    }

    (reachable ? rows : unreachable).push({
      line,
      businessName,
      contactName: get(r, "contactName"),
      phone: e164 ?? "",
      email,
      wantedAmount: parseMoney(amount) === null ? "" : amount,
      industry: get(r, "industry"),
      state: get(r, "state"),
      notes: get(r, "notes"),
      stage: stage ?? "name_in",
      followUpOn,
      source: get(r, "source") || (opts.defaultSource ?? "").trim().slice(0, 100),
      statusNote,
    });
  });
  return { rows, unreachable, problems, duplicatesInFile, doNotContact };
}
