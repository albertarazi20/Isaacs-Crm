import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDesign, fieldsIn, preheaderText } from "@/lib/approvals/html";
import {
  loadButtonLabel,
  slotsAreEmpty,
  slotsInUse,
  STOCK_DESIGNS,
  STOCK_SLOTS,
  stockIsLoaded,
  stockTiming,
  type StockSlotState,
} from "@/lib/approvals/stock";
import { STOCK_HTML } from "@/lib/approvals/stock/generated";

/**
 * The Selective Capital designs: the owner's four HTML emails, copied byte for byte into src/lib/approvals/stock and
 * embedded as strings in a generated module (so the production build carries them). No database.
 */

const dir = join(process.cwd(), "src", "lib", "approvals", "stock");
const FILE_OF = {
  initial: "initial.html",
  followUp1: "follow-up-1.html",
  followUp2: "follow-up-2.html",
  followUp3: "follow-up-3.html",
} as const;

describe("the embedded module is the .html files, exactly", () => {
  it.each(Object.entries(FILE_OF))("%s equals %s byte for byte", (key, file) => {
    const onDisk = readFileSync(join(dir, file));
    const embedded = Buffer.from(STOCK_HTML[key as keyof typeof FILE_OF], "utf8");
    expect(embedded.equals(onDisk)).toBe(true);
    expect(onDisk.length).toBeGreaterThan(5_000);
  });

  it("the module on disk is what the generator writes now (no drift)", () => {
    const r = spawnSync(process.execPath, ["scripts/generate-stock-designs.mjs", "--check"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("the designs are the owner's: a design file was not reformatted (no carriage returns, no tabs added, no BOM)", () => {
    for (const file of Object.values(FILE_OF)) {
      const bytes = readFileSync(join(dir, file));
      expect(bytes.includes(0x0d)).toBe(false);
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
      expect(bytes.subarray(0, 9).toString("latin1")).toBe("<!DOCTYPE");
    }
  });

  it("the folder is kept out of Prettier, which would rewrite the designs", () => {
    const ignore = readFileSync(join(process.cwd(), ".prettierignore"), "utf8");
    expect(ignore).toContain("src/lib/approvals/stock/*.html");
    expect(ignore).toContain("src/lib/approvals/stock/generated.ts");
  });
});

describe("the four slots", () => {
  it("are the approval email then three follow-ups, with the owner's subjects and the README's waits", () => {
    expect(STOCK_SLOTS).toBe(4);
    expect(STOCK_DESIGNS.map((d) => [d.step, d.subject, d.delayHours, d.fileName])).toEqual([
      [1, "{{business_name}}: Approved for Funding", 0, "initial.html"],
      [2, "Did you see your approval, {{first_name}}?", 24, "follow-up-1.html"],
      [3, "Your offer is time-sensitive", 48, "follow-up-2.html"],
      [4, "Should I keep your offer open, {{first_name}}?", 48, "follow-up-3.html"],
    ]);
    // counted from the approval: about 1, 3 and 5 days
    const at = STOCK_DESIGNS.reduce<number[]>(
      (acc, d) => [...acc, (acc.at(-1) ?? 0) + d.delayHours],
      [],
    );
    expect(at).toEqual([0, 24, 72, 120]);
  });

  it("each wait is counted from the email before it", () => {
    expect(stockTiming(1)).toBe("You send it from your own mail");
    expect(stockTiming(2)).toBe("24 hours after the approval email");
    expect(stockTiming(3)).toBe("48 hours after Follow-up 1");
    expect(stockTiming(4)).toBe("48 hours after Follow-up 2");
  });

  it("use the fields the owner listed, and follow-up 3 alone needs the hold date", () => {
    const used = (i: number) => [...fieldsIn(STOCK_DESIGNS[i]!.html).used].sort();
    const common = [
      "business_name",
      "first_name",
      "rep_email",
      "rep_name",
      "rep_phone",
      "unsubscribe_link",
    ];
    expect(used(0)).toEqual(common);
    expect(used(1)).toEqual(common);
    expect(used(2)).toEqual(common);
    expect(used(3)).toEqual([...common, "offer_expiry"].sort());
    for (const d of STOCK_DESIGNS) expect(fieldsIn(d.html).unknown).toEqual([]);
  });
});

describe("the app's own design check accepts all four", () => {
  it.each(STOCK_DESIGNS.map((d) => [d.name, d] as const))("%s: no errors, no warnings", (_n, d) => {
    const check = checkDesign(d.html, d.subject);
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual([]);
    // nothing was taken out of it (scripts), so what is saved is what the owner made
    expect(check.html).toBe(d.html);
  });

  it("the inbox preheader is the one the owner wrote into each design", () => {
    expect(STOCK_DESIGNS.map((d) => preheaderText(d.html))).toEqual([
      "{{business_name}} is approved. Your offer is ready, and we can fund as soon as today.",
      "{{business_name}} is approved and the offer is ready to review.",
      "Approvals are tied to your current bank statements.",
      "Your offer for {{business_name}} expires {{offer_expiry}}.",
    ]);
  });
});

describe("the load button's words", () => {
  const slot = (step: number, html = "", subject = ""): StockSlotState => ({
    step,
    html,
    subject,
    delayHours: STOCK_DESIGNS.find((d) => d.step === step)?.delayHours ?? 48,
  });
  const empty = [1, 2, 3, 4].map((s) => slot(s));
  const loaded = STOCK_DESIGNS.map((d) => slot(d.step, d.html, d.subject));

  it("reads Load when all four are empty, Replace when any holds a design", () => {
    expect(slotsAreEmpty(empty)).toBe(true);
    expect(loadButtonLabel(empty)).toBe("Load the Selective Capital designs");
    expect(slotsInUse(empty)).toEqual([]);
    const one = [slot(1), slot(2), slot(3, "<p>x</p>", "s"), slot(4)];
    expect(slotsAreEmpty(one)).toBe(false);
    expect(loadButtonLabel(one)).toBe("Replace with the Selective Capital designs");
    expect(slotsInUse(one)).toEqual([3]);
    // whitespace alone is no design
    expect(slotsAreEmpty([slot(1, "  \n"), slot(2), slot(3), slot(4)])).toBe(true);
  });

  it("knows when the designs are already in place", () => {
    expect(stockIsLoaded(empty)).toBe(false);
    expect(stockIsLoaded(loaded)).toBe(true);
    expect(loadButtonLabel(loaded)).toBe("Replace with the Selective Capital designs");
    expect(stockIsLoaded(loaded.map((s) => (s.step === 2 ? { ...s, delayHours: 36 } : s)))).toBe(
      false,
    );
    expect(stockIsLoaded(loaded.slice(0, 3))).toBe(false);
  });
});
