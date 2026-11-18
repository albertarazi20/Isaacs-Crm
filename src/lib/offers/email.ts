/**
 * The email that carries an offer. It shows the amount and that same-day funding is available, in the rep's own
 * voice, and links to the merchant's private offer page, where the rest of the terms are (opening it is what the rep
 * is told about). The "brand hero" look the owner picked: a dark glow header with the logo, the amount and a white
 * button, then a white body. A plain-text part says the same.
 */
import { formatMoney } from "../money";
import type { Frequency } from "./terms";

export interface OfferEmailInput {
  number: string;
  firstName: string;
  businessName: string;
  shopName: string;
  /** The amount is shown; the other terms are kept for the CRM's record and stay on the offer page. */
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
  /** The brand glow behind the header (absolute); the header is near-black where images are off. */
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

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const font = (weight: number, size: number, line?: number | string) =>
  `font-family:${SANS};font-weight:${weight};font-size:${size}px${line ? `;line-height:${line}` : ""}`;

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

export function offerEmail(o: OfferEmailInput): { subject: string; text: string; html: string } {
  const first = o.firstName.trim();
  const shop = o.shopName.trim() || "Selective Capital";
  const business = o.businessName.trim() || "your business";
  const amount = formatMoney(o.fundedCents);
  const subject = first
    ? `${first}, you're approved for ${amount}`
    : `${business} is approved for ${amount}`;
  const preheader = "Same-day funding available.";
  const hey = first ? `Hey ${first},` : "Hi there,";
  const p1 = `${business} is approved for ${amount}. Open your offer, upload your documents and hit Accept.`;
  const p2 = "Done early in the day, you can be funded the same day.";
  const phone = o.repPhone.trim();
  const ask = phone ? `Questions? Reply or call ${phone}.` : "Questions? Just reply.";
  const askHtml = phone
    ? `Questions? Reply or call <span style="white-space:nowrap">${esc(phone)}</span>.`
    : esc(ask);
  const note = o.message.trim();
  const sign = [o.repName, shop, o.repPhone, o.repEmail].map((x) => x.trim()).filter(Boolean);
  const fine =
    "This is an offer summary, not a contract. Final terms, and any disclosures your state requires, come with the funding agreement.";

  const text = [
    hey,
    "",
    p1,
    "",
    `See your offer: ${o.url}`,
    "",
    p2,
    "",
    `Offer good until ${o.validThrough}.`,
    ...(note ? ["", note] : []),
    "",
    ask,
    "",
    sign.join("\n"),
    "",
    `Offer ${o.number}. ${fine}`,
  ].join("\n");

  const label = `margin:0;${font(600, 10)};letter-spacing:1.6px;text-transform:uppercase;color:#8a90a0`;
  const value = `margin:5px 0 0;${font(600, 14, 1.4)};color:#0b0b12`;
  const body = `margin:0;${font(400, 16, 1.65)};color:#374151`;
  const rep = o.repName.trim();

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eceef4;font-family:${SANS};color:#111827">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;visibility:hidden">${esc(preheader)}${"&zwnj;&nbsp;".repeat(60)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eceef4;padding:32px 12px 36px">
<tr><td align="center">
<!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:22px;overflow:hidden">
<tr><td bgcolor="#0b0b12" background="${esc(o.heroUrl)}" style="background:#0b0b12 url('${esc(o.heroUrl)}') center top/cover no-repeat;padding:32px 34px 36px">
<img src="${esc(o.logoUrl)}" width="160" alt="${esc(shop)}" style="display:block;border:0;width:160px;max-width:100%;height:auto">
<p style="margin:40px 0 0;${font(600, 11)};letter-spacing:2.5px;text-transform:uppercase;color:#c4b5fd">Funding offer &middot; ${esc(business)}</p>
<p style="margin:10px 0 0;${font(700, 58, 1)};letter-spacing:-2px;color:#ffffff">${esc(amount)}</p>
<p style="margin:12px 0 0;${font(400, 17, 1.5)};color:#d6d9ea">You&#39;re approved.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr><td style="background:#16203f;border:1px solid #3b6cf5;border-radius:999px;padding:7px 14px 7px 12px;${font(700, 13)};color:#e3e9ff"><span style="color:#60a5fa">&#9679;</span>&nbsp; Same-day funding available</td></tr></table>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:26px"><tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:999px">
<a href="${esc(o.url)}" style="display:block;padding:15px 30px;${font(700, 15)};color:#0b0b12;text-decoration:none">See my offer &nbsp;&rarr;</a>
</td></tr></table>
</td></tr>
<tr><td style="padding:30px 34px 0">
<p style="${body};margin-bottom:12px">${esc(hey)}</p>
<p style="${body};margin-bottom:12px">${esc(p1)}</p>
<p style="${body}">${esc(p2)}</p>
</td></tr>
<tr><td style="padding:24px 34px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ececf3;border-radius:14px"><tr>
<td style="padding:16px 18px"><p style="${label}">Offer good until</p><p style="${value}">${esc(o.validThrough)}</p></td>
</tr></table>
</td></tr>
${
  note
    ? `<tr><td style="padding:24px 34px 0"><p style="margin:0;padding-left:16px;border-left:3px solid #7c3aed;${font(400, 15, 1.6)};color:#4b5263">${esc(note)}</p></td></tr>`
    : ""
}
<tr><td style="padding:24px 34px 0"><p style="${body}">${askHtml}</p></td></tr>
<tr><td style="padding:16px 34px 30px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
${
  rep
    ? `<td style="vertical-align:top;padding-right:14px"><div style="width:42px;height:42px;border-radius:42px;background:#7c3aed;background-image:linear-gradient(135deg,#2e7bff,#7c3aed);text-align:center;${font(700, 14, "42px")};color:#ffffff">${esc(initials(rep))}</div></td>`
    : ""
}
<td style="${font(400, 13, 1.55)};color:#6b7280">${sign
    .map((l, i) =>
      i === 0 ? `<strong style="font-size:14px;color:#0b0b12">${esc(l)}</strong>` : esc(l),
    )
    .join("<br>")}</td>
</tr></table>
</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px"><tr><td style="padding:18px 12px 0;${font(400, 11, 1.6)};color:#8a90a0;text-align:center">Offer ${esc(o.number)} &middot; ${esc(fine)}<br>Link: <a href="${esc(o.url)}" style="color:#7c3aed;word-break:break-all">${esc(o.url)}</a></td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
  return { subject, text, html };
}
