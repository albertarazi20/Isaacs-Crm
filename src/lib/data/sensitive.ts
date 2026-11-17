export interface SensitiveHit {
  kind: "ssn" | "card" | "account";
  message: string;
}

/** Luhn checksum — what separates a card number from any other long number (phone, amount, date). */
export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const SSN = /\b\d{3}[ -]\d{2}[ -]\d{4}\b/;
// A broker types what the merchant reads out: "SSN 123456789" with no dashes is the likeliest way one lands in a note.
const SSN_WORD =
  /\b(?:ssn|ss#|social(?:\s+security)?(?:\s+(?:number|no\.?|num|#))?)(?:\s+(?:is|was))?\s*[:#=-]?\s*\d{3}[ -]?\d{2}[ -]?\d{4}\b/i;
// Tax IDs are held last-four-only (CLAUDE.md), so a whole one is refused too.
const EIN_WORD = /\b(?:ein|fein|tax\s*id)\s*(?:#|no\.?|number|num)?\s*[:=#-]?\s*\d{2}-?\d{7}\b/i;
// Typos break the checksum, so a card written the way cards are written (4-4-4-4, or Amex 4-6-5) is refused anyway,
// and so is a 15-16 digit run right after a card word. A bare long number (a reference, an amount) still passes.
const CARD_GROUPED = /\b\d{4}([ -])\d{4}\1\d{4}\1\d{4}\b|\b\d{4}([ -])\d{6}\2\d{5}\b/;
const CARD_WORD =
  /\b(?:card|visa|mastercard|master\s+card|amex|american\s+express|discover)\b\D{0,20}(?:\d[ -]?){14,18}\d\b/i;
const CARD_RUN = /\b(?:\d[ -]?){13,19}\b/g;
const ACCOUNT = /\b(?:acct|account|routing|aba)\s*(?:#|no\.?|number|num)?\s*[:=]?\s*\d{6,}/i;

/**
 * Notes are the product — and the easiest place for a merchant's SSN or card number to end up.
 * CLAUDE.md says those are never stored, so refuse them at the door with a message that says why.
 */
export function findSensitive(text: string): SensitiveHit | null {
  if (SSN.test(text) || SSN_WORD.test(text)) {
    return {
      kind: "ssn",
      message:
        "That looks like a Social Security number. We don't store those. Take it out and save again.",
    };
  }
  if (EIN_WORD.test(text)) {
    return {
      kind: "ssn",
      message:
        "That looks like a full tax ID. We only keep the last 4 digits. Take the rest out and save again.",
    };
  }
  if (CARD_GROUPED.test(text) || CARD_WORD.test(text)) {
    return {
      kind: "card",
      message: "That looks like a card number. We never store those. Take it out and save again.",
    };
  }
  for (const m of text.matchAll(CARD_RUN)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      return {
        kind: "card",
        message: "That looks like a card number. We never store those. Take it out and save again.",
      };
    }
  }
  if (ACCOUNT.test(text)) {
    return {
      kind: "account",
      message:
        "That looks like a bank account or routing number. We don't store those. Take it out and save again.",
    };
  }
  return null;
}
