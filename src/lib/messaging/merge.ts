import { firstName, greetingName, tidy, factorText } from "../mca/templates";
import { formatMoney } from "../money";

/**
 * Merge fields: {first_name}, {business}… inside a saved snippet. A field with nothing to put in it is NEVER
 * silently blanked — it stays visible as typed and is reported, so "Hey , here's the link: " can't go out.
 */
export const MERGE_FIELDS = [
  "first_name",
  "business",
  "sender",
  "application_link",
  "amount_wanted",
  "funder_best_offer",
  "upload_link",
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

export const MERGE_FIELD_HELP: Record<MergeField, string> = {
  first_name: "The merchant's first name (Dr. Weiss stays Dr. Weiss)",
  business: "The business name",
  sender: "Your first name",
  application_link: "Your application link from Settings",
  amount_wanted: "What they asked for, like $60,000",
  funder_best_offer: "The best competing offer on file, like $50,000 at 1.42 from Rival Capital",
  upload_link: "This merchant's personal link to upload statements and documents",
};

export type MergeValues = Partial<Record<MergeField, string | null | undefined>>;

export interface MergeResult {
  text: string;
  /** Known fields that had no value, in order of first appearance. They are still in `text` as typed. */
  missing: MergeField[];
  /** Names that are not merge fields at all (typos like {firstname}). Still in `text` as typed. */
  unknown: string[];
}

const TOKEN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const KNOWN = new Set<string>(MERGE_FIELDS);
export const isMergeField = (name: string): name is MergeField => KNOWN.has(name.toLowerCase());

/** Braces in a value would look like a field to the next pass; they never belong in a name or a link anyway. */
const clean = (v: string | null | undefined): string => (v ?? "").replace(/[{}]/g, "").trim();

/** Fill the fields we can. One pass: a value that happens to contain "{business}" is not expanded again. */
export function resolveMergeFields(template: string, values: MergeValues): MergeResult {
  const missing: MergeField[] = [];
  const unknown: string[] = [];
  const text = template.replace(TOKEN, (whole, raw: string) => {
    const name = raw.toLowerCase();
    if (!isMergeField(name)) {
      if (!unknown.includes(raw)) unknown.push(raw);
      return whole;
    }
    const value = clean(values[name]);
    if (value === "") {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return value;
  });
  return { text, missing, unknown };
}

/** Every {field} still sitting in a message — what must be dealt with before it is sent. */
export function leftoverFields(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const name = m[0];
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Plain words for the warning under a message. */
export function describeLeftovers(
  text: string,
  have: { applicationLinkSet?: boolean } = {},
): string | null {
  const left = leftoverFields(text);
  if (left.length === 0) return null;
  const list = left.join(", ");
  const parts: string[] = [`This message still has ${list} in it.`];
  if (left.includes("{application_link}") && have.applicationLinkSet === false) {
    parts.push("Add your application link in Settings, or take it out.");
  } else {
    parts.push("Fill it in or take it out before you send.");
  }
  return parts.join(" ");
}

export interface OfferSummary {
  funderName: string;
  amountCents: number | null;
  factorRate: number | null;
  termDays: number | null;
  offeredOn: string | null;
  won: boolean;
}

/** The offer a merchant would call best: the most money, then the lowest factor rate. Offers with no amount come last. */
export function pickBestOffer<T extends { amountCents: number | null; factorRate: number | null }>(
  offers: readonly T[],
): T | null {
  let best: T | null = null;
  for (const o of offers) {
    if (best === null) {
      best = o;
      continue;
    }
    const a = o.amountCents ?? -1;
    const b = best.amountCents ?? -1;
    if (a > b || (a === b && (o.factorRate ?? Infinity) < (best.factorRate ?? Infinity))) best = o;
  }
  return best;
}

/** "$50,000 at 1.42 from Rival Capital". Only says what was logged. */
export function describeOffer(o: OfferSummary): string {
  const money = o.amountCents ? formatMoney(o.amountCents) : "";
  const rate = o.factorRate ? factorText(o.factorRate) : "";
  if (money && rate) return `${money} at ${rate} from ${o.funderName}`;
  if (money) return `${money} from ${o.funderName}`;
  if (rate) return `${rate} from ${o.funderName}`;
  return `an offer from ${o.funderName}`;
}

export interface MergeContext {
  contactName: string;
  businessName: string;
  senderName: string;
  applicationLink: string;
  wantedAmountCents: number | null;
  bestOffer: OfferSummary | null;
  uploadLink?: string;
}

/** The values for one merchant. Empty string means "we don't know" and is reported, not blanked. */
export function mergeValues(c: MergeContext): Record<MergeField, string> {
  return {
    first_name: greetingName(c.contactName),
    business: c.businessName.trim(),
    sender: tidy(firstName(c.senderName)) || "Isaac",
    application_link: c.applicationLink.trim(),
    amount_wanted: c.wantedAmountCents ? formatMoney(c.wantedAmountCents) : "",
    funder_best_offer: c.bestOffer ? describeOffer(c.bestOffer) : "",
    upload_link: (c.uploadLink ?? "").trim(),
  };
}

/** A first line of "Subject: …" in an email snippet sets the subject; the rest is the body. */
export function splitSubject(body: string): { subject: string | null; body: string } {
  const m = /^\s*subject:[ \t]*([^\r\n]*)(?:\r?\n)+/i.exec(body);
  if (!m) return { subject: null, body };
  const subject = (m[1] ?? "").trim();
  return { subject: subject === "" ? null : subject, body: body.slice(m[0].length) };
}

/** What gets appended to an email: Isaac's signature, or a plain "Thanks, Name" until he writes one. */
export function effectiveSignature(signature: string, senderFullName: string): string {
  const sig = signature.trim();
  if (sig) return sig;
  return `Thanks,\n${tidy(senderFullName.trim()) || "Isaac"}`;
}

/** Body + signature, once. If the signature is already at the end (pasted in), it isn't doubled. */
export function appendSignature(body: string, signature: string): string {
  const b = body.replace(/\s+$/, "");
  const s = signature.trim();
  if (!s) return b;
  if (b.endsWith(s)) return b;
  return b ? `${b}\n\n${s}` : s;
}
