/** US numbers only for now — Isaac works US merchants. Returns E.164 or null. */
export function normalizeUS(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
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
