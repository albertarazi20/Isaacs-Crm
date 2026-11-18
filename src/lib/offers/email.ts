/**
 * The email that carries an offer: a designed HTML part that reads like a term sheet (a serif face for the figures,
 * an ink header with the offer's number, hairline rules) and a plain-text part. Pure: everything it shows is passed in.
 * Apple Mail loads the page's own face (Source Serif 4); everywhere else the headings fall back to Georgia and the
 * figures to Times, whose numerals sit on the line (Georgia's dip below it, which reads bookish, not financial).
 */
import {
  FREQUENCY_WORDS,
  factorWords,
  paymentsWords,
  sheetMoney,
  termWords,
  type Frequency,
} from "./terms";

export interface OfferEmailInput {
  number: string;
  firstName: string;
  businessName: string;
  shopName: string;
  fundedCents: number;
  paymentCents: number;
  /** The last payment when it carries the leftover cents; omitted or equal when it does not. */
  finalPaymentCents?: number;
  paybackCents: number;
  payments: number;
  frequency: Frequency;
  factorRate: number;
  /** "Thursday, November 19 at 4:32 PM EST", in the merchant's zone. */
  validThrough: string;
  /** The rep's own line, shown in the email as on the page. */
  message: string;
  url: string;
  /** The wordmark on the site (an absolute address: an email cannot load a relative one). */
  logoUrl: string;
  repName: string;
  repPhone: string;
  repEmail: string;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const SERIF = "'Source Serif 4',Georgia,'Times New Roman',serif";
const NUM = "'Source Serif 4','Times New Roman',Times,serif";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const INK = "#0e1424";
const RULE = "#e5e2d9";
const MUTED = "#5f6370";
const ACCENT = "#6d28d9";

export function offerEmail(o: OfferEmailInput): { subject: string; text: string; html: string } {
  const amount = sheetMoney(o.fundedCents);
  const payment = sheetMoney(o.paymentCents);
  const freq = FREQUENCY_WORDS[o.frequency];
  const final =
    o.finalPaymentCents !== undefined && o.finalPaymentCents !== o.paymentCents
      ? sheetMoney(o.finalPaymentCents)
      : null;
  const term = termWords(o.frequency, o.payments);
  const Term = term.charAt(0).toUpperCase() + term.slice(1);
  const hi = o.firstName.trim() ? `Hi ${o.firstName.trim()},` : "Hi,";
  const shop = o.shopName.trim() || "Selective Capital";
  const business = o.businessName.trim() || "your business";
  const subject = `Your funding offer for ${business} is ready`;
  const sign = [o.repName, shop, o.repPhone, o.repEmail].filter((x) => x.trim());

  const text = [
    hi,
    "",
    `Your funding offer for ${business} is ready to review (offer ${o.number}).`,
    "",
    `Funding offered: ${amount}`,
    `${freq.payment}: ${payment}`,
    `Payments: ${paymentsWords(o.payments, o.frequency)}${final ? ` (final payment ${final})` : ""}, ${term}`,
    `Factor rate: ${factorWords(o.factorRate)}`,
    `Total payback: ${sheetMoney(o.paybackCents)}`,
    `Valid through: ${o.validThrough}`,
    ...(o.message.trim() ? ["", o.message.trim()] : []),
    "",
    `Review and accept your offer: ${o.url}`,
    "",
    "Any questions, reply to this email or give me a call.",
    "",
    sign.join("\n"),
    "",
    "This is a summary of an offer, not a contract. Final terms, and any disclosures your state requires, come with the funding agreement.",
  ].join("\n");

  const row = (label: string, value: string, opts: { strong?: boolean; wrap?: boolean } = {}) =>
    `<tr><td valign="top" style="padding:12px 12px 12px 0;border-top:1px solid ${RULE};font:14px ${SANS};color:${MUTED}">${esc(label)}</td>` +
    `<td align="right" style="padding:12px 0;border-top:1px solid ${RULE};font:${opts.strong ? "700" : "400"} 17px ${NUM};color:${INK};text-align:right;${opts.wrap ? "" : "white-space:nowrap;"}">${esc(value)}</td></tr>`;
  const stat = (label: string, value: string, border: boolean, nowrap: boolean) =>
    `<td width="33%" valign="top" style="padding:14px 10px 4px;${border ? `border-left:1px solid ${RULE};` : ""}">` +
    `<p style="margin:0;font:700 10px ${SANS};letter-spacing:1.4px;text-transform:uppercase;color:${MUTED}">${esc(label)}</p>` +
    `<p style="margin:6px 0 0;font:400 19px ${NUM};color:${INK};${nowrap ? "white-space:nowrap;" : ""}">${esc(value)}</p></td>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&amp;display=swap" rel="stylesheet"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f2ec;color:${INK}">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;visibility:hidden">${esc(`${amount} offered to ${business}, valid through ${o.validThrough}.`)}${"&zwnj;&nbsp;".repeat(60)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ec;padding:32px 12px">
<tr><td align="center">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">

<tr><td style="background:${INK};border-radius:16px 16px 0 0;padding:20px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td valign="middle"><img src="${esc(o.logoUrl)}" alt="${esc(shop)}" width="150" style="display:block;width:150px;height:auto;border:0;color:#ffffff;font:700 14px ${SANS}"></td>
<td valign="middle" align="right" style="font:700 9.5px ${SANS};letter-spacing:2.2px;text-transform:uppercase;color:#c8cbe0">Private funding offer<br><span style="font:400 12px ${SANS};letter-spacing:0.5px;text-transform:none;color:#a9aecb">No. ${esc(o.number)}</span></td>
</tr></table>
</td></tr>

<tr><td style="background:#ffffff;border:1px solid ${RULE};border-top:0;border-radius:0 0 16px 16px;padding:30px 28px 8px">
<p style="margin:0;font:700 11px ${SANS};letter-spacing:2.4px;text-transform:uppercase;color:${ACCENT}">Prepared for</p>
<h1 style="margin:8px 0 0;font:400 30px/1.15 ${SERIF};color:${INK}">${esc(business)}</h1>
<p style="margin:16px 0 0;font:15px/1.65 ${SANS};color:#3d4150">${esc(hi)} your funding offer is ready to review. The terms are below; the button takes you to your offer page, where you can accept it and send the documents it needs.</p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border:1px solid #d6d2c6;border-radius:14px">
<tr><td style="padding:3px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${RULE};border-radius:11px">
<tr><td colspan="3" align="center" style="padding:26px 16px 8px">
<p style="margin:0;font:700 10.5px ${SANS};letter-spacing:2.6px;text-transform:uppercase;color:${MUTED}">Funding offered</p>
<p style="margin:10px 0 0;font:400 44px/1.05 ${NUM};color:${INK}">${esc(amount)}</p>
</td></tr>
<tr><td colspan="3" style="padding:18px 16px 0;font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td colspan="3" style="border-top:1px solid ${RULE};font-size:0;line-height:0">&nbsp;</td></tr>
<tr>${stat(freq.payment, payment, false, true)}${stat("Payments", String(o.payments), true, true)}${stat("Term", Term, true, false)}</tr>
<tr><td colspan="3" style="height:14px;font-size:0;line-height:0">&nbsp;</td></tr>
</table></td></tr></table>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px">
${row("Factor rate", factorWords(o.factorRate))}
${row("Total payback", sheetMoney(o.paybackCents))}
${final ? row("Final payment", final) : ""}
${row("Valid through", o.validThrough, { strong: true, wrap: true })}
</table>

${
  o.message.trim()
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px"><tr><td style="border-left:3px solid ${ACCENT};padding:4px 0 4px 16px;font:italic 16px/1.6 ${SERIF};color:#2b2f3c">&ldquo;${esc(o.message.trim())}&rdquo;</td></tr></table>`
    : ""
}

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 10px"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="${INK}" style="background:${INK};border-radius:12px;padding:16px 30px">
<a href="${esc(o.url)}" style="display:block;font:600 15px ${SANS};letter-spacing:0.3px;color:#ffffff;text-decoration:none">Review and accept your offer &rarr;</a>
</td></tr></table>
</td></tr></table>
<p style="margin:0 0 26px;text-align:center;font:12.5px ${SANS};color:${MUTED}">Valid through ${esc(o.validThrough)}</p>
</td></tr>

<tr><td style="padding:22px 8px 0">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="border-left:2px solid ${INK};padding:2px 0 2px 14px;font:14px/1.65 ${SANS};color:#3d4150">${sign
    .map((l, i) =>
      i === 0 ? `<span style="font:400 17px ${SERIF};color:${INK}">${esc(l)}</span>` : esc(l),
    )
    .join("<br>")}</td>
</tr></table>
</td></tr>
<tr><td style="padding:18px 8px 0;font:11.5px/1.6 ${SANS};color:#5f6370">This is a summary of an offer, not a contract. Final terms, and any disclosures your state requires, come with the funding agreement. Offer ${esc(o.number)}.</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
  return { subject, text, html };
}
