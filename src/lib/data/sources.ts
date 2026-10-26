/** Starting suggestions for "where did they come from". His own spellings always win over these. */
export const DEFAULT_SOURCES = [
  "Referral",
  "Repeat merchant",
  "Cold call",
  "Lead list",
  "Website",
  "Broker / ISO",
  "Walk-in",
  "Social media",
] as const;

/** His existing sources first (most used first), then the starters he hasn't used — no case-only duplicates. */
export function mergeSources(existing: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...existing, ...DEFAULT_SOURCES]) {
    const clean = s.trim().replace(/\s+/g, " ");
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}
