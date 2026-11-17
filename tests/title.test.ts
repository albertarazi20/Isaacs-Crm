import { describe, expect, it } from "vitest";
import { appTitle, merchantMetadata } from "@/lib/title";

describe("tab titles", () => {
  it("names the page after the due count", () => {
    expect(appTitle(12, "Follow Up")).toBe("(12) Follow Up · Selective CRM");
    expect(appTitle(0, "Trash")).toBe("Trash · Selective CRM");
    expect(appTitle(3)).toBe("(3) Selective CRM");
    expect(appTitle(3, "%s")).toBe("(3) %s · Selective CRM");
  });
  it("never says CRM on a merchant's page", () => {
    const m = merchantMetadata("Your documents");
    expect(m.title).toBe("Your documents · Selective Capital");
    expect(JSON.stringify(m)).not.toMatch(/CRM/);
  });
});
