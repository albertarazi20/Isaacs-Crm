import { describe, expect, it } from "vitest";
import { normalizeUS, phoneProblem } from "@/lib/mca/phone";

describe("why Call and Text are greyed out (I-11)", () => {
  it("says nothing for a number that can be dialed", () => {
    expect(phoneProblem("(305) 555-0121")).toBeNull();
    expect(phoneProblem("305-555-0121")).toBeNull();
    expect(phoneProblem("+1 305 555 0121")).toBeNull();
  });

  it("an empty phone field says there is no number", () => {
    expect(phoneProblem("")).toMatch(/no phone number on file/i);
    expect(phoneProblem("   ")).toMatch(/no phone number on file/i);
  });

  it("a field with words or too few digits says the number is not usable", () => {
    for (const bad of ["call his cell", "555-0121", "305 555 012", "12345678901234"]) {
      expect(phoneProblem(bad), bad).toMatch(/phone number/i);
      expect(phoneProblem(bad), bad).toMatch(/not a usable/i);
    }
  });

  it("agrees with normalizeUS: a reason exists exactly when the number cannot be dialed", () => {
    for (const raw of [
      "",
      "x",
      "3055550121",
      "13055550121",
      "23055550121",
      "(305) 555-0121 ext 4",
    ]) {
      expect(phoneProblem(raw) === null, raw).toBe(normalizeUS(raw) !== null);
    }
  });
});
