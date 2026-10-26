import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * An MCA shop dismisses a CRM the moment it says "loan" or "interest rate" (docs/DOMAIN.md).
 * Every visible string in the UI must use advance / factor rate / payback / remittance / funder / merchant.
 */
const ROOTS = ["src/components", "src/app", "src/lib/mca"].map((r) => join(process.cwd(), r));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = ROOTS.flatMap(walk).filter((f) => /\.(ts|tsx)$/.test(f));

const BANNED_WORDS =
  /\b(loans?|lenders?|borrowers?|installments?|interest rates?|principal|amount due|customers?)\b/i;
const BANNED_APR = /\bAPR\b/; // case-sensitive: "Apr" is a month
const hasBannedWord = (text: string): boolean => BANNED_WORDS.test(text) || BANNED_APR.test(text);

/** The strings a person could read on one line: quoted text with words, label-style attributes, JSX text. */
function visibleText(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    if (/\s/.test(m[2] ?? "")) out.push(m[2] ?? "");
  }
  for (const m of line.matchAll(
    /\b(?:label|placeholder|title|hint|aria-label|alt)=\{?["'`]([^"'`]*)["'`]/g,
  ))
    out.push(m[1] ?? "");
  for (const m of line.matchAll(/>([^<>{}]+)</g)) out.push(m[1] ?? "");
  const plainJsxText =
    /^\s*[A-Za-z][^<>{}=;()"'`]*\s[^<>{}=;()"'`]*$/.test(line) &&
    !/[,;{(]\s*$/.test(line) &&
    !/\w\.\w/.test(line) &&
    !/^\s*\w+\??:\s/.test(line);
  if (plainJsxText) out.push(line.trim());
  return out;
}

const paymentInVisibleText = (line: string): boolean =>
  visibleText(line).some((t) => /\bpayments?\b/i.test(t));

function scan(test: (line: string) => boolean): string[] {
  const hits: string[] = [];
  for (const f of files) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line) || /^import /.test(line)) return;
        if (test(line))
          hits.push(`${relative(process.cwd(), f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
  }
  return hits;
}

describe("MCA language in the UI", () => {
  it("never says loan, lender, borrower, installment, interest rate, principal or customer", () => {
    expect(scan(hasBannedWord)).toEqual([]);
  });

  it("says remittance, not payment, in text a person reads", () => {
    expect(scan(paymentInVisibleText)).toEqual([]);
  });

  it("the detector flags real violations and spares identifiers and months", () => {
    expect(paymentInVisibleText('<Field label="Payment">')).toBe(true);
    expect(paymentInVisibleText('const m = "estimated from payments elapsed";')).toBe(true);
    expect(paymentInVisibleText("<p>Last payment received</p>")).toBe(true);
    expect(paymentInVisibleText("   Last payment received")).toBe(true);
    expect(paymentInVisibleText("const x = terms.paymentCents;")).toBe(false);
    expect(paymentInVisibleText('<Input {...bind("payment")} />')).toBe(false);
    expect(paymentInVisibleText("funding_payment_cents: number | null;")).toBe(false);
    expect(paymentInVisibleText("payment: f.payment,")).toBe(false);
    expect(paymentInVisibleText("{ payment: money, frequency }")).toBe(false);
    expect(hasBannedWord("Interest rate")).toBe(true);
    expect(hasBannedWord("Your loan")).toBe(true);
    expect(hasBannedWord('const MONTHS = ["Apr", "May"];')).toBe(false);
    expect(hasBannedWord("The APR is")).toBe(true);
    expect(hasBannedWord("Interested")).toBe(false);
  });
});
