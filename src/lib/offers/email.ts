/**
 * The email that carries an offer. It does not show the terms: it tells the merchant their offer is ready and how
 * long it stands, and links to their private offer page, where the terms are (opening it is what the rep is told
 * about). In the brand's colours, with a serif for the name; a plain-text part says the same.
 */
import type { Frequency } from "./terms";

export interface OfferEmailInput {
  number: string;
  firstName: string;
  businessName: string;
  shopName: string;
  /** The terms are kept for the CRM's own record of what was offered; the email itself does not show them. */
  fundedCents: number;
  paymentCents: number;
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
  /** The light-text wordmark (an absolute address: an email cannot load a relative one). */
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
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const INK = "#14101f";
const VIOLET = "#6d28d9";
const FUCHSIA = "#c026d3";
const MUTED = "#5f6370";
const RULE = "#ebe7f3";
/** The brand gradient, with a solid violet for clients that draw no gradients (Outlook). */
const GRADIENT = `background-color:${VIOLET};background-image:linear-gradient(120deg,#4f46e5 0%,${VIOLET} 45%,${FUCHSIA} 100%)`;

export function offerEmail(o: OfferEmailInput): { subject: string; text: string; html: string } {
  const hi = o.firstName.trim() ? `Hi ${o.firstName.trim()},` : "Hi,";
  const shop = o.shopName.trim() || "Selective Capital";
  const business = o.businessName.trim() || "your business";
  const subject = `Your funding offer for ${business} is ready`;
  const sign = [o.repName, shop, o.repPhone, o.repEmail].filter((x) => x.trim());

  const text = [
    hi,
    "",
    `Your custom funding offer for ${business} is ready (offer ${o.number}).`,
    "For your privacy the terms are on your own offer page, along with how to accept.",
    "",
    `View your offer: ${o.url}`,
    "",
    `The offer stands until ${o.validThrough}.`,
    ...(o.message.trim() ? ["", o.message.trim()] : []),
    "",
    "Any questions, reply to this email or give me a call.",
    "",
    sign.join("\n"),
    "",
    "This is an offer summary, not a contract. Final terms, and any disclosures your state requires, come with the funding agreement.",
  ].join("\n");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&amp;display=swap" rel="stylesheet"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f3fb;color:${INK}">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;visibility:hidden">${esc(`${business}: your custom funding offer is ready. It stands until ${o.validThrough}.`)}${"&zwnj;&nbsp;".repeat(60)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3fb;padding:32px 12px">
<tr><td align="center">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">

<tr><td bgcolor="${VIOLET}" style="${GRADIENT};border-radius:18px 18px 0 0;padding:22px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td valign="middle"><img src="${esc(o.logoUrl)}" alt="${esc(shop)}" width="150" style="display:block;width:150px;height:auto;border:0;color:#ffffff;font:700 14px ${SANS}"></td>
<td valign="middle" align="right" style="font:700 9.5px ${SANS};letter-spacing:2.2px;text-transform:uppercase;color:#f5e8ff">Private funding offer<br><span style="font:400 12px ${SANS};letter-spacing:0.5px;text-transform:none;color:#f0dcff">No. ${esc(o.number)}</span></td>
</tr></table>
</td></tr>

<tr><td style="background:#ffffff;border:1px solid ${RULE};border-top:0;border-radius:0 0 18px 18px;padding:32px 28px 30px">
<p style="margin:0;font:700 11px ${SANS};letter-spacing:2.4px;text-transform:uppercase;color:${VIOLET}">Prepared for</p>
<h1 style="margin:8px 0 0;font:400 32px/1.15 ${SERIF};color:${INK}">${esc(business)}</h1>
<p style="margin:18px 0 0;font:16px/1.65 ${SANS};color:#3d4150">${esc(hi)} your custom funding offer is ready. For your privacy, the terms are on your own offer page, along with how to accept.</p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:26px"><tr><td bgcolor="${VIOLET}" style="${GRADIENT};border-radius:16px;padding:2px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px"><tr><td align="center" style="padding:28px 20px 26px">
<p style="margin:0;font:700 10.5px ${SANS};letter-spacing:2.6px;text-transform:uppercase;color:${FUCHSIA}">Your offer is waiting</p>
<p style="margin:12px 0 0;font:400 24px/1.3 ${SERIF};color:${INK}">Open your offer to see the terms</p>
<p style="margin:16px 0 0;font:600 18px ${SANS}"><a href="${esc(o.url)}" style="color:${VIOLET};text-decoration:underline;text-underline-offset:4px">View your offer &rarr;</a></p>
<p style="margin:18px 0 0;font:13px/1.5 ${SANS};color:${MUTED}">It stands until <strong style="color:${INK}">${esc(o.validThrough)}</strong></p>
</td></tr></table>
</td></tr></table>

${
  o.message.trim()
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px"><tr><td style="border-left:3px solid ${FUCHSIA};padding:4px 0 4px 16px;font:italic 16px/1.6 ${SERIF};color:#2b2f3c">&ldquo;${esc(o.message.trim())}&rdquo;</td></tr></table>`
    : ""
}

<p style="margin:26px 0 0;font:14px/1.6 ${SANS};color:#3d4150">Any questions, reply to this email or give me a call.</p>
<p style="margin:10px 0 0;font:12.5px/1.6 ${SANS};color:${MUTED}">If the link doesn't open, paste this into your browser:<br><a href="${esc(o.url)}" style="color:${VIOLET};word-break:break-all">${esc(o.url)}</a></p>
</td></tr>

<tr><td style="padding:22px 8px 0">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="border-left:3px solid ${VIOLET};padding:2px 0 2px 14px;font:14px/1.65 ${SANS};color:#3d4150">${sign
    .map((l, i) =>
      i === 0 ? `<span style="font:400 18px ${SERIF};color:${INK}">${esc(l)}</span>` : esc(l),
    )
    .join("<br>")}</td>
</tr></table>
</td></tr>
<tr><td style="padding:18px 8px 0;font:11.5px/1.6 ${SANS};color:${MUTED}">This is an offer summary, not a contract. Final terms, and any disclosures your state requires, come with the funding agreement. Offer ${esc(o.number)}.</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
  return { subject, text, html };
}
