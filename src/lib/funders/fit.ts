import { formatMoneyCompact } from "../money";
import { ordinal } from "./format";
import { normalizeState } from "./states";
import type { FunderRow } from "./types";

/** The part of a funder that decides whether a merchant fits. */
export type FunderAppetite = Pick<
  FunderRow,
  | "name"
  | "min_monthly_revenue_cents"
  | "min_time_in_business_months"
  | "max_position"
  | "min_amount_cents"
  | "max_amount_cents"
  | "excluded_states"
  | "excluded_industries"
>;

/** What we know about the merchant. Null / empty string means "not entered yet" — never "fails". */
export interface MerchantFacts {
  industry: string;
  state: string;
  monthlyRevenueCents: number | null;
  timeInBusinessMonths: number | null;
  /** The position this advance would take: advances already on the business + 1. */
  nextPosition: number;
  wantedAmountCents: number | null;
}

/**
 * fits   — nothing known is against it and nothing relevant is missing
 * check  — nothing known is against it, but a field this funder cares about is blank ("unknown")
 * warn   — at least one thing the funder won't write
 */
export type FitLevel = "fits" | "check" | "warn";

export interface FitResult {
  level: FitLevel;
  /** Plain-words reasons the funder may pass. Empty unless level is "warn". */
  reasons: string[];
  /** Merchant fields this funder has a rule about that are still blank. */
  unknown: string[];
}

export function merchantFacts(card: {
  industry: string;
  state: string;
  monthly_revenue_cents: number | null;
  time_in_business_months: number | null;
  position_count: number;
  wanted_amount_cents: number | null;
}): MerchantFacts {
  return {
    industry: card.industry,
    state: card.state,
    monthlyRevenueCents: card.monthly_revenue_cents,
    timeInBusinessMonths: card.time_in_business_months,
    nextPosition: card.position_count + 1,
    wantedAmountCents: card.wanted_amount_cents,
  };
}

function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:sses|ches|shes|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** "Restaurants & Bars" → ["restaurant", "and", "bar"]. Case, punctuation and plurals don't matter. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(singular);
}

/** True when `needle` appears in `haystack` as whole consecutive words. */
function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((w, j) => haystack[i + j] === w)) return true;
  }
  return false;
}

/**
 * The funder's own wording of the exclusion that covers this industry, or null. "Restaurant / Pizzeria"
 * is covered by "restaurants"; "Auto repair" by "auto"; "Automotive" is not covered by "auto" (whole words only).
 */
export function excludedIndustry(industry: string, excluded: readonly string[]): string | null {
  const have = tokens(industry);
  if (have.length === 0) return null;
  for (const entry of excluded) {
    if (containsPhrase(have, tokens(entry))) return entry;
  }
  return null;
}

/**
 * Would this funder write this merchant? A warning, never a block: the broker knows things the fields
 * don't (a funder that bends its rules for a good merchant). Boundaries are inclusive — a merchant at
 * exactly the minimum revenue fits.
 */
export function checkFit(funder: FunderAppetite, merchant: MerchantFacts): FitResult {
  const reasons: string[] = [];
  const unknown: string[] = [];

  if (funder.max_position !== null && merchant.nextPosition > funder.max_position) {
    reasons.push(
      `${funder.name} won't take ${ordinal(merchant.nextPosition)} position (up to ${ordinal(funder.max_position)})`,
    );
  }

  if (funder.min_monthly_revenue_cents !== null) {
    if (merchant.monthlyRevenueCents === null) unknown.push("monthly revenue");
    else if (merchant.monthlyRevenueCents < funder.min_monthly_revenue_cents)
      reasons.push(
        `min revenue ${formatMoneyCompact(funder.min_monthly_revenue_cents)}, merchant has ${formatMoneyCompact(merchant.monthlyRevenueCents)}`,
      );
  }

  if (funder.min_time_in_business_months !== null) {
    if (merchant.timeInBusinessMonths === null) unknown.push("time in business");
    else if (merchant.timeInBusinessMonths < funder.min_time_in_business_months)
      reasons.push(
        `min ${funder.min_time_in_business_months} months in business, merchant has ${merchant.timeInBusinessMonths}`,
      );
  }

  if (funder.excluded_states.length > 0) {
    if (merchant.state.trim() === "") unknown.push("state");
    else {
      const code = normalizeState(merchant.state);
      if (code === null) unknown.push("state");
      else if (funder.excluded_states.some((s) => normalizeState(s) === code))
        reasons.push(`excludes ${code}`);
    }
  }

  if (funder.excluded_industries.length > 0) {
    if (merchant.industry.trim() === "") unknown.push("industry");
    else {
      const hit = excludedIndustry(merchant.industry, funder.excluded_industries);
      if (hit !== null) reasons.push(`excludes ${hit.trim().toLowerCase()}`);
    }
  }

  if (funder.min_amount_cents !== null || funder.max_amount_cents !== null) {
    const wanted = merchant.wantedAmountCents;
    if (wanted === null) unknown.push("amount wanted");
    else {
      if (funder.min_amount_cents !== null && wanted < funder.min_amount_cents)
        reasons.push(
          `min advance ${formatMoneyCompact(funder.min_amount_cents)}, merchant wants ${formatMoneyCompact(wanted)}`,
        );
      if (funder.max_amount_cents !== null && wanted > funder.max_amount_cents)
        reasons.push(
          `tops out at ${formatMoneyCompact(funder.max_amount_cents)}, merchant wants ${formatMoneyCompact(wanted)}`,
        );
    }
  }

  const level: FitLevel = reasons.length > 0 ? "warn" : unknown.length > 0 ? "check" : "fits";
  return { level, reasons, unknown };
}

/** Which funders to tick by default in the Send dialog: everything not known to be a bad fit. */
export const selectedByDefault = (fit: FitResult): boolean => fit.level !== "warn";
