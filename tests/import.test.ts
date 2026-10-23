import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/import/csv";
import {
  buildRows,
  guessMapping,
  isDoNotContact,
  parseLooseDate,
  parseStageWord,
} from "@/lib/import/map";

const TODAY = "2026-10-23";

describe("csv parser", () => {
  it("handles quotes, escaped quotes, commas and newlines inside fields", () => {
    const rows = parseCsv(
      'name,notes\n"Mike\'s, Pizza","said ""call later""\nsecond line"\nBob,ok\n',
    );
    expect(rows).toEqual([
      ["name", "notes"],
      ["Mike's, Pizza", 'said "call later"\nsecond line'],
      ["Bob", "ok"],
    ]);
  });
  it("copes with CRLF, a BOM, blank lines and a missing final newline", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n\r\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });
  it("keeps empty fields", () => {
    expect(parseCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
  it("refuses a file with an unterminated quote instead of silently eating the rest", () => {
    expect(() => parseCsv('a,b\n"oops,1')).toThrow(/never closes/);
  });
});

describe("column guessing", () => {
  it("recognises the usual headers in any case and punctuation", () => {
    const m = guessMapping([
      "Business Name",
      "Owner",
      "Cell Phone",
      "E-mail",
      "Amount Wanted",
      "Last Call Notes",
      "Status",
      "Next Follow-Up",
    ]);
    expect(m).toMatchObject({
      businessName: 0,
      contactName: 1,
      phone: 2,
      email: 3,
      wantedAmount: 4,
      notes: 5,
      stage: 6,
      followUpOn: 7,
    });
  });
  it("treats a lone 'Name' column as the business, not the contact", () => {
    const m = guessMapping(["Name", "Phone"]);
    expect(m.businessName).toBe(0);
    expect(m.contactName).toBeNull();
  });
  it("leaves unknown columns unmapped", () => {
    expect(guessMapping(["Foo", "Bar"]).businessName).toBeNull();
  });
});

describe("loose dates and statuses", () => {
  it.each([
    ["2026-11-02", "2026-11-02"],
    ["11/2/2026", "2026-11-02"],
    ["3/9/27", "2027-03-09"],
    ["13/40/2026", null],
    ["soon", null],
    ["", null],
  ])("date %j → %j", (raw, iso) => {
    expect(parseLooseDate(raw)).toBe(iso);
  });
  it("maps the words an MCA sheet uses to stages", () => {
    expect(parseStageWord("Interested").stage).toBe("interested");
    expect(parseStageWord("App Sent").stage).toBe("application_sent");
    expect(parseStageWord("Declined").stage).toBe("declined");
    expect(parseStageWord("Dead").stage).toBe("dead");
    expect(parseStageWord("Not Interested").stage).toBe("not_interested");
    expect(parseStageWord("Lost deal").stage).toBe("lost");
    expect(parseStageWord("Paid in full").stage).toBe("paid_in_full");
  });
  it("refuses to import Funded or defaults as-is, since they need terms", () => {
    expect(parseStageWord("Funded")).toEqual({ stage: null, unsupported: true });
    expect(parseStageWord("Default")).toEqual({ stage: null, unsupported: true });
    expect(parseStageWord("")).toEqual({ stage: null, unsupported: false });
  });
});

describe("building import rows", () => {
  const headers = ["Business", "Owner", "Phone", "Amount", "Status", "Follow up", "Notes"];
  const map = guessMapping(headers);
  const opts = { today: TODAY, spreadDays: 3 };

  it("spreads undated rows over the next N days so day one isn't a wall", () => {
    const recs = [1, 2, 3, 4, 5, 6, 7].map((n) => [
      `Biz ${n}`,
      "",
      `30555500${String(n).padStart(2, "0")}`,
      "",
      "",
      "",
      "",
    ]);
    const { rows } = buildRows(recs, map, opts);
    expect(rows.map((r) => r.followUpOn)).toEqual([
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-24",
    ]);
  });
  it("uses a sheet's follow-up date, clamps the past to today and the far future to 36 months", () => {
    const { rows, problems } = buildRows(
      [
        ["A", "", "3055550001", "", "", "11/05/2026", ""],
        ["B", "", "3055550002", "", "", "1/1/2020", ""],
        ["C", "", "3055550003", "", "", "2031-01-01", ""],
      ],
      map,
      opts,
    );
    expect(rows.map((r) => r.followUpOn)).toEqual(["2026-11-05", TODAY, "2029-10-23"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toMatch(/36 months/);
  });
  it("skips rows with no business name and says which line", () => {
    const { rows, problems } = buildRows([["", "Mike", "3055550001", "", "", "", ""]], map, opts);
    expect(rows).toEqual([]);
    expect(problems).toEqual([{ line: 2, message: "No business name" }]);
  });
  it("keeps a row whose phone is unusable but drops the number, and warns", () => {
    const { rows, problems } = buildRows([["A", "", "555-1234", "", "", "", ""]], map, opts);
    expect(rows[0]?.phone).toBe("");
    expect(problems[0]?.message).toMatch(/isn't a US phone number/);
  });
  it("drops a repeated phone number within the file and counts it", () => {
    const { rows, duplicatesInFile } = buildRows(
      [
        ["A", "", "(305) 555-0001", "", "", "", ""],
        ["A again", "", "305-555-0001", "", "", "", ""],
      ],
      map,
      opts,
    );
    expect(rows).toHaveLength(1);
    expect(duplicatesInFile).toBe(1);
  });
  it("imports Funded as Name in with a note, never as a fake advance", () => {
    const { rows } = buildRows([["A", "", "3055550001", "", "Funded", "", ""]], map, opts);
    expect(rows[0]).toMatchObject({ stage: "name_in", statusNote: "Imported status: Funded" });
  });
  it("normalises phones, keeps good stages and valid amounts, and drops junk amounts with a warning", () => {
    const { rows, problems } = buildRows(
      [
        ["A", "Mike", "(305) 555-0001", "50k", "Interested", "", "wants it fast"],
        ["B", "", "3055550002", "lots", "", "", ""],
      ],
      map,
      opts,
    );
    expect(rows[0]).toMatchObject({
      phone: "+13055550001",
      wantedAmount: "50k",
      stage: "interested",
      notes: "wants it fast",
    });
    expect(rows[1]?.wantedAmount).toBe("");
    expect(problems[0]?.message).toMatch(/isn't an amount/);
  });

  it("never imports a do-not-contact row as a lead, and says how many it held back", () => {
    const { rows, problems, doNotContact } = buildRows(
      [
        ["Keep Me", "", "3055550001", "", "Interested", "", ""],
        ["Stop Me", "", "3055550002", "", "DNC", "", ""],
        ["Stop Me Too", "", "3055550003", "", "", "", "asked us not to call again - Do Not Call"],
        ["Also Out", "", "3055550004", "", "Do not contact", "", ""],
      ],
      map,
      opts,
    );
    expect(rows.map((r) => r.businessName)).toEqual(["Keep Me"]);
    expect(doNotContact).toBe(3);
    expect(problems.filter((p) => /do-not-contact/.test(p.message))).toHaveLength(3);
  });
});

describe("do-not-contact detection", () => {
  it.each([
    "DNC",
    "do not call",
    "Do Not Contact",
    "don't text me",
    "STOP CALLING",
    "unsubscribe",
    "cease and desist",
  ])("catches %j", (w) => {
    expect(isDoNotContact(w)).toBe(true);
  });
  it.each(["Interested", "Not interested", "Declined", "called, no answer", "dead", "Funded"])(
    "leaves %j alone",
    (w) => {
      expect(isDoNotContact(w)).toBe(false);
    },
  );
  it("'not interested' is still a normal exit stage", () => {
    expect(parseStageWord("Not Interested").stage).toBe("not_interested");
  });
});

describe("where a merchant came from", () => {
  const header = ["Business", "Phone", "Lead Source"];
  const opts = { today: TODAY, spreadDays: 3 };

  it("finds a source column under the names lead lists use", () => {
    for (const name of ["Source", "Lead Source", "Origin", "Campaign", "List Name", "Vendor"]) {
      const m = guessMapping(["Business", "Phone", name]);
      expect(m.source, name).toBe(2);
    }
  });
  it("a sheet's own source wins over the list name typed in", () => {
    const m = guessMapping(header);
    const { rows } = buildRows(
      [
        ["Alpha", "3055550001", "Referral"],
        ["Beta", "3055550002", ""],
      ],
      m,
      { ...opts, defaultSource: "Vendor Oct 2026" },
    );
    expect(rows.map((r) => r.source)).toEqual(["Referral", "Vendor Oct 2026"]);
  });
  it("uses the list name for every row when the sheet has no source column", () => {
    const m = guessMapping(["Business", "Phone"]);
    const { rows } = buildRows([["Alpha", "3055550001"]], m, {
      ...opts,
      defaultSource: "  Vendor Oct 2026 ",
    });
    expect(rows[0]?.source).toBe("Vendor Oct 2026");
  });
  it("stays blank when there is neither (the writer then says Imported)", () => {
    const m = guessMapping(["Business", "Phone"]);
    expect(buildRows([["Alpha", "3055550001"]], m, opts).rows[0]?.source).toBe("");
  });
});

describe("values too long for the server are cut, not allowed to sink the whole import", () => {
  const m = guessMapping(["Business", "Phone", "Source", "Notes"]);
  const opts = { today: TODAY, spreadDays: 3 };
  it("cuts a 150-character source to 100 and says which line", () => {
    const { rows, problems } = buildRows([["Alpha", "3055550001", "s".repeat(150), ""]], m, opts);
    expect(rows[0]?.source).toHaveLength(100);
    expect(problems).toEqual([
      { line: 2, message: '"Where they came from" is longer than 100 characters — cut to fit' },
    ]);
  });
  it("reports each cut value once, even though it is read more than once", () => {
    const { problems } = buildRows([["Alpha", "3055550001", "", "n".repeat(6000)]], m, opts);
    expect(problems.filter((p) => p.message.includes("Notes"))).toHaveLength(1);
  });
  it("turns line breaks in a one-line field into spaces", () => {
    const { rows } = buildRows(
      [["Alpha\nDiner", "3055550001", "Lead\tvendor\r\nOct", ""]],
      m,
      opts,
    );
    expect(rows[0]?.businessName).toBe("Alpha Diner");
    expect(rows[0]?.source).toBe("Lead vendor Oct");
  });
  it("keeps the line breaks in notes", () => {
    const { rows } = buildRows([["Alpha", "3055550001", "", "line one\nline two"]], m, opts);
    expect(rows[0]?.notes).toBe("line one\nline two");
  });
  it("leaves ordinary values alone", () => {
    const { rows, problems } = buildRows([["Alpha", "3055550001", "Referral", "fine"]], m, opts);
    expect(rows[0]).toMatchObject({ businessName: "Alpha", source: "Referral", notes: "fine" });
    expect(problems).toEqual([]);
  });
});
