import type { ImportResult } from "../data/import";

/**
 * Rows per server call. One call is one transaction of a few round trips per row, and a hosted function may be given as
 * little as 10 seconds, so a big file goes up in slices instead of one request. Re-running is safe: rows already added
 * are skipped by phone (or by name when there is no phone).
 */
export const IMPORT_BATCH = 100;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

export const emptyImportResult = (): ImportResult => ({
  created: 0,
  skippedExisting: 0,
  skippedDoNotContact: 0,
  failed: [],
});

export function mergeImportResults(a: ImportResult, b: ImportResult): ImportResult {
  return {
    created: a.created + b.created,
    skippedExisting: a.skippedExisting + b.skippedExisting,
    skippedDoNotContact: a.skippedDoNotContact + b.skippedDoNotContact,
    // each failure carries its own file line, so slices need no renumbering
    failed: [...a.failed, ...b.failed],
  };
}
