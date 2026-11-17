import { describe, expect, it } from "vitest";
import {
  activityBody,
  centsToInput,
  clientFieldsPayload,
  clientForm,
  countByFilter,
  dateInTz,
  dueTone,
  filterActivities,
  lastCallSummary,
  lastTouchOf,
  rollupOf,
  setStipReceived,
  splitStips,
  type TimelineFilter,
} from "@/components/client/logic";
import type { ActivityRow, ClientCard, StipRow } from "@/lib/data/types";
import { parseMoney } from "@/lib/money";

const TODAY = "2026-10-23";

const kinds: ActivityRow["kind"][] = [
  "note",
  "call",
  "text",
  "email",
  "stage_change",
  "timer",
  "system",
  "note",
];
const rows = kinds.map((kind, i) => ({ kind, id: String(i) }));

describe("timeline filters", () => {
  it("All keeps every row, in order", () => {
    expect(filterActivities(rows, "all").map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });
  it("Notes is only notes", () => {
    expect(filterActivities(rows, "notes").map((r) => r.id)).toEqual(["0", "7"]);
  });
  it("Calls & texts includes emails — they are contact too", () => {
    expect(filterActivities(rows, "contact").map((r) => r.kind)).toEqual(["call", "text", "email"]);
  });
  it("Stage changes is only stage moves", () => {
    expect(filterActivities(rows, "stage").map((r) => r.kind)).toEqual(["stage_change"]);
  });
  it("counts match what each filter shows", () => {
    const counts = countByFilter(rows);
    for (const f of ["all", "notes", "contact", "stage"] as TimelineFilter[]) {
      expect(counts[f]).toBe(filterActivities(rows, f).length);
    }
  });
});

describe("activity bodies", () => {
  it("turns stip keys into the checklist's words", () => {
    expect(activityBody({ kind: "system", body: "Received: bank_statement Jul 2026" })).toBe(
      "Received: Jul 2026 statement",
    );
    expect(activityBody({ kind: "system", body: "Marked missing: voided_check" })).toBe(
      "Marked missing: Voided check",
    );
  });
  it("says merchant where the database trigger wrote client", () => {
    expect(activityBody({ kind: "system", body: "Client added" })).toBe("Merchant added");
    expect(activityBody({ kind: "note", body: "Client added" })).toBe("Client added");
  });
  it("leaves other system and note text alone", () => {
    expect(activityBody({ kind: "system", body: "Added" })).toBe("Added");
    expect(activityBody({ kind: "note", body: "Received: bank_statement Jul 2026" })).toBe(
      "Received: bank_statement Jul 2026",
    );
  });
  it("writes timer dates the way the page does", () => {
    expect(activityBody({ kind: "timer", body: "Follow up set for 2027-01-23" }, TODAY)).toBe(
      "Follow up set for Jan 23, 2027",
    );
    expect(activityBody({ kind: "timer", body: "Follow up set for 2026-11-02 — ask" }, TODAY)).toBe(
      "Follow up set for Nov 2 — ask",
    );
    expect(activityBody({ kind: "timer", body: "Follow up set for 2026-13-45" }, TODAY)).toBe(
      "Follow up set for 2026-13-45",
    );
  });
});

describe("last call and last follow-up", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  it("says so plainly when there was never a call", () => {
    expect(lastCallSummary({ last_call_at: null, last_call_note: null }, now)).toEqual({
      never: true,
    });
  });
  it("gives how long ago and the note", () => {
    const s = lastCallSummary(
      { last_call_at: "2026-10-20T12:00:00Z", last_call_note: "  Wants 60k  " },
      now,
    );
    expect(s).toMatchObject({ never: false, ago: "3 days ago", note: "Wants 60k" });
  });
  it("finds the newest touch whatever the order", () => {
    const touch = lastTouchOf([
      { kind: "note", occurred_at: "2026-10-23T10:00:00Z" },
      { kind: "text", occurred_at: "2026-10-21T10:00:00Z" },
      { kind: "call", occurred_at: "2026-10-19T10:00:00Z" },
      { kind: "email", occurred_at: "2026-10-22T10:00:00Z" },
    ]);
    expect(touch).toEqual({ kind: "email", atIso: "2026-10-22T10:00:00Z" });
    expect(lastTouchOf([{ kind: "note", occurred_at: "2026-10-23T10:00:00Z" }])).toBeNull();
  });
});

describe("dates", () => {
  it("finds the calendar day in Isaac's timezone, not UTC", () => {
    expect(dateInTz("2026-10-24T02:30:00Z", "America/New_York")).toBe("2026-10-23");
    expect(dateInTz("2026-10-24T02:30:00Z", "UTC")).toBe("2026-10-24");
  });
  it("marks overdue, today and later", () => {
    expect(dueTone("2026-10-22", TODAY)).toBe("overdue");
    expect(dueTone(TODAY, TODAY)).toBe("today");
    expect(dueTone("2026-10-24", TODAY)).toBe("later");
  });
});

describe("money in form fields", () => {
  it("prints whole dollars plainly and cents with two digits", () => {
    expect(centsToInput(5_000_000)).toBe("50000");
    expect(centsToInput(5_012_345)).toBe("50123.45");
    expect(centsToInput(5_000_005)).toBe("50000.05");
    expect(centsToInput(0)).toBe("0");
    expect(centsToInput(null)).toBe("");
    expect(centsToInput(undefined)).toBe("");
  });
  it("round-trips through parseMoney", () => {
    for (const cents of [
      0, 1, 99, 100, 101, 12_345, 5_000_000, 5_012_345, 123_456_789, 999_999_901,
    ]) {
      expect(parseMoney(centsToInput(cents))).toBe(cents);
    }
  });
});

const stip = (over: Partial<StipRow>): StipRow => ({
  id: "s",
  kind: "bank_statement",
  period: null,
  required: true,
  received_at: null,
  ...over,
});

describe("stips", () => {
  const list = [
    stip({ id: "v", kind: "voided_check" }),
    stip({ id: "aug", period: "2026-08-01" }),
    stip({ id: "dl", kind: "drivers_license" }),
    stip({ id: "app", kind: "signed_application" }),
    stip({ id: "jul", period: "2026-07-01", received_at: "2026-10-01T00:00:00Z" }),
    stip({ id: "tax", kind: "tax_return", required: false }),
  ];
  it("orders the checklist application, statements oldest first, ID, check — required before optional", () => {
    const { required, optional } = splitStips(list);
    expect(required.map((s) => s.id)).toEqual(["app", "jul", "aug", "dl", "v"]);
    expect(optional.map((s) => s.id)).toEqual(["tax"]);
  });
  it("rolls up required items only and names what is missing", () => {
    const r = rollupOf(list);
    expect(r).toMatchObject({ requiredTotal: 5, requiredReceived: 1, ready: false });
    expect(r.missing).toEqual(
      expect.arrayContaining(["Aug 2026 statement", "Voided check", "Signed application"]),
    );
  });
  it("is ready when every required stip is in, even with optional ones open", () => {
    const done = list.map((s) => (s.required ? { ...s, received_at: "2026-10-02T00:00:00Z" } : s));
    expect(rollupOf(done)).toMatchObject({ ready: true, missing: [] });
  });
  it("flips one stip optimistically without touching the others or the input", () => {
    const next = setStipReceived(list, "aug", true, "2026-10-23T00:00:00Z");
    expect(next.find((s) => s.id === "aug")?.received_at).toBe("2026-10-23T00:00:00Z");
    expect(next.find((s) => s.id === "v")?.received_at).toBeNull();
    expect(list.find((s) => s.id === "aug")?.received_at).toBeNull();
    const back = setStipReceived(next, "aug", false, "x");
    expect(back.find((s) => s.id === "aug")?.received_at).toBeNull();
  });
  it("keeps the original received time when ticked twice", () => {
    const next = setStipReceived(list, "jul", true, "2026-10-23T00:00:00Z");
    expect(next.find((s) => s.id === "jul")?.received_at).toBe("2026-10-01T00:00:00Z");
  });
});

describe("client forms", () => {
  it("round-trips the client details form, blank date becoming null", () => {
    const card = {
      business_name: "Rivera Auto Repair",
      dba: "",
      contact_name: "Tony Rivera",
      phone: "(305) 555-0121",
      email: "t@example.com",
      industry: "Auto",
      state: "FL",
      source: "",
      monthly_revenue_cents: 8_500_000,
      time_in_business_months: 42,
      application_received_on: null,
    } as ClientCard;
    const form = clientForm(card);
    expect(form.monthlyRevenue).toBe("85000");
    expect(form.timeInBusinessMonths).toBe("42");
    expect(form.applicationReceivedOn).toBe("");
    expect(clientFieldsPayload(form)).toMatchObject({
      businessName: "Rivera Auto Repair",
      monthlyRevenue: "85000",
      applicationReceivedOn: null,
    });
    expect(
      clientFieldsPayload({ ...form, applicationReceivedOn: "2026-10-01" }).applicationReceivedOn,
    ).toBe("2026-10-01");
  });
});
