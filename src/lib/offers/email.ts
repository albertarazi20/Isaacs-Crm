/**
 * The email that carries an offer: the first design the owner picked (a white card, the dark offer box, the terms
 * in rows, a violet button), polished: the real logo, Inter with tabular figures (Helvetica/Arial where a mail app
 * will not load a web font), and the brand glow in the offer box. A plain-text part says the same.
 */
import { formatMoney } from "../money";
import { exactMoney, FREQUENCY_WORDS, factorWords, termWords, type Frequency } from "./terms";

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
  /** The rep's own line, shown under the terms. */
  message: string;
  url: string;
  /** The dark-text wordmark for the white page (an absolute address: an email cannot load a relative one). */
  logoUrl: string;
  /** The brand glow behind the offer box (absolute); the box is near-black where images are off. */
  heroUrl: string;
  repName: string;
  repPhone: string;
  repEmail: string;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const FONT = "Inter,'Helvetica Neue',Helvetica,Arial,sans-serif";
const NUM = "font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1";

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
  const business = o.businessName.trim() || "your business";
  const subject = `Your funding offer for ${business} is ready`;
  const note = o.message.trim();
  const sign = [o.repName, shop, o.repPhone, o.repEmail].map((x) => x.trim()).filter(Boolean);
  const fine =
    "This is a summary of an offer, not a contract. Final terms, and any disclosures your state requires, come with the funding agreement.";

  const text = [
    hi,
    "",
    "Following up on our call, here are the terms we put together for you.",
    "",
    `Funding: ${amount}`,
    `${freq.payment}: ${payment} (${o.payments} payments${final ? `, final payment ${final}` : ""})`,
    `Factor rate: ${factorWords(o.factorRate)}`,
    `Term: ${termWords(o.frequency, o.payments)}`,
    `Valid through: ${o.validThrough}`,
    "",
    `View and accept your offer: ${o.url}`,
    ...(note ? ["", note] : []),
    "",
    "Any questions, reply to this email or give me a call.",
    "",
    sign.join("\n"),
    "",
    `Offer ${o.number}. ${fine}`,
  ].join("\n");

  const row = (label: string, value: string) =>
    `<tr><td style="padding:13px 0;border-top:1px solid #eeecf3;font:400 14px/1.4 ${FONT};color:#6b6b7b">${esc(label)}</td>` +
    `<td align="right" style="padding:13px 0;border-top:1px solid #eeecf3;font:600 14px/1.4 ${FONT};color:#16121f;${NUM}">${esc(value)}</td></tr>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');</style></head>
<body style="margin:0;padding:0;background:#f5f4f0;font-family:${FONT};color:#16121f;-webkit-font-smoothing:antialiased">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;visibility:hidden">${esc(`Your ${amount} funding offer is ready. Valid through ${o.validThrough}.`)}${"&zwnj;&nbsp;".repeat(60)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4f0;padding:32px 12px 36px">
<tr><td align="center">
<!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 20px"><img src="${esc(o.logoUrl)}" width="168" alt="${esc(shop)}" style="display:block;border:0;width:168px;max-width:60%;height:auto"></td></tr>
<tr><td style="background:#ffffff;border:1px solid #ebe9e3;border-radius:20px;padding:34px 32px 12px">
<p style="margin:0 0 10px;font:600 11px ${FONT};letter-spacing:2.2px;text-transform:uppercase;color:#7c3aed">Prepared for ${esc(business)}</p>
<h1 style="margin:0 0 14px;font:700 28px/1.2 ${FONT};letter-spacing:-0.6px;color:#16121f">Your funding offer is ready</h1>
<p style="margin:0 0 24px;font:400 15px/1.65 ${FONT};color:#3f3f4e">${esc(hi)} following up on our call, here are the terms we put together for you.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#16121f" style="background:#16121f url('${esc(o.heroUrl)}') center/cover no-repeat;border-radius:16px">
<tr><td style="padding:26px 26px 24px">
<p style="margin:0;font:600 11px ${FONT};letter-spacing:2.2px;text-transform:uppercase;color:#c4b5fd">Your funding offer</p>
<p style="margin:8px 0 0;font:700 44px/1.05 ${FONT};letter-spacing:-1.4px;color:#ffffff;${NUM}">${esc(amount)}</p>
<p style="margin:12px 0 0;font:500 14px/1.5 ${FONT};color:#d4d4e2;${NUM}">${esc(`${freq.payment}: ${payment} · ${o.payments} payments`)}</p>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px">
${row("Factor rate", factorWords(o.factorRate))}
${final ? row("Final payment", final) : ""}
${row("Term", termWords(o.frequency, o.payments))}
${row("Valid through", o.validThrough)}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:26px 0 24px"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#7c3aed" style="background:#7c3aed;background-image:linear-gradient(135deg,#6d4af0,#7c3aed);border-radius:999px">
<a href="${esc(o.url)}" style="display:block;padding:15px 34px;font:600 15px ${FONT};color:#ffffff;text-decoration:none;letter-spacing:0.1px">View and accept your offer</a>
</td></tr></table>
</td></tr></table>
${
  note
    ? `<p style="margin:0 0 20px;padding-left:14px;border-left:3px solid #7c3aed;font:400 14px/1.6 ${FONT};color:#3f3f4e">${esc(note)}</p>`
    : ""
}
<p style="margin:0 0 22px;font:400 14px/1.6 ${FONT};color:#6b6b7b">Any questions, reply to this email or give me a call.</p>
</td></tr>
<tr><td style="padding:22px 6px 0;font:400 14px/1.6 ${FONT};color:#4b4b5a">${sign
    .map((l, i) =>
      i === 0 ? `<strong style="font-weight:600;color:#16121f">${esc(l)}</strong>` : esc(l),
    )
    .join("<br>")}</td></tr>
<tr><td style="padding:16px 6px 0;font:400 11px/1.6 ${FONT};color:#9a9aa8">${esc(fine)} Offer ${esc(o.number)}.<br>Button not working? <a href="${esc(o.url)}" style="color:#7c3aed;word-break:break-all">${esc(o.url)}</a></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
  return { subject, text, html };
}
