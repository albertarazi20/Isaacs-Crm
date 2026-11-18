import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messageSettingsSchema } from "@/lib/messaging/schemas";
import { removeSuppression, saveShopSettings } from "@/lib/settings/mutations";
import { AI_MODELS, aiSchema, shopSchema } from "@/lib/settings/schemas";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let manager: string;

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
const parse = (over: Record<string, unknown>) => shopSchema.safeParse({ ...shopForm, ...over });
const stored = () =>
  t.pool.query("select * from shop_settings").then((r) => r.rows[0] as Record<string, unknown>);

beforeAll(async () => {
  t = await createTestDb();
  manager = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
});
afterAll(async () => {
  await t.drop();
});

describe("shop settings: pairs that silently stop all automated email", () => {
  it("refuses a reserved slice at or above the daily cap", () => {
    expect(parse({ dailyCap: 100, reservedForIntake: 150 }).success).toBe(false);
    expect(parse({ dailyCap: 100, reservedForIntake: 100 }).success).toBe(false);
    expect(parse({ dailyCap: 100, reservedForIntake: 99, amberAt: 90 }).success).toBe(true);
  });
  it("refuses an empty or backwards send window", () => {
    expect(parse({ sendWindowStart: 17, sendWindowEnd: 9 }).success).toBe(false);
    expect(parse({ sendWindowStart: 9, sendWindowEnd: 9 }).success).toBe(false);
    expect(parse({ sendWindowStart: 0, sendWindowEnd: 24 }).success).toBe(true);
  });
  it("refuses an amber warning above the cap and a daily limit above the weekly one", () => {
    expect(parse({ dailyCap: 1000, amberAt: 1200 }).success).toBe(false);
    expect(parse({ perMerchantDaily: 4, perMerchantWeekly: 3 }).success).toBe(false);
  });
});

describe("shop settings: the automation sender", () => {
  it("accepts empty, a bare address and a named address; refuses the rest", () => {
    expect(parse({ automationFrom: "" }).success).toBe(true);
    expect(parse({ automationFrom: "hello@mail.example.com" }).success).toBe(true);
    expect(parse({ automationFrom: "Selective <hello@mail.example.com>" }).success).toBe(true);
    expect(parse({ automationFrom: "hello" }).success).toBe(false);
    expect(parse({ automationFrom: "A <a@mail.example.com>\nBcc: x@y.com" }).success).toBe(false);
  });

  it("a new display name on the same domain keeps a passing DNS check; a new domain clears it", async () => {
    const save = (from: string) =>
      t.db.withUser(manager, (q) =>
        saveShopSettings(q, shopSchema.parse({ ...shopForm, automationFrom: from })),
      );
    await save("Selective <hello@mail.example.com>");
    await t.pool.query(
      "update shop_settings set dns_ok = true, dns_checked_at = now(), dns_result = '{\"ok\": true}'::jsonb",
    );
    await save('"Selective Capital" <hello@mail.example.com>');
    expect(await stored()).toMatchObject({ dns_ok: true, dns_result: { ok: true } });
    await save("Selective <hello@other.example.org>");
    expect(await stored()).toMatchObject({ dns_ok: false, dns_checked_at: null, dns_result: {} });
  });
});

describe("AI settings: the model", () => {
  const ai = {
    aiEnabled: true,
    aiDailyCapCents: 2000,
    brainOn: true,
    brainDailyPerRep: 5,
    playbook: "",
  };
  it("accepts the models the form offers and refuses any other name", () => {
    for (const m of AI_MODELS) expect(aiSchema.safeParse({ ...ai, aiModel: m }).success).toBe(true);
    expect(aiSchema.safeParse({ ...ai, aiModel: "claude-sonet-5-5" }).success).toBe(false);
  });
});

describe("signature", () => {
  it("refuses {fields}, which nothing fills in", () => {
    expect(
      messageSettingsSchema.safeParse({ signature: "Thanks, {sender}", applicationLink: "" })
        .success,
    ).toBe(false);
    expect(
      messageSettingsSchema.safeParse({ signature: "Thanks, Riley", applicationLink: "" }).success,
    ).toBe(true);
  });
});

describe("removing someone from the do-not-email list", () => {
  const suppress = async (clientId: string, reason: string) => {
    // one row per address (unique on the hashed address), so every merchant gets their own
    await t.pool.query("update clients set email = $2 where id = $1", [
      clientId,
      `m-${clientId}@shop.com`,
    ]);
    await t.pool.query("select opt_out($1, 'email', $2, '')", [
      clientId,
      reason === "complaint" ? "complaint" : reason,
    ]);
    return (
      await t.pool.query<{ id: string }>("select id from suppressions where client_id = $1", [
        clientId,
      ])
    ).rows[0]!.id;
  };
  const optOut = async (clientId: string) =>
    (
      await t.pool.query<{ email_opt_out: boolean }>(
        "select email_opt_out from clients where id = $1",
        [clientId],
      )
    ).rows[0]!.email_opt_out;

  it("makes a manually suppressed merchant emailable again (the flag is cleared, not just the row)", async () => {
    const c = await insertClient(t.db, manager, "Manual Cafe");
    const id = await suppress(c, "manual");
    expect(await optOut(c)).toBe(true);
    await t.db.withUser(manager, (q) => removeSuppression(q, id));
    expect((await t.pool.query("select 1 from suppressions where id = $1", [id])).rowCount).toBe(0);
    expect(await optOut(c)).toBe(false);
  });

  it.each([
    ["unsubscribe", /unsubscribed/],
    ["stop_reply", /replied to stop/],
    ["dnc", /do-not-contact/],
  ])(
    "refuses to remove a %s: the row stays and the merchant stays opted out",
    async (reason, msg) => {
      const c = await insertClient(t.db, manager, `Asked ${reason}`);
      const id = await suppress(c, reason);
      expect(await optOut(c)).toBe(true);
      await expect(t.db.withUser(manager, (q) => removeSuppression(q, id))).rejects.toThrow(msg);
      expect((await t.pool.query("select 1 from suppressions where id = $1", [id])).rowCount).toBe(
        1,
      );
      expect(await optOut(c)).toBe(true);
    },
  );

  it("removes a hard bounce row but leaves the opt-out flag as it was", async () => {
    const c = await insertClient(t.db, manager, "Bounce Bakery");
    const id = await suppress(c, "hard_bounce");
    await t.db.withUser(manager, (q) => removeSuppression(q, id));
    expect((await t.pool.query("select 1 from suppressions where id = $1", [id])).rowCount).toBe(0);
    expect(await optOut(c)).toBe(true);
  });

  it("keeps a spam complaint on the list and the merchant opted out", async () => {
    const c = await insertClient(t.db, manager, "Complaint Diner");
    const id = await suppress(c, "complaint");
    await expect(t.db.withUser(manager, (q) => removeSuppression(q, id))).rejects.toThrow(/spam/);
    expect((await t.pool.query("select 1 from suppressions where id = $1", [id])).rowCount).toBe(1);
    expect(await optOut(c)).toBe(true);
  });
});
