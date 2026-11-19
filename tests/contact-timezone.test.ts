import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AREA_CODE_TZ } from "@/lib/mca/areaCodeTz";
import { merchantTimezone, quietHours, SPLIT_STATE_ZONES, stateTimezone } from "@/lib/mca/contact";

const migration = (name: string) => readFileSync(`db/migrations/${name}`, "utf8");

describe("the browser's time zone rules mirror the database's", () => {
  it("AREA_CODE_TZ is exactly the area_code_tz table", () => {
    const sql = migration("0310_send_engine.sql");
    const block = sql.slice(
      sql.indexOf("insert into area_code_tz"),
      sql.indexOf("grant select on area_code_tz"),
    );
    const rows = [...block.matchAll(/\('(\d{3})','([^']+)'\)/g)].map((m) => [m[1]!, m[2]!]);
    expect(rows.length).toBeGreaterThan(250);
    expect(AREA_CODE_TZ).toEqual(Object.fromEntries(rows));
  });

  it("SPLIT_STATE_ZONES is exactly the split list in app.client_timezone (0566)", () => {
    const sql = migration("0566_client_timezone_split_zones.sql");
    const found = [...sql.matchAll(/\('([A-Z]{2})', array\[([^\]]+)\]\)/g)].map(
      (m) => [m[1]!, [...m[2]!.matchAll(/'([^']+)'/g)].map((z) => z[1]!)] as const,
    );
    expect(found.length).toBe(Object.keys(SPLIT_STATE_ZONES).length);
    expect(SPLIT_STATE_ZONES).toEqual(Object.fromEntries(found));
  });

  it("the state table is the one in app_state_tz", () => {
    const sql = migration("0310_send_engine.sql");
    const block = sql.slice(
      sql.indexOf("insert into app_state_tz"),
      sql.indexOf("grant select on app_state_tz"),
    );
    for (const m of block.matchAll(/\('([A-Z]{2})','([^']+)'\)/g)) {
      expect(stateTimezone(m[1]!)).toBe(m[2]);
    }
  });
});

describe("merchantTimezone", () => {
  it("a Pensacola number in Florida is Central, not Eastern", () => {
    expect(merchantTimezone("FL", "+18505550100")).toBe("America/Chicago");
    expect(merchantTimezone("FL", "(850) 555-0100")).toBe("America/Chicago");
    expect(merchantTimezone("Florida", "8505550100")).toBe("America/Chicago");
  });

  it("an East Tennessee number in Tennessee is Eastern, not Central", () => {
    expect(merchantTimezone("TN", "+18655550100")).toBe("America/New_York"); // Knoxville
    expect(merchantTimezone("TN", "+14235550100")).toBe("America/New_York"); // Chattanooga
    expect(merchantTimezone("TN", "+16155550100")).toBe("America/Chicago"); // Nashville
  });

  it("El Paso is Mountain although Texas is Central", () => {
    expect(merchantTimezone("TX", "+19155550100")).toBe("America/Denver");
    expect(merchantTimezone("TX", "+12145550100")).toBe("America/Chicago");
  });

  it("an area code from outside the state's zones does not override the state (a Texas address with a New York cell)", () => {
    expect(merchantTimezone("TX", "+12125550100")).toBe("America/Chicago");
    expect(merchantTimezone("FL", "+13105550100")).toBe("America/New_York");
  });

  it("a state that sits in one zone ignores the area code", () => {
    expect(merchantTimezone("GA", "+18505550100")).toBe("America/New_York");
    expect(merchantTimezone("CA", "+12125550100")).toBe("America/Los_Angeles");
  });

  it("no state: the area code decides; neither: unknown, never a guess", () => {
    expect(merchantTimezone("", "+13105550100")).toBe("America/Los_Angeles");
    expect(merchantTimezone("Narnia", "+13105550100")).toBe("America/Los_Angeles");
    expect(merchantTimezone("", "")).toBeNull();
    expect(merchantTimezone("Narnia", "555")).toBeNull();
  });

  it("reads an 11-digit and a 10-digit number the same way", () => {
    expect(merchantTimezone("", "18655550100")).toBe(merchantTimezone("", "8655550100"));
  });
});

describe("quietHours with the merchant's real zone", () => {
  // 01:30 UTC on 2026-10-23 is 9:30 PM in Eastern and 8:30 PM in Central
  const night = new Date("2026-10-23T01:30:00Z");

  it("Pensacola at 8:30 PM Central is not flagged; a state-only table would call it 9:30 PM Eastern and warn", () => {
    expect(quietHours("FL", night)).not.toBeNull(); // no phone: Florida is Eastern
    expect(quietHours("FL", night, { phone: "+18505550100" })).toBeNull();
  });

  it("East Tennessee at 9:30 PM Eastern is flagged; a state-only table would call it 8:30 PM and stay quiet", () => {
    expect(quietHours("TN", night)).toBeNull(); // no phone: Tennessee is Central
    expect(quietHours("TN", night, { phone: "+18655550100" })?.localTime).toBe("9:30 PM");
  });

  it("a zone the page already has wins over everything", () => {
    expect(
      quietHours("FL", night, { timezone: "America/Los_Angeles", phone: "+18505550100" }),
    ).toBeNull(); // 6:30 PM Pacific
    expect(quietHours("TX", night, { timezone: "America/New_York" })?.localTime).toBe("9:30 PM");
  });

  it("an empty zone falls back to the state and phone", () => {
    expect(quietHours("FL", night, { timezone: "", phone: "+18505550100" })).toBeNull();
    expect(quietHours("FL", night, { timezone: null })?.localTime).toBe("9:30 PM");
  });
});
