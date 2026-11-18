/** The email a rep gets when a merchant accepts: the terms, who accepted and when, the documents attached. Pure. */
import { exactMoney, FREQUENCY_WORDS, factorWords, termWords, type Frequency } from "./terms";

export interface AcceptedNoticeInput {
  number: string;
  businessName: string;
  contactName: string;
  fundedCents: number;
  paymentCents: number;
  finalPaymentCents: number;
  paybackCents: number;
  payments: number;
  frequency: Frequency;
  factorRate: number;
  acceptedAt: string;
  acceptedName: string;
  acceptedEmail: string;
  acceptedIp: string;
  /** The documents attached, and any that were too big to attach. */
  attached: readonly string[];
  notAttached: readonly string[];
  /** Documents that could not be read from storage: open them in the CRM. */
  unreadable?: readonly string[];
  merchantUrl: string;
  /** "Thursday, November 19 at 4:32 PM EST", in the rep's zone. */
  acceptedWords: string;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const SERIF = "Georgia,'Times New Roman',Times,serif";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export function acceptedNotice(n: AcceptedNoticeInput): {
  subject: string;
  text: string;
  html: string;
} {
  const freq = FREQUENCY_WORDS[n.frequency];
  const subject = `Accepted: ${n.businessName} took the ${exactMoney(n.fundedCents)} offer (${n.number})`;
  const terms: [string, string][] = [
    ["Funded amount", exactMoney(n.fundedCents)],
    [freq.payment, exactMoney(n.paymentCents)],
    ...(n.finalPaymentCents !== n.paymentCents
      ? ([["Final payment", exactMoney(n.finalPaymentCents)]] as [string, string][])
      : []),
    ["Payments", `${n.payments} (${termWords(n.frequency, n.payments)})`],
    ["Factor rate", factorWords(n.factorRate)],
    ["Total payback", exactMoney(n.paybackCents)],
  ];
  const who: [string, string][] = [
    ["Accepted", n.acceptedWords],
    ["Name given", n.acceptedName || "(left blank)"],
    ["Email given", n.acceptedEmail || "(left blank)"],
    ["From address", n.acceptedIp || "(unknown)"],
  ];
  const text = [
    `${n.businessName} accepted offer ${n.number}.`,
    "",
    ...terms.map(([k, v]) => `${k}: ${v}`),
    "",
    ...who.map(([k, v]) => `${k}: ${v}`),
    "",
    n.attached.length ? `Attached: ${n.attached.join(", ")}` : "No documents attached.",
    ...(n.notAttached.length
      ? [`Too big to attach (open them in the CRM): ${n.notAttached.join(", ")}`]
      : []),
    ...(n.unreadable?.length
      ? [`Could not be attached (open them in the CRM): ${n.unreadable.join(", ")}`]
      : []),
    "",
    `Open the merchant: ${n.merchantUrl}`,
  ].join("\n");

  const rows = (list: [string, string][]) =>
    list
      .map(
        ([k, v]) =>
          `<tr><td style="padding:9px 0;border-top:1px solid #e7e4dc;font:14px ${SANS};color:#6b6f7b">${esc(k)}</td>` +
          `<td style="padding:9px 0;border-top:1px solid #e7e4dc;font:600 14px ${SANS};color:#14161f;text-align:right">${esc(v)}</td></tr>`,
      )
      .join("");
  const docs = [
    ...n.attached.map(
      (d) =>
        `<li style="margin:0 0 4px">${esc(d)} <span style="color:#15803d">· attached</span></li>`,
    ),
    ...n.notAttached.map(
      (d) =>
        `<li style="margin:0 0 4px">${esc(d)} <span style="color:#b45309">· too big to attach, open it in the CRM</span></li>`,
    ),
    ...(n.unreadable ?? []).map(
      (d) =>
        `<li style="margin:0 0 4px">${esc(d)} <span style="color:#b45309">· could not be attached, open it in the CRM</span></li>`,
    ),
  ].join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f2ec">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ec;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e7e4dc;border-radius:14px;overflow:hidden">
<tr><td style="background:#0e1424;padding:18px 26px">
<p style="margin:0;font:700 11px ${SANS};letter-spacing:3px;text-transform:uppercase;color:#c8cbe0">Offer accepted · ${esc(n.number)}</p>
</td></tr>
<tr><td style="padding:24px 26px 6px">
<h1 style="margin:0;font:400 28px/1.2 ${SERIF};color:#0e1424">${esc(n.businessName)} accepted their offer</h1>
<p style="margin:10px 0 0;font:15px/1.6 ${SANS};color:#3d4150">${esc(n.contactName || "The merchant")} accepted ${esc(exactMoney(n.fundedCents))} and sent the documents it asked for.${n.attached.length ? " They're attached." : " Open them in the CRM."}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px">${rows(terms)}</table>
<p style="margin:22px 0 4px;font:700 11px ${SANS};letter-spacing:2px;text-transform:uppercase;color:#6b6f7b">Who accepted</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows(who)}</table>
<p style="margin:22px 0 6px;font:700 11px ${SANS};letter-spacing:2px;text-transform:uppercase;color:#6b6f7b">Documents</p>
<ul style="margin:0 0 4px;padding-left:18px;font:14px/1.6 ${SANS};color:#14161f">${docs || "<li>None</li>"}</ul>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 26px"><tr><td style="background:#0e1424;border-radius:10px">
<a href="${esc(n.merchantUrl)}" style="display:inline-block;padding:13px 22px;font:600 14px ${SANS};color:#ffffff;text-decoration:none">Open ${esc(n.businessName)} in the CRM</a>
</td></tr></table>
</td></tr></table>
</td></tr></table></body></html>`;
  return { subject, text, html };
}
