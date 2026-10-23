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
const CARD_RUN = /\b(?:\d[ -]?){13,19}\b/g;
const ACCOUNT = /\b(?:acct|account|routing|aba)\s*(?:#|no\.?|number|num)?\s*[:=]?\s*\d{6,}/i;

/**
 * Notes are the product — and the easiest place for a merchant's SSN or card number to end up.
 * CLAUDE.md says those are never stored, so refuse them at the door with a message that says why.
 */
export function findSensitive(text: string): SensitiveHit | null {
  if (SSN.test(text)) {
    return {
      kind: "ssn",
      message:
        "That looks like a Social Security number. We don't store those — take it out and save again.",
    };
  }
  for (const m of text.matchAll(CARD_RUN)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      return {
        kind: "card",
        message:
          "That looks like a card number. We never store those — take it out and save again.",
      };
    }
  }
  if (ACCOUNT.test(text)) {
    return {
      kind: "account",
      message:
        "That looks like a bank account or routing number. We don't store those — take it out and save again.",
    };
  }
  return null;
}
