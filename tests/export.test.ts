import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/lib/import/csv";
import {
  ACTIVITY_HEADER,
  activityRows,
  CLIENT_HEADER,
  clientRows,
  csvCell,
  toCsv,
} from "../src/lib/export/csv";
import type { ActivityRow, ClientCard } from "../src/lib/data/types";

const card = (over: Partial<ClientCard> = {}): ClientCard =>
  ({
    id: "c1",
    business_name: "Mike's Pizza",
    dba: "",
    contact_name: "Mike Ross",
    phone: "(305) 555-0100",
    email: "mike@pizza.example",
    industry: "Restaurant",
    state: "FL",
    source: "Referral",
    monthly_revenue_cents: null,
    time_in_business_months: null,
    stage: "interested",
    stage_changed_at: "2026-10-01T00:00:00Z",
    application_received_on: null,
    scheduled_call_at: null,
    last_contact_at: null,
    contact_status: "ok",
    contact_status_note: "",
    contact_status_at: null,
    created_at: "2026-09-01T12:00:00Z",
    next_due_on: "2026-10-30",
    next_due_kind: "follow_up",
    last_call_at: "2026-10-20T15:00:00Z",
    last_touch_at: null,
    last_call_note: 'Said "call Friday", wants $50k',
    wanted_amount_cents: 5_000_000,
    wanted_terms: null,
    est_approval_cents: 3_500_050,
    est_approval_note: null,
    position_count: 1,
    position_balance_cents: 1_200_000,
    stips_required: 0,
    stips_received: 0,
    funding_id: null,
    funded_on: null,
    funding_amount_cents: null,
    factor_rate: null,
    funding_payback_cents: null,
    funding_payment_cents: null,
    funding_frequency: null,
    paid_back_override_cents: null,
    funding_status: null,
    defaulted_on: null,
    last_payment_on: null,
    promise_to_pay_at: null,
    promise_amount_cents: null,
    ...over,
  }) as ClientCard;

describe("csvCell", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("plain")).toBe("plain");
  });
  it("renders null and undefined as empty", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(0)).toBe("0");
  });
  it.each(["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tx", "\rx"])(
    "neutralises the formula start %j",
    (v) => {
      expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );
  it("does not touch a dash or plus in the middle", () => {
    expect(csvCell("a-b+c=d")).toBe("a-b+c=d");
  });
});

describe("clients export", () => {
  it("has exactly one value per header column", () => {
    const [row] = clientRows([card()]);
    expect(row).toHaveLength(CLIENT_HEADER.length);
  });
  it("uses MCA words and dollar amounts, and round-trips through the CSV parser", () => {
    const csv = toCsv(CLIENT_HEADER, clientRows([card()]));
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    const [head, row = []] = parseCsv(csv);
    expect(head).toEqual([...CLIENT_HEADER]);
    const at = (name: (typeof CLIENT_HEADER)[number]) => row[CLIENT_HEADER.indexOf(name)];
    expect(at("Business")).toBe("Mike's Pizza");
    expect(at("Wanted ($)")).toBe("50000.00");
    expect(at("Funders would approve ($)")).toBe("35000.50");
    expect(at("Last call note")).toBe('Said "call Friday", wants $50k');
    expect(at("Last call")).toBe("2026-10-20");
    expect(at("Stage")).toBe("Interested");
  });
  it("a hostile business name cannot become a formula", () => {
    const csv = toCsv(
      CLIENT_HEADER,
      clientRows([card({ business_name: '=HYPERLINK("http://x")' })]),
    );
    const [, row = []] = parseCsv(csv);
    expect(row[0]?.startsWith("'=")).toBe(true);
  });
  it("exports an empty list as just the header", () => {
    expect(parseCsv(toCsv(CLIENT_HEADER, []))).toHaveLength(1);
  });
});

describe("activity export", () => {
  const activity = (over: Partial<ActivityRow> = {}): ActivityRow => ({
    id: "a1",
    client_id: "c1",
    kind: "note",
    outcome: null,
    body: "first line\nsecond line",
    from_stage: null,
    to_stage: null,
    occurred_at: "2026-10-20T15:00:00Z",
    ...over,
  });
  it("maps client ids to business names and keeps multi-line notes in one cell", () => {
    const rows = activityRows(
      [activity()],
      new Map([["c1", { name: "Mike's Pizza", trashed: false }]]),
    );
    const [head, row = []] = parseCsv(toCsv(ACTIVITY_HEADER, rows));
    expect(head).toEqual([...ACTIVITY_HEADER]);
    expect(row).toEqual([
      "2026-10-20T15:00:00Z",
      "Mike's Pizza",
      "",
      "note",
      "",
      "first line\nsecond line",
    ]);
  });
  it("keeps a trashed merchant's notes WITH its real name and says it is in the trash", () => {
    const [row] = activityRows(
      [activity()],
      new Map([["c1", { name: "Gone Grill", trashed: true }]]),
    );
    expect(row?.[1]).toBe("Gone Grill");
    expect(row?.[2]).toBe("yes");
  });
});

describe("a stored phone number", () => {
  it("is exported as (305) 555-0101, never with a visible apostrophe", () => {
    const [row] = clientRows([card({ phone: "+13055550101" })]);
    const phone = row?.[CLIENT_HEADER.indexOf("Phone")];
    expect(phone).toBe("(305) 555-0101");
    expect(toCsv(CLIENT_HEADER, [row ?? []])).not.toContain("'+1");
  });
});

describe("the formula guard looks past leading spaces", () => {
  it.each(["  =1+1", " +cmd", "   @SUM(A1)"])("neutralises %j", (v) => {
    expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true);
  });
  it("leaves ordinary text with a space alone", () => {
    expect(csvCell("  Mike's Pizza")).toBe("  Mike's Pizza");
  });
});
