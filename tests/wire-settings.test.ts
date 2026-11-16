import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dnsView } from "@/lib/settings/dnsView";
import { aiPurposeLabel, aiSpendByPurpose } from "@/lib/settings/ai";
import { centsText, pctText } from "@/lib/settings/format";
import {
  saveAiSettings,
  saveDocumentRetention,
  saveRegistration,
  saveShopSettings,
} from "@/lib/settings/mutations";
import { getShopSettings } from "@/lib/settings/queries";
import { aiSchema, registrationSchema, retentionSchema, shopSchema } from "@/lib/settings/schemas";
import { listStateLines, renewalTone } from "@/lib/settings/states";
import {
  getStatementDoc,
  listClosedMonths,
  monthLabel,
  statementHtml,
} from "@/lib/settings/statements";
import { policyAcceptance, recentTrustAlerts, trustAlertKey } from "@/lib/settings/trust";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The settings controls that finished backends were missing (docs/UI-WIRING.md, Settings). Each test reads the
 * database after the write: a function that returned is not proof the row changed.
 */

let t: TestDb;
let manager: string;
let rep: string;
let rep2: string;

const shopForm = {
  shopName: "Selective Capital",
  postalAddress: "1 Main St, Miami FL 33101",
  dailyCap: 1500,
  amberAt: 1200,
  reservedForIntake: 150,
  sequencesEnabled: true,
  sendWindowStart: 9,
  sendWindowEnd: 11,
  sendOnWeekends: false,
  perMerchantDaily: 1,
  perMerchantWeekly: 3,
  automationFrom: "",
  automationReplyToRep: true,
  lenderChaseDays: 3,
  lenderChaseMode: "send" as const,
  lenderChaseMax: 2,
  maxLendersPerDeal: 2,
};
const stored = () =>
  t.pool.query("select * from shop_settings").then((r) => r.rows[0] as Record<string, unknown>);

beforeAll(async () => {
  t = await createTestDb();
  manager = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
  rep = await insertUser(t.pool, "rep@x.com");
  await t.pool.query("update app_users set name = 'Riley Rep' where id = $1", [rep]);
  rep2 = await insertUser(t.pool, "rep2@x.com");
  await t.pool.query("update app_users set name = 'Sam Second' where id = $1", [rep2]);
});
afterAll(async () => {
  await t.drop();
});

describe("shop settings: the new fields", () => {
  it("writes the deals inbox, the two day counts, the holiday switch and chase mode draft", async () => {
    const i = shopSchema.parse({
      ...shopForm,
      sendOnHolidays: true,
      lenderChaseMode: "draft",
      approvalValidDays: "21",
      resubmitBlockDays: "45",
      dealsInboxAddress: "  Deals@Mail.SelectiveCap.com ",
    });
    await t.db.withUser(manager, (q) => saveShopSettings(q, i));
    const row = await stored();
    expect(row).toMatchObject({
      send_on_holidays: true,
      lender_chase_mode: "draft",
      approval_valid_days: 21,
      resubmit_block_days: 45,
      deals_inbox_address: "deals@mail.selectivecap.com",
    });
  });

  it("a form that leaves the newer fields out keeps what is stored (an older form cannot reset them)", async () => {
    const i = shopSchema.parse({ ...shopForm, dailyCap: 1400 });
    await t.db.withUser(manager, (q) => saveShopSettings(q, i));
    const row = await stored();
    expect(row).toMatchObject({
      daily_cap: 1400,
      send_on_holidays: true,
      approval_valid_days: 21,
      resubmit_block_days: 45,
      deals_inbox_address: "deals@mail.selectivecap.com",
    });
  });

  it("an empty deals inbox clears it, and the holiday switch turns off when the form says false", async () => {
    const i = shopSchema.parse({ ...shopForm, sendOnHolidays: false, dealsInboxAddress: "" });
    await t.db.withUser(manager, (q) => saveShopSettings(q, i));
    expect(await stored()).toMatchObject({ send_on_holidays: false, deals_inbox_address: "" });
  });

  it("the read side returns every new column", async () => {
    const s = await t.db.withUser(manager, (q) => getShopSettings(q));
    expect(s).toMatchObject({
      send_on_holidays: false,
      approval_valid_days: 21,
      resubmit_block_days: 45,
      deals_inbox_address: "",
      dns_ok: false,
      dns_checked_at: null,
      dns_result: {},
      document_retention_days: 730,
      winback_opener_mode: "review",
      lender_chase_mode: "send", // the last form to save said send; the draft write is in the first test
    });
  });

  it("refuses numbers outside the columns' ranges, in words, and a deals inbox that is not one address", () => {
    const why = (over: Record<string, unknown>) => {
      const r = shopSchema.safeParse({ ...shopForm, ...over });
      return r.success ? null : r.error.issues[0]?.message;
    };
    expect(why({ approvalValidDays: "0" })).toBe("Approval validity is at least 1 day");
    expect(why({ approvalValidDays: "400" })).toBe("Approval validity is at most 365 days");
    expect(why({ resubmitBlockDays: "-1" })).toBe("The double-submission window can't be negative");
    expect(why({ resubmitBlockDays: "0" })).toBeNull(); // 0 turns the block off
    expect(why({ lenderChaseMode: "shout" })).not.toBeNull();
    expect(why({ dealsInboxAddress: "deals@x.com, ops@x.com" })).toMatch(/one email address/);
    expect(why({ dealsInboxAddress: "not an address" })).toMatch(/one email address/);
    // a blank number box means "not sent", not zero
    expect(
      shopSchema.parse({ ...shopForm, approvalValidDays: "" }).approvalValidDays,
    ).toBeUndefined();
  });

  it("a rep's write changes nothing (row-level security)", async () => {
    await t.db
      .withUser(rep, (q) => saveShopSettings(q, shopSchema.parse({ ...shopForm, dailyCap: 777 })))
      .catch(() => undefined);
    expect((await stored()).daily_cap).toBe(1500);
  });
});

describe("the DNS card's view of the stored check", () => {
  const base = {
    automation_from: "Selective <hello@mail.selectivecap.com>",
    dns_ok: false,
    dns_checked_at: null as string | null,
    dns_result: {},
  };
  it("says so when there is no automation sender, and when nothing was checked", () => {
    expect(dnsView({ ...base, automation_from: "" })).toMatchObject({
      state: "no_domain",
      domain: "",
      lines: [],
    });
    expect(dnsView(base)).toMatchObject({
      state: "unchecked",
      domain: "mail.selectivecap.com",
      checkedAt: null,
    });
  });
  it("lists SPF, DKIM and DMARC with what was found, and the time it was checked", () => {
    const v = dnsView({
      ...base,
      dns_checked_at: "2026-11-16T15:00:00Z",
      dns_result: {
        domain: "mail.selectivecap.com",
        spf: { ok: true, record: "v=spf1 include:amazonses.com ~all" },
        dkim: { ok: false, selector: null },
        dmarc: { ok: true, record: "v=DMARC1; p=none", host: "_dmarc.selectivecap.com" },
        ok: false,
        checkedAt: "2026-11-16T15:00:00Z",
      },
    });
    expect(v.state).toBe("failed");
    expect(v.checkedAt).toBe("2026-11-16T15:00:00Z");
    expect(v.lines.map((l) => [l.label, l.ok])).toEqual([
      ["SPF", true],
      ["DKIM", false],
      ["DMARC", true],
    ]);
    expect(v.lines[0]?.detail).toContain("v=spf1");
    expect(v.summary).toContain("DKIM missing");
    expect(v.summary).toContain("automation waits");
  });
  it("is verified only when the stored flag is", () => {
    const ok = dnsView({
      ...base,
      dns_ok: true,
      dns_checked_at: "2026-11-16T15:00:00Z",
      dns_result: {
        domain: "mail.selectivecap.com",
        spf: { ok: true, record: "v=spf1 -all" },
        dkim: { ok: true, selector: "resend" },
        dmarc: { ok: true, record: "v=DMARC1; p=none", host: "_dmarc.mail.selectivecap.com" },
        ok: true,
        checkedAt: "2026-11-16T15:00:00Z",
      },
    });
    expect(ok.state).toBe("ok");
    expect(ok.summary).toContain("automation may send");
  });
});

describe("AI settings: the opener mode and the spend list", () => {
  it("saves the win-back opener mode and leaves it alone when the form does not send it", async () => {
    const form = {
      aiEnabled: true,
      aiModel: "claude-opus-5-5",
      aiDailyCapCents: 2000,
      aiAutoApplyLowStakes: true,
    };
    await t.db.withUser(manager, (q) =>
      saveAiSettings(q, aiSchema.parse({ ...form, winbackOpenerMode: "auto" })),
    );
    expect((await stored()).winback_opener_mode).toBe("auto");
    await t.db.withUser(manager, (q) =>
      saveAiSettings(q, aiSchema.parse({ ...form, aiDailyCapCents: 1500 })),
    );
    expect(await stored()).toMatchObject({ winback_opener_mode: "auto", ai_daily_cap_cents: 1500 });
    expect(aiSchema.safeParse({ ...form, winbackOpenerMode: "maybe" }).success).toBe(false);
  });

  it("groups ai_runs by purpose with today and 30-day cost, newest purposes included", async () => {
    await t.pool.query(
      `insert into ai_runs (purpose, model, prompt_version, input_hash, cost_cents, created_at) values
        ('read_lender_email', 'm', 'v1', 'h', 3.5, now()),
        ('read_lender_email', 'm', 'v1', 'h', 1.5, now() - interval '5 days'),
        ('ask_deal', 'm', 'v1', 'h', 12, now()),
        ('split_lead_line', 'm', 'v1', 'h', 0.4, now()),
        ('transcribe_offer_image', 'm', 'v1', 'h', 40, now() - interval '2 days'),
        ('read_lender_email', 'm', 'v1', 'h', 99, now() - interval '60 days')`,
    );
    await t.pool.query(
      "insert into ai_runs (purpose, model, prompt_version, input_hash, error) values ('classify_reply', 'm', 'v1', 'h', 'timeout')",
    );
    const rows = await t.db.withUser(manager, (q) => aiSpendByPurpose(q));
    const by = Object.fromEntries(rows.map((r) => [r.purpose, r]));
    expect(by.read_lender_email).toMatchObject({
      runs_today: 1,
      cents_today: 3.5,
      runs_30d: 2,
      cents_30d: 5,
      label: "Reading lender email",
    });
    expect(by.ask_deal).toMatchObject({
      runs_today: 1,
      cents_today: 12,
      label: "Questions about a deal",
    });
    expect(by.transcribe_offer_image).toMatchObject({ runs_today: 0, runs_30d: 1, cents_30d: 40 });
    expect(by.classify_reply).toMatchObject({ errors_30d: 1 });
    // biggest spender first; the 60-day-old run is outside the window
    expect(rows[0]?.purpose).toBe("transcribe_offer_image");
    expect(rows.reduce((n, r) => n + r.cents_30d, 0)).toBeCloseTo(40 + 12 + 5 + 0.4, 5);
  });

  it("a purpose nobody labelled still reads as words", () => {
    expect(aiPurposeLabel("weekly_digest_draft")).toBe("Weekly digest draft");
    expect(aiPurposeLabel("draft_winback")).toBe("Win-back opening lines");
  });
  it("shows cents and dollars the way a person reads them", () => {
    expect(centsText(0.4)).toBe("0.40¢");
    expect(centsText(99.9)).toBe("99.90¢");
    expect(centsText(1240)).toBe("$12.40");
  });
});

describe("document retention", () => {
  it("is written, and refused outside 30 to 3650 days", async () => {
    await t.db.withUser(manager, (q) =>
      saveDocumentRetention(q, retentionSchema.parse({ days: "365" })),
    );
    expect((await stored()).document_retention_days).toBe(365);
    const why = (days: unknown) => {
      const r = retentionSchema.safeParse({ days });
      return r.success ? null : r.error.issues[0]?.message;
    };
    expect(why("29")).toBe("Keep documents at least 30 days");
    expect(why("3651")).toBe("Ten years (3650 days) is the longest");
    expect(why("abc")).not.toBeNull();
    expect(why("30")).toBeNull();
  });
});

describe("state registrations", () => {
  it("lists every rule with the shop's registration beside it (none yet)", async () => {
    const lines = await t.db.withUser(manager, (q) => listStateLines(q));
    const tx = lines.find((l) => l.state === "TX");
    expect(tx).toMatchObject({
      name: "Texas",
      broker_registration: true,
      status: null,
      renews_on: null,
    });
    expect(lines.length).toBeGreaterThanOrEqual(10);
  });

  it("adds a registration, then edits its renewal date: the row in the table changes, not a copy", async () => {
    await t.db.withUser(manager, (q) =>
      saveRegistration(
        q,
        registrationSchema.parse({
          state: "tx",
          status: "registered",
          registrationNo: "OCCC-1",
          renewsOn: "2027-03-01",
          note: "bond filed",
        }),
      ),
    );
    let r = (await t.pool.query("select * from shop_registrations where state = 'TX'")).rows;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      status: "registered",
      registration_no: "OCCC-1",
      note: "bond filed",
    });
    expect(String(r[0].renews_on)).toContain("2027");

    await t.db.withUser(manager, (q) =>
      saveRegistration(
        q,
        registrationSchema.parse({
          state: "TX",
          status: "registered",
          registrationNo: "OCCC-1",
          renewsOn: "2027-09-15",
        }),
      ),
    );
    r = (await t.pool.query("select renews_on::text as d, note from shop_registrations")).rows;
    expect(r).toHaveLength(1);
    expect(r[0].d).toBe("2027-09-15");
    expect(r[0].note).toBe("");
    const lines = await t.db.withUser(manager, (q) => listStateLines(q));
    expect(lines.find((l) => l.state === "TX")).toMatchObject({
      status: "registered",
      renews_on: "2027-09-15",
    });
  });

  it("clears a renewal date when the box is emptied", async () => {
    await t.db.withUser(manager, (q) =>
      saveRegistration(
        q,
        registrationSchema.parse({
          state: "TX",
          status: "filed",
          registrationNo: "",
          renewsOn: "",
        }),
      ),
    );
    const r = (await t.pool.query("select status, renews_on from shop_registrations")).rows[0];
    expect(r).toMatchObject({ status: "filed", renews_on: null });
  });

  it("refuses a state with no rules in plain words, and a date that is not a date", async () => {
    await expect(
      t.db.withUser(manager, (q) =>
        saveRegistration(q, registrationSchema.parse({ state: "ZZ", status: "registered" })),
      ),
    ).rejects.toThrow(/no rules on file for ZZ/);
    const bad = registrationSchema.safeParse({
      state: "TX",
      status: "registered",
      renewsOn: "2027-02-31",
    });
    expect(bad.success ? null : bad.error.issues[0]?.message).toBe(
      "The renewal date must be a real date",
    );
    expect(registrationSchema.safeParse({ state: "Texas", status: "registered" }).success).toBe(
      false,
    );
    expect(registrationSchema.safeParse({ state: "TX", status: "pending" }).success).toBe(false);
  });

  it("a rep cannot write one (row-level security)", async () => {
    const before = (await t.pool.query("select * from shop_registrations")).rows;
    await t.db
      .withUser(rep, (q) =>
        saveRegistration(q, registrationSchema.parse({ state: "FL", status: "registered" })),
      )
      .catch(() => undefined);
    expect((await t.pool.query("select * from shop_registrations")).rows).toEqual(before);
  });

  it("says how close a renewal is, in days", () => {
    expect(renewalTone(null, "2026-11-16")).toEqual({ tone: "neutral", text: "no date" });
    expect(renewalTone("2026-11-10", "2026-11-16")).toEqual({
      tone: "bad",
      text: "lapsed 6 days ago",
    });
    expect(renewalTone("2026-11-15", "2026-11-16")).toEqual({
      tone: "bad",
      text: "lapsed 1 day ago",
    });
    expect(renewalTone("2026-11-16", "2026-11-16")).toEqual({ tone: "warn", text: "renews today" });
    expect(renewalTone("2026-12-16", "2026-11-16")).toEqual({
      tone: "warn",
      text: "renews in 30 days",
    });
    expect(renewalTone("2026-12-17", "2026-11-16")).toEqual({
      tone: "good",
      text: "renews in 31 days",
    });
  });
});

describe("month-end statements", () => {
  let st1: string;
  let st2: string;
  const line = (business: string, rep_cents: number, extra: object = {}) => ({
    id: 1,
    funding_id: "f",
    kind: "expected",
    gross_cents: rep_cents * 2,
    rep_cents,
    house_cents: rep_cents,
    note: "",
    business,
    funder: "Pearl",
    funded_on: "2026-10-12",
    created_at: "2026-10-12T15:00:00Z",
    ...extra,
  });

  beforeAll(async () => {
    await t.pool.query(
      "insert into commission_closes (period, closed_by, line_count, gross_cents, rep_cents, house_cents) values ('2026-10-01', $1, 3, 600000, 300000, 300000), ('2026-09-01', $1, 0, 0, 0, 0)",
      [manager],
    );
    const ins = (user: string, n: number, g: number, rp: number, h: number, lines: object[]) =>
      t.pool
        .query<{ id: string }>(
          "insert into commission_statements (period, user_id, line_count, gross_cents, rep_cents, house_cents, lines) values ('2026-10-01', $1, $2, $3, $4, $5, $6::jsonb) returning id",
          [user, n, g, rp, h, JSON.stringify(lines)],
        )
        .then((r) => r.rows[0]!.id);
    st1 = await ins(rep, 2, 400000, 200000, 200000, [
      line("Mike's <Pizza> & Sons", 150000),
      line("Corner Deli", 50000, { kind: "correction", note: "terms fixed" }),
    ]);
    st2 = await ins(rep2, 1, 200000, 100000, 100000, [line("Dry Cleaners", 100000)]);
  });

  it("lists the closed months newest first with each person's statement under them", async () => {
    const months = await t.db.withUser(manager, (q) => listClosedMonths(q));
    expect(months.map((m) => [m.period, m.label])).toEqual([
      ["2026-10-01", "October 2026"],
      ["2026-09-01", "September 2026"],
    ]);
    expect(months[0]).toMatchObject({ line_count: 3, gross_cents: 600000, rep_cents: 300000 });
    expect(months[0]?.statements.map((s) => [s.name, s.rep_cents])).toEqual([
      ["Riley Rep", 200000],
      ["Sam Second", 100000],
    ]);
    expect(months[1]?.statements).toEqual([]);
  });

  it("a rep sees only their own statement; a manager sees everyone's", async () => {
    const mine = await t.db.withUser(rep, (q) => listClosedMonths(q));
    expect(mine[0]?.statements.map((s) => s.id)).toEqual([st1]);
    expect(await t.db.withUser(rep, (q) => getStatementDoc(q, st2))).toBeNull();
    expect(await t.db.withUser(rep, (q) => getStatementDoc(q, st1))).not.toBeNull();
    expect(await t.db.withUser(manager, (q) => getStatementDoc(q, st2))).not.toBeNull();
  });

  it("the printable page carries the lines and totals, and escapes what a merchant name could inject", async () => {
    const doc = await t.db.withUser(manager, (q) => getStatementDoc(q, st1));
    expect(doc).toMatchObject({
      label: "October 2026",
      person: "Riley Rep",
      gross_cents: 400000,
      rep_cents: 200000,
    });
    const html = statementHtml(doc!, "Selective Capital");
    expect(html).toContain("Commission statement — October 2026");
    expect(html).toContain("Riley Rep");
    expect(html).toContain("Mike's &lt;Pizza&gt; &amp; Sons");
    expect(html).not.toContain("<Pizza>");
    expect(html).toContain("Correction");
    expect(html).toContain("terms fixed");
    expect(html).toContain("$4,000.00"); // gross total
    expect(html).toContain("$2,000.00"); // rep total
    expect(html).toContain("2 lines");
    expect(html).toContain("window.print()");
    expect(html).not.toMatch(/#[0-9a-f]{3,6}\b/i); // plain colours by name, no hex
  });

  it("names the month", () => {
    expect(monthLabel("2026-01-01")).toBe("January 2026");
    expect(monthLabel("2026-12-01")).toBe("December 2026");
  });
});

describe("team & trust", () => {
  it("knows who has accepted the policy and who has not", async () => {
    await t.db.withUser(rep, (q) => q.query("select accept_policy()"));
    const p = await t.db.withUser(manager, (q) => policyAcceptance(q));
    expect(p[rep]).not.toBeNull();
    expect(p[rep2]).toBeNull();
    expect(p[manager]).toBeNull();
  });

  it("maps each spelling of a trust alert to one of the four patterns", () => {
    expect(trustAlertKey("trust", "trust:canary:abc:def")).toBe("canary");
    expect(trustAlertKey("trust", "trust:others:u:c")).toBe("others");
    expect(trustAlertKey("trust", "trust:copies:u:2026-11-16-14")).toBe("copies");
    expect(trustAlertKey("trust", "trust:after_hours:u:2026-11-15")).toBe("after_hours");
    expect(trustAlertKey("copy_burst", null)).toBe("copies");
    expect(trustAlertKey("canary_touched", null)).toBe("canary");
    expect(trustAlertKey("trust", "trust:mystery:x")).toBeNull();
    expect(trustAlertKey("stale_deal", "stale_deal:1")).toBeNull();
  });

  it("lists the manager's own trust alerts and leaves every other kind out", async () => {
    await t.pool.query(
      `insert into user_alerts (user_id, kind, title, href, dedupe_key, created_at) values
        ($1, 'trust', 'Riley copied contact details 25 times in the last hour', '/settings/team', 'trust:copies:x:1', now()),
        ($1, 'trust', 'Canary touched: Riley opened Canary Co', '/clients/1', 'trust:canary:c:u', now() - interval '2 days'),
        ($1, 'stale_deal', 'Deal sitting too long', '/deals', 'stale:1', now()),
        ($1, 'trust', 'Too old', '', 'trust:copies:x:0', now() - interval '45 days'),
        ($2, 'trust', 'Another manager only', '', 'trust:copies:y:1', now())`,
      [manager, rep],
    );
    const a = await t.db.withUser(manager, (q) => recentTrustAlerts(q, 30));
    expect(a.map((x) => [x.key, x.title])).toEqual([
      ["copies", "Riley copied contact details 25 times in the last hour"],
      ["canary", "Canary touched: Riley opened Canary Co"],
    ]);
  });
});

describe("number formats", () => {
  it("rates read with one decimal under ten percent and none above", () => {
    expect(pctText(0)).toBe("0%");
    expect(pctText(0.084)).toBe("8.4%");
    expect(pctText(0.0049)).toBe("0.5%");
    expect(pctText(0.2)).toBe("20%");
    expect(pctText(0.1)).toBe("10%");
  });
});
