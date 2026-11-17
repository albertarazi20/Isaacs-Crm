import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import "@/lib/data/schemas";

// Production sends a CSP without 'unsafe-eval'. Zod probes `new Function` unless told not to, and the
// browser reports every probe as a violation. These schema files reach the browser, so each must switch the
// probe off before it builds a schema.
const BROWSER_SCHEMAS = ["src/lib/data/schemas.ts", "src/lib/messaging/schemas.ts"];

describe("zod never probes eval", () => {
  it("is switched to jitless", () => {
    expect(z.core.globalConfig.jitless).toBe(true);
  });
  it.each(BROWSER_SCHEMAS)("%s imports the setup before anything else", (file) => {
    const firstImport = readFileSync(join(process.cwd(), file), "utf8")
      .split("\n")
      .find((l) => l.startsWith("import "));
    expect(firstImport).toBe('import "../zod-setup";');
  });
});
