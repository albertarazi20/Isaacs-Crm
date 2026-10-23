import { describe, expect, it } from "vitest";
import { resolveView, VIEW_COOKIE } from "@/components/board/logic";
import { activeGroupAt, scrolledToEnd } from "@/components/board/whichGroup";
import { normalizeUS, phoneProblem } from "@/lib/mca/phone";

describe("which Board view opens (I-9)", () => {
  it("uses ?view= when it names a view, whatever was remembered", () => {
    expect(resolveView("pipeline", "followups")).toBe("pipeline");
    expect(resolveView("followups", "pipeline")).toBe("followups");
    expect(resolveView("followups", undefined)).toBe("followups");
  });

  it("a bare /board opens the view he used last", () => {
    expect(resolveView(undefined, "followups")).toBe("followups");
    expect(resolveView(undefined, "pipeline")).toBe("pipeline");
  });

  it("falls back to Pipeline when nothing usable is remembered", () => {
    expect(resolveView(undefined, undefined)).toBe("pipeline");
    expect(resolveView(undefined, "")).toBe("pipeline");
    expect(resolveView(undefined, "kanban")).toBe("pipeline");
    expect(resolveView("nonsense", "nonsense")).toBe("pipeline");
  });

  it("a made-up ?view= does not throw away what he last used", () => {
    expect(resolveView("nonsense", "followups")).toBe("followups");
    expect(resolveView(["a", "b"], "followups")).toBe("followups");
  });

  it("the cookie has a stable name the page and the Board agree on", () => {
    expect(VIEW_COOKIE).toBe("isaac_board_view");
  });
});

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

describe("which stage group the phone Board shows (I-20)", () => {
  const edges = [
    { key: "prospecting" as const, left: -900 },
    { key: "underwriting" as const, left: -20 },
    { key: "funded" as const, left: 400 },
    { key: "exit" as const, left: 900 },
  ];

  it("is the last group whose left edge has reached the reach line", () => {
    // Reach 180 (half of a 360px board): Underwriting started 20px off the left, Funded is at 400.
    expect(activeGroupAt(edges, 180, false)).toBe("underwriting");
    // Funded has slid past the middle.
    expect(
      activeGroupAt(
        edges.map((e) => ({ ...e, left: e.left - 300 })),
        180,
        false,
      ),
    ).toBe("funded");
  });

  it("a tab tap that puts a group's left edge at 0 lights that group", () => {
    const tapped = edges.map((e) => ({ ...e, left: e.left + 20 }));
    expect(activeGroupAt(tapped, 180, false)).toBe("underwriting");
    expect(
      activeGroupAt(
        tapped.map((e) => ({ ...e, left: e.left - 420 })),
        180,
        false,
      ),
    ).toBe("funded");
  });

  it("at the start of the board the first group is lit even when nothing has reached the line", () => {
    expect(
      activeGroupAt(
        edges.map((e, i) => ({ ...e, left: 500 + i * 400 })),
        180,
        false,
      ),
    ).toBe("prospecting");
  });

  it("at the very end the last group wins, even a narrow one that never reached the line", () => {
    expect(activeGroupAt(edges, 180, true)).toBe("exit");
  });

  it("no groups, no active group", () => {
    expect(activeGroupAt([], 180, false)).toBeNull();
    expect(activeGroupAt([], 180, true)).toBeNull();
  });
});

describe("scrolledToEnd", () => {
  it("is true only when there was something to scroll and it is all the way right", () => {
    expect(scrolledToEnd(7260, 360, 7620)).toBe(true);
    expect(scrolledToEnd(7259, 360, 7620)).toBe(true); // sub-pixel slack
    expect(scrolledToEnd(7000, 360, 7620)).toBe(false);
    expect(scrolledToEnd(0, 360, 360)).toBe(false); // nothing to scroll
    expect(scrolledToEnd(0, 360, 361)).toBe(false);
  });
});
