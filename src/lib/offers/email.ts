/** The email that carries an offer: a designed HTML part and a plain-text part. Pure: everything it shows is passed in. */
import { formatMoney } from "../money";
import { exactMoney, FREQUENCY_WORDS, factorWords, termWords, type Frequency } from "./terms";

export interface OfferEmailInput {
  firstName: string;
  businessName: string;
  shopName: string;
  fundedCents: number;
  paymentCents: number;
  /** The last payment when it carries the leftover cents; omitted or equal when it does not. */
  finalPaymentCents?: number;
  payments: number;
  frequency: Frequency;
  factorRate: number;
  /** "Thursday, November 19 at 4:32 PM", in the merchant's zone. */
  validThrough: string;
  url: string;
  repName: string;
  repPhone: string;
  repEmail: string;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export function offerEmail(o: OfferEmailInput): { subject: string; text: string; html: string } {
  const amount = formatMoney(o.fundedCents);
  const payment = exactMoney(o.paymentCents);
  const final =
    o.finalPaymentCents !== undefined && o.finalPaymentCents !== o.paymentCents
      ? exactMoney(o.finalPaymentCents)
      : null;
  const freq = FREQUENCY_WORDS[o.frequency];
  const hi = o.firstName.trim() ? `Hi ${o.firstName.trim()},` : "Hi,";
  const shop = o.shopName.trim() || "Selective Capital";
  const subject = `Your funding offer for ${o.businessName.trim() || "your business"} is ready`;
  const sign = [o.repName, shop, o.repPhone, o.repEmail].filter((x) => x.trim()).join("\n");
  const text = [
    hi,
    "",
    `Following up on our call: your funding offer is ready to review.`,
    "",
    `Funding: ${amount}`,
    `${freq.payment}: ${payment} (${o.payments} payments${final ? `, final payment ${final}` : ""}, ${termWords(o.frequency, o.payments)})`,
    `Factor rate: ${factorWords(o.factorRate)}`,
    `Valid through: ${o.validThrough}`,
    "",
    `See the full offer and accept it here: ${o.url}`,
    "",
    "Any questions, reply to this email or give me a call.",
    "",
    sign,
  ].join("\n");

  const row = (label: string, value: string) =>
    `<tr><td style="padding:10px 0;border-top:1px solid #ece9e2;color:#6b7280;font-size:14px">${esc(label)}</td>` +
    `<td style="padding:10px 0;border-top:1px solid #ece9e2;color:#111827;font-size:14px;font-weight:600;text-align:right">${esc(value)}</td></tr>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(`Your ${amount} funding offer is ready. Valid through ${o.validThrough}.`)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ef;padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 18px;font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#7c3aed;font-weight:700">${esc(shop)}</td></tr>
<tr><td style="background:#ffffff;border-radius:20px;padding:28px 28px 8px;border:1px solid #ece9e2">
<p style="margin:0 0 6px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#7c3aed;font-weight:600">Prepared for ${esc(o.businessName)}</p>
<h1 style="margin:0 0 14px;font-size:26px;line-height:1.2;color:#16121f">Your funding offer is ready</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151">${esc(hi)} following up on our call, here are the terms we put together for you.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#16121f;border-radius:16px">
<tr><td style="padding:22px 22px 20px">
<p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c4b5fd;font-weight:600">Your funding offer</p>
<p style="margin:6px 0 0;font-size:36px;line-height:1.1;font-weight:700;color:#ffffff">${esc(amount)}</p>
<p style="margin:8px 0 0;font-size:14px;color:#cbd5e1">${esc(`${freq.payment}: ${payment} · ${o.payments} payments`)}</p>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px">
${row("Factor rate", factorWords(o.factorRate))}
${final ? row("Final payment", final) : ""}
${row("Term", termWords(o.frequency, o.payments))}
${row("Valid through", o.validThrough)}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 22px"><tr><td align="center">
<a href="${esc(o.url)}" style="display:inline-block;background:#7c3aed;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:999px">View and accept your offer</a>
</td></tr></table>
<p style="margin:0 0 22px;font-size:13px;line-height:1.6;color:#6b7280">Any questions, reply to this email or give me a call.</p>
</td></tr>
<tr><td style="padding:18px 6px 0;font-size:13px;line-height:1.6;color:#4b5563">${sign
    .split("\n")
    .map((l, i) => (i === 0 ? `<strong style="color:#111827">${esc(l)}</strong>` : esc(l)))
    .join("<br>")}</td></tr>
<tr><td style="padding:14px 6px 0;font-size:11px;line-height:1.6;color:#9ca3af">This is a summary of an offer, not a contract. Final terms, and any disclosures your state requires, come with the funding agreement.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
