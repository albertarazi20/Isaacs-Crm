/** A trailing extension ("x12", "ext. 2", "extension 15") is not part of the number. */
const EXTENSION = /[\s,;]*(?:extension|ext\.?|x)\s*\.?\s*\d{1,6}\s*$/i;

/** Placeholder numbers people type to get past a required field: 0000000000, 1111111111, 1234567890, 9876543210. */
function isPlaceholder(ten: string): boolean {
  if (/^(\d)\1{9}$/.test(ten)) return true;
  const step = (ten.charCodeAt(1) - ten.charCodeAt(0) + 10) % 10;
  if (step !== 1 && step !== 9) return false;
  return [...ten].every((c, i) => i === 0 || (Number(c) - Number(ten[i - 1]) + 10) % 10 === step);
}

/**
 * US numbers only for now — Isaac works US merchants. Returns E.164 or null. Numbers no US carrier can issue (an area
 * code starting 0 or 1, an exchange starting 0) and placeholders (all one digit, 1234567890) are not numbers: the same
 * junk typed on two different leads must never read as one merchant.
 */
export function normalizeUS(raw: string): string | null {
  const digits = raw.replace(EXTENSION, "").replace(/\D/g, "");
  const ten =
    digits.length === 10
      ? digits
      : digits.length === 11 && digits.startsWith("1")
        ? digits.slice(1)
        : null;
  if (!ten) return null;
  if (!/^[2-9]/.test(ten) || ten[3] === "0" || isPlaceholder(ten)) return null;
  return `+1${ten}`;
}

/**
 * Why Call and Text are off for this phone field, in plain words, or null when the number can be
 * dialed. An empty field and a field with no usable number (like "call his cell") read differently.
 */
export function phoneProblem(raw: string): string | null {
  if (normalizeUS(raw)) return null;
  return raw.trim() === ""
    ? "No phone number on file. Add one."
    : "Not a usable phone number. Fix it.";
}

export function formatUS(raw: string): string {
  const e164 = normalizeUS(raw);
  if (!e164) return raw;
  const n = e164.slice(2);
  return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
}

export function telHref(e164: string): string {
  return `tel:${e164}`;
}

/** `?&body=` is the form that both iOS and Android Messages accept. */
export function smsHref(e164: string, body?: string): string {
  return body ? `sms:${e164}?&body=${encodeURIComponent(body)}` : `sms:${e164}`;
}

/**
 * Google Voice has no documented deep link. `itemId=t.<e164>` opens an existing thread with that
 * number and falls back to the Messages inbox otherwise — unverified, so the UI also copies the number.
 */
export function voiceTextHref(e164: string): string {
  return `https://voice.google.com/u/0/messages?itemId=t.${encodeURIComponent(e164)}`;
}

export function voiceCallHref(e164: string): string {
  return `https://voice.google.com/u/0/calls?a=nc,${encodeURIComponent(e164)}`;
}

export function gmailComposeHref(args: { to: string; subject?: string; body?: string }): string {
  const q = new URLSearchParams({ view: "cm", fs: "1", to: args.to });
  if (args.subject) q.set("su", args.subject);
  if (args.body) q.set("body", args.body);
  return `https://mail.google.com/mail/?${q.toString()}`;
}
