import { describe, expect, it } from "vitest";
import { passcodeMatches } from "../src/lib/auth/passcode";
import { firstAllowedEmail, parseEnv } from "../src/lib/env";

describe("passcode sign-in", () => {
  it("matches only the exact passcode", () => {
    expect(passcodeMatches("correct horse battery", "correct horse battery")).toBe(true);
    expect(passcodeMatches("correct horse batterY", "correct horse battery")).toBe(false);
    expect(passcodeMatches("", "correct horse battery")).toBe(false);
  });
  it("acts as the first allowed address, lowercased", () => {
    expect(firstAllowedEmail(" Isaac@X.com , b@y.com")).toBe("isaac@x.com");
    expect(firstAllowedEmail("")).toBeUndefined();
  });
  it("rejects a short ACCESS_PASSCODE, treats blank as unset", () => {
    const base = { DATABASE_URL: "postgres://x", SESSION_SECRET: "s".repeat(32) };
    expect(() => parseEnv({ ...base, ACCESS_PASSCODE: "short" })).toThrow(/ACCESS_PASSCODE/);
    expect(parseEnv({ ...base, ACCESS_PASSCODE: "  " }).ACCESS_PASSCODE).toBeUndefined();
  });
});
