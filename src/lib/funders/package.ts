import { formatUS } from "../mca/phone";
import { STIP_LABELS } from "../mca/stips";
import type { ClientCard, PositionRow, StipRow } from "../data/types";
import { formatMoney, formatMoneyCompact } from "../money";
import { ordinal } from "./format";

export interface PackageInput {
  card: ClientCard;
  positions: readonly PositionRow[];
  stips: readonly StipRow[];
  senderName: string;
  /** The funder's contact, if known, for the greeting. */
  funderContact?: string;
  /** Expiring, watermarked links to the file's documents, minted for this lender (S2-7). */
  documents?: readonly { label: string; url: string }[];
  /** How long the links are good for, in words ("7 days"). */
  linksGoodFor?: string;
}

export interface SubmissionPackage {
  subject: string;
  body: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (period: string) => {
  const [y, m] = period.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
};

/** Plain text: it goes into an email. Only business facts — never internal notes, never anything we don't store. */
export function buildSubmissionPackage(i: PackageInput): SubmissionPackage {
  const c = i.card;
  const wanted = c.wanted_amount_cents ? formatMoneyCompact(c.wanted_amount_cents) : null;
  const place = [c.industry, c.state]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
  const nextPosition = i.positions.length + 1;

  const subject = oneLine(
    `New submission: ${c.business_name}${place ? ` (${place})` : ""}${wanted ? ` — ${wanted} requested` : ""}`,
  );

  const lines: string[] = [];
  lines.push(`Hi ${i.funderContact?.trim() || "team"},`, "", "New deal for your review:", "");
  lines.push(`Business: ${c.business_name}${c.dba ? ` (DBA ${c.dba})` : ""}`);
  const contact = [c.contact_name, c.phone ? formatUS(c.phone) : "", c.email]
    .filter(Boolean)
    .join(" · ");
  if (contact) lines.push(`Owner / contact: ${contact}`);
  if (c.industry) lines.push(`Industry: ${c.industry}`);
  if (c.state) lines.push(`State: ${c.state}`);
  if (c.time_in_business_months !== null)
    lines.push(`Time in business: ${c.time_in_business_months} months`);
  if (c.monthly_revenue_cents !== null)
    lines.push(`Monthly revenue: ${formatMoney(c.monthly_revenue_cents)}`);
  lines.push(
    `Requested: ${c.wanted_amount_cents ? formatMoney(c.wanted_amount_cents) : "to be discussed"}${c.wanted_terms ? ` (${c.wanted_terms})` : ""}`,
  );
  lines.push(`Position: would be ${ordinal(nextPosition)}`);

  if (i.positions.length > 0) {
    lines.push("", "Existing advances:");
    for (const p of [...i.positions].sort((a, b) => a.position_no - b.position_no).slice(0, 6)) {
      const remit =
        p.payment_cents && p.frequency
          ? `, remitting ${formatMoney(p.payment_cents)} ${p.frequency}`
          : "";
      lines.push(
        `  ${ordinal(p.position_no)}: ${p.funder_name || "unknown funder"} — funded ${formatMoney(p.funded_amount_cents)}, balance ${formatMoney(p.balance_cents)}${remit}`,
      );
    }
  } else lines.push("", "No other advances.");

  const statements = i.stips.filter((s) => s.kind === "bank_statement" && s.period);
  if (statements.length > 0) {
    const have = statements.filter((s) => s.received_at).map((s) => monthLabel(s.period as string));
    const missing = statements
      .filter((s) => s.required && !s.received_at)
      .map((s) => monthLabel(s.period as string));
    lines.push(
      "",
      `Bank statements: ${have.length ? have.join(", ") : "none yet"}${missing.length ? ` (still missing: ${missing.join(", ")})` : ""}`,
    );
  }
  const otherDocs = i.stips.filter((s) => s.kind !== "bank_statement" && s.required);
  if (otherDocs.length > 0) {
    const ready = otherDocs.filter((s) => s.received_at).map((s) => STIP_LABELS[s.kind]);
    const waiting = otherDocs.filter((s) => !s.received_at).map((s) => STIP_LABELS[s.kind]);
    if (ready.length) lines.push(`Documents attached: ${ready.join(", ")}`);
    if (waiting.length) lines.push(`Still collecting: ${waiting.join(", ")}`);
  }
  if (i.documents && i.documents.length > 0) {
    lines.push("", "Documents:");
    for (const d of i.documents) lines.push(`  ${d.label}: ${d.url}`);
    lines.push(
      `Each link is good for ${i.linksGoodFor ?? "7 days"} and the copies carry your name.`,
    );
  }
  lines.push("", "Let me know what you need.", "", `Thanks,`, i.senderName.trim() || "");
  return { subject, body: lines.join("\n") };
}

const oneLine = (s: string): string =>
  s
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * A Gmail compose window with everything filled in. It needs no sign-in on our side and no API: it is just a
 * link, and the broker attaches the statements himself. Gmail refuses very long links, so the body is cut.
 */
export function gmailComposeUrl(to: string, pkg: SubmissionPackage): string {
  const body = pkg.body.length > 3500 ? `${pkg.body.slice(0, 3500)}\n…` : pkg.body;
  const q = new URLSearchParams({ view: "cm", fs: "1", to: to.trim(), su: pkg.subject, body });
  return `https://mail.google.com/mail/?${q.toString().replaceAll("+", "%20")}`;
}
