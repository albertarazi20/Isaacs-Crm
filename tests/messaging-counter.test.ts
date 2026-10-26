import { describe, expect, it } from "vitest";
import {
  bumpTextCount,
  readTextCount,
  TEXT_COUNT_KEY,
  TEXT_WARN_AT,
  textCountMessage,
  textCountWarning,
  type CounterStorage,
} from "@/lib/messaging/textCounter";

function fake(
  initial: Record<string, string> = {},
): CounterStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe("the soft text counter", () => {
  it("counts up through the day", () => {
    const s = fake();
    expect(readTextCount(s, "2026-10-23")).toBe(0);
    expect(bumpTextCount(s, "2026-10-23")).toBe(1);
    expect(bumpTextCount(s, "2026-10-23")).toBe(2);
    expect(readTextCount(s, "2026-10-23")).toBe(2);
    expect(JSON.parse(s.data[TEXT_COUNT_KEY] ?? "null")).toEqual({ date: "2026-10-23", n: 2 });
  });
  it("starts over on a new day", () => {
    const s = fake();
    for (let i = 0; i < 7; i += 1) bumpTextCount(s, "2026-10-23");
    expect(readTextCount(s, "2026-10-23")).toBe(7);
    expect(readTextCount(s, "2026-10-24")).toBe(0);
    expect(bumpTextCount(s, "2026-10-24")).toBe(1);
  });
  it("survives garbage in storage", () => {
    for (const raw of [
      "",
      "nope",
      "{}",
      '{"date":"2026-10-23"}',
      '{"date":"2026-10-23","n":-4}',
      '{"date":"2026-10-23","n":"x"}',
      "null",
      "[]",
    ]) {
      const s = fake({ [TEXT_COUNT_KEY]: raw });
      expect(readTextCount(s, "2026-10-23"), raw).toBe(0);
      expect(bumpTextCount(s, "2026-10-23"), raw).toBe(1);
    }
  });
  it("copes with no storage at all, and with a store that throws", () => {
    expect(readTextCount(null, "2026-10-23")).toBe(0);
    expect(bumpTextCount(null, "2026-10-23")).toBe(1);
    const broken: CounterStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readTextCount(broken, "2026-10-23")).toBe(0);
    expect(bumpTextCount(broken, "2026-10-23")).toBe(1);
  });
  it("says the count in plain words", () => {
    expect(textCountMessage(0)).toBe("0 texts today");
    expect(textCountMessage(1)).toBe("1 text today");
    expect(textCountMessage(7)).toBe("7 texts today");
  });
  it("warns gently from 15 and not before", () => {
    expect(TEXT_WARN_AT).toBe(15);
    expect(textCountWarning(14)).toBeNull();
    const w = textCountWarning(15) ?? "";
    expect(w).toContain("15 texts today");
    expect(w).toContain("Google Voice");
    expect(textCountWarning(40)).toContain("40 texts today");
  });
});
