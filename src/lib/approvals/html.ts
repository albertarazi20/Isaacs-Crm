import { checkClaims } from "../messaging/claims";

/**
 * The shop's approval emails are its own HTML designs with {{double_brace}} fields in them. Pure: the settings page
 * checks a design with these, the engine fills one in for a merchant, and the tests run without a database.
 */
export const APPROVAL_FIELDS = [
  "first_name",
  "business_name",
  "offer_amount",
  "offer_expiry",
  "rep_name",
  "rep_phone",
  "rep_email",
  "unsubscribe_link",
] as const;
export type ApprovalField = (typeof APPROVAL_FIELDS)[number];
export type ApprovalValues = Record<ApprovalField, string>;

export const APPROVAL_FIELD_HELP: Record<ApprovalField, string> = {
  first_name: "The merchant's first name",
  business_name: "The business name",
  offer_amount: "The approved amount, like $85,000",
  offer_expiry: "The date the funder holds it until, like Friday, November 21",
  rep_name: "The rep's name",
  rep_phone: "The rep's phone (My account)",
  rep_email: "The rep's email",
  unsubscribe_link: "The merchant's unsubscribe link (required)",
};

/** What a preview fills in, so a manager sees the design as a merchant would. */
export const SAMPLE_VALUES: ApprovalValues = {
  first_name: "Maria",
  business_name: "Sunrise Bakery",
  offer_amount: "$85,000",
  offer_expiry: "Friday, November 21",
  rep_name: "Josh Miller",
  rep_phone: "(561) 555-0142",
  rep_email: "josh@selectivecap.com",
  unsubscribe_link: "#unsubscribe",
};

const FIELD = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const KNOWN = new Set<string>(APPROVAL_FIELDS);
const isField = (s: string): s is ApprovalField => KNOWN.has(s);

/** Every {{field}} a design uses, known or not, in order of first appearance. */
export function fieldsIn(html: string): { used: ApprovalField[]; unknown: string[] } {
  const used: ApprovalField[] = [];
  const unknown: string[] = [];
  for (const m of html.matchAll(FIELD)) {
    const name = (m[1] ?? "").toLowerCase();
    if (isField(name)) {
      if (!used.includes(name)) used.push(name);
    } else if (!unknown.includes(m[1] ?? "")) unknown.push(m[1] ?? "");
  }
  return { used, unknown };
}

/**
 * Braces left over once every well-formed {{field}} is taken out: {{first name}}, {{first-name}}, {{ a.b }}, or a tag
 * inside the braces. They would go to the merchant as literal text, so a design that has them is refused. Styles and
 * comments are skipped: CSS ends its blocks in "}}" and a comment is never seen.
 */
export function strayBraces(text: string): string[] {
  const rest = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, "")
    .replace(FIELD, "");
  const out: string[] = [];
  for (const m of rest.matchAll(/\{\s*\{[^]{0,40}|\}\s*\}/g)) {
    const bit = m[0].replace(/\s+/g, " ").trim();
    if (!out.includes(bit)) out.push(bit);
  }
  return out;
}

const escapeHtml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** "(561) 555-0142" → "+15615550142" for a tel: link; other shapes keep their digits and a leading +. */
export function telDigits(phone: string): string {
  // an extension ("x12", "ext. 12") cannot be dialled from a link: keep the main line
  const main = phone.replace(/\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/i, "");
  const digits = main.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return digits;
}

export interface FilledEmail {
  subject: string;
  html: string;
  /** Fields the design uses that have no value: the email must not go until they do. */
  missing: ApprovalField[];
  /** Braces in the design that are not a field we can fill: the email must not go until the design is fixed. */
  unfilled: string[];
}

/**
 * Fill a design for one merchant. A value is escaped for HTML; a phone inside a tel: link becomes digits. A field
 * with no value is left as typed and reported, never blanked ("Congrats, ," must not go out).
 */
export function fillApprovalEmail(
  design: { subject: string; html: string },
  values: Partial<ApprovalValues>,
): FilledEmail {
  const missing: ApprovalField[] = [];
  const value = (name: ApprovalField): string | null => {
    const v = (values[name] ?? "").trim();
    if (v === "") {
      if (!missing.includes(name)) missing.push(name);
      return null;
    }
    return v;
  };
  const html = design.html
    .replace(/tel:\{\{\s*rep_phone\s*\}\}/gi, (whole) => {
      const v = value("rep_phone");
      return v === null ? whole : `tel:${telDigits(v)}`;
    })
    .replace(FIELD, (whole, raw: string) => {
      const name = raw.toLowerCase();
      if (!isField(name)) return whole;
      const v = value(name);
      return v === null ? whole : escapeHtml(v);
    });
  // the subject is plain text: values go in as they are
  const subject = design.subject.replace(FIELD, (whole, raw: string) => {
    const name = raw.toLowerCase();
    if (!isField(name)) return whole;
    return value(name) ?? whole;
  });
  // read from the design, not the result: a merchant's own name may hold braces
  const unknown = [...fieldsIn(design.subject).unknown, ...fieldsIn(design.html).unknown].map(
    (u) => `{{${u}}}`,
  );
  const unfilled = [
    ...new Set([...unknown, ...strayBraces(design.subject), ...strayBraces(design.html)]),
  ];
  return { subject: subject.replace(/\s+/g, " ").trim(), html, missing, unfilled };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "—",
  ndash: "–",
  middot: "·",
  bull: "•",
  rarr: "→",
  larr: "←",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : Number(ent.slice(1));
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      // zero-width and filler characters (preheader padding) carry nothing in plain text
      if ([0x200b, 0x200c, 0x200d, 0x2007, 0x34f, 0xfeff, 0xad].includes(code)) return "";
      return String.fromCodePoint(code);
    }
    return ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

/** The email's <title>: the designer's subject line. */
export function subjectFromHtml(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m
    ? decodeEntities(m[1] ?? "")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

/**
 * The plain-text part of the email (and what the merchant's timeline shows): the words of the design, links kept
 * where the words do not already say them, the hidden preheader and the styling dropped.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<(style|script|noscript|title)[\s\S]*?<\/\1>/gi, "")
    // the preheader: text that is in the inbox list but not on the page
    .replace(/<div[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_w, href: string, inner: string) => {
        const words = inner.replace(/<[^>]+>/g, "").trim();
        const link = decodeEntities(href);
        if (!/^https?:\/\//i.test(link)) return words;
        if (words === "" || decodeEntities(words) === link) return link;
        return `${words} (${link})`;
      },
    )
    .replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote)>/gi, "\n")
    .replace(/<(p|h[1-6]|li|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The claim checker's reasons for an approval email: every rule except "approved" (a merchant on this page is). With a
 * merchant's state, the California rate rule applies too.
 */
export function approvalClaims(text: string, ctx?: { state: string }): string[] {
  return checkClaims(text, ctx).reasons.filter((r) => !r.startsWith('Says "approved"'));
}

const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Does the email's text carry the shop's postal address? Compared loosely (case, punctuation, spacing); the street
 * line is enough ("5301 N Federal Hwy" in "Selective Capital, Inc. · 5301 N Federal Hwy, Boca Raton, FL 33487").
 */
export function hasPostalAddress(text: string, address: string): boolean {
  const street = squash(address.split(/[,\n]/)[0] ?? "");
  if (street === "") return true;
  return squash(text).includes(street);
}

/** The engine's footer inside a design: before </body>, or at the end when there is none. */
export function withFooter(html: string, footer: string): string {
  const at = html.toLowerCase().lastIndexOf("</body>");
  return at === -1 ? html + footer : `${html.slice(0, at)}${footer}${html.slice(at)}`;
}

/** The parts of a design a merchant actually sees: no comments, no <head>, no hidden blocks. */
export function visibleHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<div[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/div>/gi, "");
}

/** The hidden preview text an inbox shows next to the subject. */
export function preheaderText(html: string): string {
  const m = /<div[^>]*display\s*:\s*none[^>]*>([\s\S]*?)<\/div>/i.exec(
    html.replace(/<!--[\s\S]*?-->/g, ""),
  );
  return m
    ? decodeEntities((m[1] ?? "").replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

/** Gmail clips a message past about 102 KB and hides the rest (the unsubscribe link with it). */
export const CLIP_BYTES = 100_000;
export const MAX_HTML_BYTES = 200_000;

export interface DesignCheck {
  /** Reasons the design cannot be saved. */
  errors: string[];
  /** Things to know before it goes out; it can still be saved. */
  warnings: string[];
  used: ApprovalField[];
  /** The design with scripts taken out (email apps drop them anyway). */
  html: string;
}

/** Check a design before it is saved. */
export function checkDesign(rawHtml: string, subject: string): DesignCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const html = rawHtml.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
  if (html !== rawHtml) warnings.push("Scripts were taken out: email apps do not run them.");
  // TextEncoder, not Buffer: the settings page runs this check in the browser before it saves
  const bytes = new TextEncoder().encode(html).length;
  if (html.trim() === "") errors.push("The design is empty.");
  if (bytes > MAX_HTML_BYTES)
    errors.push(`The design is ${Math.round(bytes / 1000)} KB: keep it under 200 KB.`);
  else if (bytes > CLIP_BYTES)
    warnings.push(
      `The design is ${Math.round(bytes / 1000)} KB: Gmail cuts off emails past about 100 KB, unsubscribe link included.`,
    );
  if (subject.trim() === "") errors.push("Give it a subject line.");
  const inBody = fieldsIn(html);
  const inSubject = fieldsIn(subject);
  const unknown = [...new Set([...inBody.unknown, ...inSubject.unknown])];
  if (unknown.length > 0)
    errors.push(
      `Not a field we can fill: ${unknown.map((u) => `{{${u}}}`).join(", ")}. The fields are ${APPROVAL_FIELDS.map((f) => `{{${f}}}`).join(", ")}.`,
    );
  const stray = [...new Set([...strayBraces(html), ...strayBraces(subject)])];
  if (stray.length > 0)
    errors.push(
      `Broken field: ${stray.map((b) => `"${b}"`).join(", ")}. A field is written {{name}} with the name exactly as listed, nothing else inside the braces.`,
    );
  // the link has to be where the merchant can click it: not in a comment, the <head> or a hidden block
  if (html.trim() !== "" && !fieldsIn(visibleHtml(html)).used.includes("unsubscribe_link"))
    errors.push(
      "Put {{unsubscribe_link}} in the design: every automated email needs a working unsubscribe link.",
    );
  // the claim rules for automated mail hold here too, except "approved": these merchants are approved
  // the inbox's preview line counts too
  for (const r of approvalClaims(`${subject}\n${preheaderText(html)}\n${htmlToText(html)}`))
    errors.push(r);
  const used = [...new Set([...inBody.used, ...inSubject.used])];
  return { errors, warnings, used, html };
}
