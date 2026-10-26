/**
 * Several spellings of one thing ("Referral", "referral"): the most common one wins. On a tie, the one that
 * isn't all lowercase ("TX" over "tx"), then alphabetical, so the answer never depends on input order.
 */
export function mostCommonSpelling(counts: ReadonlyMap<string, number>): string {
  const lower = (s: string) => Number(s === s.toLowerCase());
  const [best] = [...counts].sort(
    (a, b) => b[1] - a[1] || lower(a[0]) - lower(b[0]) || a[0].localeCompare(b[0]),
  );
  return best?.[0] ?? "";
}
