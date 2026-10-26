import { describe, expect, it } from "vitest";
import { chunk, emptyImportResult, IMPORT_BATCH, mergeImportResults } from "@/lib/import/batches";

describe("import slices", () => {
  it("cuts a file into slices of the batch size and keeps every row once, in order", () => {
    const rows = Array.from({ length: 2 * IMPORT_BATCH + 7 }, (_, i) => i);
    const slices = chunk(rows, IMPORT_BATCH);
    expect(slices.map((s) => s.length)).toEqual([IMPORT_BATCH, IMPORT_BATCH, 7]);
    expect(slices.flat()).toEqual(rows);
    expect(chunk([], IMPORT_BATCH)).toEqual([]);
  });

  it("adds up the counts and keeps each failure on its own file line", () => {
    const a = {
      created: 90,
      skippedExisting: 4,
      skippedDoNotContact: 1,
      failed: [{ line: 12, message: "Business name is required" }],
    };
    const b = {
      created: 80,
      skippedExisting: 0,
      skippedDoNotContact: 2,
      failed: [{ line: 143, message: "Bad phone" }],
    };
    expect(mergeImportResults(mergeImportResults(emptyImportResult(), a), b)).toEqual({
      created: 170,
      skippedExisting: 4,
      skippedDoNotContact: 3,
      failed: [a.failed[0], b.failed[0]],
    });
  });
});
