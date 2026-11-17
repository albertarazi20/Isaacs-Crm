import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dnsView } from "@/lib/settings/dnsView";
import { aiPurposeLabel, aiSpendByPurpose } from "@/lib/settings/ai";
import { centsText, pctText } from "@/lib/settings/format";
import { saveAiSettings, saveShopSettings } from "@/lib/settings/mutations";
import { getShopSettings } from "@/lib/settings/queries";
import { aiSchema, shopSchema } from "@/lib/settings/schemas";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The settings controls that finished backends were missing (docs/UI-WIRING.md, Settings). Each test reads the
 * database after the write: a function that returned is not proof the row changed.
 */

let t: TestDb;
let manager: string;
let rep: string;

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
});
afterAll(async () => {
  await t.drop();
});

describe("shop settings", () => {
  it("writes the holiday switch and the cap, and the database holds them", async () => {
    const i = shopSchema.parse({ ...shopForm, sendOnHolidays: true, dailyCap: 1400 });
    await t.db.withUser(manager, (q) => saveShopSettings(q, i));
    expect(await stored()).toMatchObject({ send_on_holidays: true, daily_cap: 1400 });
  });

  it("a form that leaves the holiday switch out keeps what is stored (an older form cannot reset it)", async () => {
    const i = shopSchema.parse({ ...shopForm, dailyCap: 1450 });
    await t.db.withUser(manager, (q) => saveShopSettings(q, i));
    expect(await stored()).toMatchObject({ daily_cap: 1450, send_on_holidays: true });
  });

  it("the holiday switch turns off when the form says false", async () => {
    const i = shopSchema.parse({ ...shopForm, sendOnHolidays: false });
    await t.db.withUser(manager, (q) => saveShopSettings(q, i));
    expect(await stored()).toMatchObject({ send_on_holidays: false });
  });

  it("the read side returns the columns the settings pages show", async () => {
    const s = await t.db.withUser(manager, (q) => getShopSettings(q));
    expect(s).toMatchObject({
      send_on_holidays: false,
      dns_ok: false,
      dns_checked_at: null,
      dns_result: {},
    });
  });

  it("refuses numbers outside the columns' ranges", () => {
    const why = (over: Record<string, unknown>) => shopSchema.safeParse({ ...shopForm, ...over });
    expect(why({ dailyCap: 10 }).success).toBe(false);
    expect(why({ perMerchantDaily: 9 }).success).toBe(false);
    expect(why({ sendWindowEnd: 0 }).success).toBe(false);
    expect(why({}).success).toBe(true);
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
    expect(v.summary).toContain(". Automation waits");
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
    expect(ok.summary).toContain(". Automation may send");
  });
});

describe("AI settings and the spend list", () => {
  it("saves the kill switch, the model and the daily cap, and the database holds them", async () => {
    const form = { aiEnabled: false, aiModel: "claude-opus-5-5", aiDailyCapCents: 1500 };
    await t.db.withUser(manager, (q) => saveAiSettings(q, aiSchema.parse(form)));
    expect(await stored()).toMatchObject({
      ai_enabled: false,
      ai_model: "claude-opus-5-5",
      ai_daily_cap_cents: 1500,
    });
    expect(aiSchema.safeParse({ ...form, aiDailyCapCents: -1 }).success).toBe(false);
  });

  it("groups ai_runs by purpose with today and 30-day cost, biggest spender first", async () => {
    await t.pool.query(
      `insert into ai_runs (purpose, model, prompt_version, input_hash, cost_cents, created_at) values
        ('classify_reply', 'm', 'v1', 'h', 3.5, now()),
        ('classify_reply', 'm', 'v1', 'h', 1.5, now() - interval '5 days'),
        ('split_lead_line', 'm', 'v1', 'h', 0.4, now()),
        ('classify_reply', 'm', 'v1', 'h', 99, now() - interval '60 days')`,
    );
    await t.pool.query(
      "insert into ai_runs (purpose, model, prompt_version, input_hash, error) values ('split_lead_line', 'm', 'v1', 'h', 'timeout')",
    );
    const rows = await t.db.withUser(manager, (q) => aiSpendByPurpose(q));
    const by = Object.fromEntries(rows.map((r) => [r.purpose, r]));
    expect(by.classify_reply).toMatchObject({
      runs_today: 1,
      cents_today: 3.5,
      runs_30d: 2,
      cents_30d: 5,
      label: "Tagging merchant replies",
    });
    expect(by.split_lead_line).toMatchObject({ runs_today: 2, errors_30d: 1 });
    // biggest spender first; the 60-day-old run is outside the window
    expect(rows[0]?.purpose).toBe("classify_reply");
    expect(rows.reduce((n, r) => n + r.cents_30d, 0)).toBeCloseTo(5 + 0.4, 5);
  });

  it("a purpose nobody labelled still reads as words", () => {
    expect(aiPurposeLabel("weekly_digest_draft")).toBe("Weekly digest draft");
  });
  it("shows cents and dollars the way a person reads them", () => {
    expect(centsText(0.4)).toBe("0.40¢");
    expect(centsText(99.9)).toBe("99.90¢");
    expect(centsText(1240)).toBe("$12.40");
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
