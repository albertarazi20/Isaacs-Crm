import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/auth/session";
import { setBucketDailyTemplate } from "@/lib/buckets/daily";
import { listBuckets } from "@/lib/buckets/queries";
import { listSequences } from "@/lib/followup/bucketBoard";
import { minuteLabel, minuteToTime, timeToMinute } from "@/lib/settings/format";
import { saveShopSettings } from "@/lib/settings/mutations";
import { getShopSettings } from "@/lib/settings/queries";
import { shopSchema } from "@/lib/settings/schemas";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The daily reminder's settings side (0593), read back from the DATABASE: the shop's reminder time (kept when a form
 * leaves it out, refused outside 6:00 AM to 8:00 PM, audited) and a bucket's daily template (set, cleared, manager
 * only, refused when the engine may not send it, every live member made due again when it changes).
 */

const jar = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "isaac_session" && jar.token ? { value: jar.token } : undefined,
    delete: () => undefined,
  }),
  headers: async () =>
    new Headers({ "user-agent": "vitest", "x-nf-client-connection-ip": "203.0.113.9" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const SECRET = "s".repeat(40);
const NOWHERE = "00000000-0000-4000-8000-000000000000";
let t: TestDb;
let boss: string;
let rep: string;
let shared: string;
let repsOwn: string;
let other: string;
let okTemplate: string;
let otherTemplate: string;

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
const minute = async () =>
  (await t.pool.query<{ m: number }>("select daily_reminder_minute as m from shop_settings"))
    .rows[0]?.m;
const bucketRow = async (id: string) =>
  (
    await t.pool.query<{ daily_template_id: string | null }>(
      "select daily_template_id from buckets where id = $1",
      [id],
    )
  ).rows[0];
const as = async (userId: string, email: string, role: "rep" | "manager") => {
  jar.token = await signSession({ userId, email, role, epoch: 0 }, SECRET);
};
const addBucket = async (name: string, owner: string | null) =>
  (
    await t.pool.query<{ id: string }>(
      "insert into buckets (name, owner_id, rule, sort) values ($1, $2, 'manual', 100) returning id",
      [name, owner],
    )
  ).rows[0]!.id;
const addTemplate = async (
  name: string,
  o: { owner?: string | null; approved?: boolean; archived?: boolean } = {},
) =>
  (
    await t.pool.query<{ id: string }>(
      "insert into templates (owner_id, name, subject, body, approved, archived, created_by) values ($1, $2, 'Quick reminder', 'Hi {first_name}, still interested?', $3, $4, $5) returning id",
      [o.owner ?? null, name, o.approved ?? true, o.archived ?? false, boss],
    )
  ).rows[0]!.id;
const addMember = async (bucketId: string, name: string, stopped = false) => {
  const c = (
    await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Mike', '3055550100', $3, 'FL') returning id",
      [rep, name, `${name.replace(/\W/g, "").toLowerCase()}@example.com`],
    )
  ).rows[0]!.id;
  await t.pool.query(
    "insert into enrollments (user_id, client_id, bucket_id, next_step, next_due_on, stopped_at) values ($1, $2, $3, 3, current_date + 9, $4)",
    [rep, c, bucketId, stopped ? new Date() : null],
  );
  return c;
};
const enrollments = async (bucketId: string) =>
  (
    await t.pool.query<{
      business_name: string;
      next_step: number;
      next_due_on: string;
      live: boolean;
    }>(
      `select c.business_name, e.next_step, e.next_due_on::text as next_due_on, e.stopped_at is null as live
         from enrollments e join clients c on c.id = e.client_id where e.bucket_id = $1 order by c.business_name`,
      [bucketId],
    )
  ).rows;
const setFuture = (bucketId: string) =>
  t.pool.query(
    "update enrollments set next_step = 3, next_due_on = current_date + 9 where bucket_id = $1 and stopped_at is null",
    [bucketId],
  );
const dayFromToday = async (n: number) =>
  (await t.pool.query<{ d: string }>("select (current_date + $1::int)::text as d", [n])).rows[0]!.d;
const events = async () =>
  (
    await t.pool.query<{ kind: string; user_id: string; detail: Record<string, unknown> }>(
      "select kind, user_id, detail from audit_events order by at, id",
    )
  ).rows;

beforeAll(async () => {
  t = await createTestDb();
  process.env.DATABASE_URL = (
    t.pool as unknown as { options: { connectionString: string } }
  ).options.connectionString;
  process.env.SESSION_SECRET = SECRET;
  process.env.APP_URL = "http://localhost:3000";
  process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString("base64");
  boss = await insertUser(t.pool, "boss@x.com");
  rep = await insertUser(t.pool, "rep@x.com");
  await t.pool.query("update app_users set role = 'manager', name = 'Pat Boss' where id = $1", [
    boss,
  ]);
  shared = await addBucket("Daily chase", null);
  other = await addBucket("Other shared", null);
  repsOwn = await addBucket("Rita's own", rep);
  okTemplate = await addTemplate("Daily nudge");
  otherTemplate = await addTemplate("Second nudge", { owner: rep, approved: true });
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});
beforeEach(async () => {
  jar.token = "";
  await t.pool.query("delete from audit_events");
});

describe("the shop's daily reminder time", () => {
  it("starts at 10:00 AM (600) and the read side returns it", async () => {
    expect(await minute()).toBe(600);
    expect((await t.db.withUser(boss, (q) => getShopSettings(q))).daily_reminder_minute).toBe(600);
  });

  it("a save with the time changes the stored value", async () => {
    await t.db.withUser(boss, (q) =>
      saveShopSettings(q, shopSchema.parse({ ...shopForm, dailyReminderMinute: 455 })),
    );
    expect(await minute()).toBe(455);
  });

  it("a form that leaves it out keeps the stored value, whatever else it changes", async () => {
    await t.db.withUser(boss, (q) =>
      saveShopSettings(q, shopSchema.parse({ ...shopForm, dailyCap: 1400 })),
    );
    expect(await minute()).toBe(455);
    expect((await t.pool.query("select daily_cap from shop_settings")).rows[0].daily_cap).toBe(
      1400,
    );
  });

  it("takes the edges, 6:00 AM and 8:00 PM", async () => {
    for (const m of [360, 1200]) {
      await t.db.withUser(boss, (q) =>
        saveShopSettings(q, shopSchema.parse({ ...shopForm, dailyReminderMinute: m })),
      );
      expect(await minute()).toBe(m);
    }
  });

  it("refuses 0, 1300 and the other values outside 360 to 1200, naming the field in plain words", () => {
    for (const bad of [0, 359, 1201, 1300, -5, 600.5, Number.NaN]) {
      const r = shopSchema.safeParse({ ...shopForm, dailyReminderMinute: bad });
      expect(r.success, String(bad)).toBe(false);
      expect(r.error?.issues[0]?.message).toBe(
        "Daily reminder time must be between 6:00 AM and 8:00 PM.",
      );
      expect(r.error?.issues[0]?.path).toEqual(["dailyReminderMinute"]);
    }
  });

  it("the database itself refuses a value outside the range too", async () => {
    await expect(
      t.pool.query("update shop_settings set daily_reminder_minute = 1300"),
    ).rejects.toThrow();
    await expect(
      t.pool.query("update shop_settings set daily_reminder_minute = 0"),
    ).rejects.toThrow();
    expect(await minute()).toBe(1200);
  });

  it("through the real action: a bad time saves nothing and writes no audit line", async () => {
    const { saveShopSettingsAction } = await import("@/app/settings-actions");
    await as(boss, "boss@x.com", "manager");
    for (const bad of [0, 1300]) {
      const r = await saveShopSettingsAction({ ...shopForm, dailyReminderMinute: bad });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("Daily reminder time");
    }
    expect(await minute()).toBe(1200);
    expect(await events()).toEqual([]);
  });

  it("through the real action: a good time is stored and the audit line says the time changed (numbers only)", async () => {
    const { saveShopSettingsAction } = await import("@/app/settings-actions");
    await as(boss, "boss@x.com", "manager");
    expect((await saveShopSettingsAction({ ...shopForm, dailyReminderMinute: 570 })).ok).toBe(true);
    expect(await minute()).toBe(570);
    const line = (await events()).find((e) => e.kind === "settings_shop_saved");
    expect(line?.user_id).toBe(boss);
    expect(line?.detail).toMatchObject({
      changed: expect.arrayContaining(["daily_reminder_minute"]),
      values: { daily_reminder_minute: { from: 1200, to: 570 } },
    });
  });

  it("a rep's write changes nothing (row-level security)", async () => {
    await t.db
      .withUser(rep, (q) =>
        saveShopSettings(q, shopSchema.parse({ ...shopForm, dailyReminderMinute: 700 })),
      )
      .catch(() => undefined);
    expect(await minute()).toBe(570);
  });

  it("the form's time converts to minutes and back, and reads in words", () => {
    expect(minuteToTime(600)).toBe("10:00");
    expect(minuteToTime(365)).toBe("06:05");
    expect(timeToMinute("10:00")).toBe(600);
    expect(timeToMinute("20:00")).toBe(1200);
    expect(timeToMinute("")).toBe(0);
    expect(minuteLabel(600)).toBe("10:00 AM");
    expect(minuteLabel(1200)).toBe("8:00 PM");
    expect(minuteLabel(750)).toBe("12:30 PM");
  });
});

describe("a bucket's daily reminder template", () => {
  let a: string;
  let elsewhere: string;
  let queuedStep: string;
  let queuedOther: string;
  const status = async (id: string) =>
    (await t.pool.query("select status, skip_reason from outbox where id = $1", [id])).rows[0];

  beforeAll(async () => {
    a = await addMember(shared, "Alpha Tacos");
    await addMember(shared, "Bravo Bakery");
    await addMember(shared, "Gone Grill", true);
    elsewhere = await addMember(other, "Elsewhere Cafe");
    await addMember(repsOwn, "Rita Deli");
    const ob = (client: string, source: string) =>
      t.pool
        .query<{ id: string }>(
          "insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body) values ($1, $2, 'sequence', $3, 'x@example.com', 's', 'b') returning id",
          [rep, client, source],
        )
        .then((r) => r.rows[0]!.id);
    queuedStep = await ob(a, `bucket:${shared}:step:2`);
    queuedOther = await ob(elsewhere, `bucket:${other}:step:2`);
  });

  it("a manager sets it: the column holds it, live members are due again, step rows cancelled, others untouched", async () => {
    const r = await t.db.withUser(boss, (q) =>
      setBucketDailyTemplate(q, { bucketId: shared, templateId: okTemplate }),
    );
    expect(r).toEqual({ changed: true, reset: 2 });
    expect((await bucketRow(shared))?.daily_template_id).toBe(okTemplate);
    const yesterday = await dayFromToday(-1);
    const nine = await dayFromToday(9);
    expect(await enrollments(shared)).toEqual([
      { business_name: "Alpha Tacos", next_step: 1, next_due_on: yesterday, live: true },
      { business_name: "Bravo Bakery", next_step: 1, next_due_on: yesterday, live: true },
      { business_name: "Gone Grill", next_step: 3, next_due_on: nine, live: false },
    ]);
    expect(await enrollments(other)).toEqual([
      { business_name: "Elsewhere Cafe", next_step: 3, next_due_on: nine, live: true },
    ]);
    // the old step list's queued email is taken back; another bucket's stays queued
    expect(await status(queuedStep)).toEqual({ status: "cancelled", skip_reason: "stopped" });
    expect(await status(queuedOther)).toEqual({ status: "queued", skip_reason: null });
  });

  it("the bucket list and the board read it as a daily bucket", async () => {
    const rows = await t.db.withUser(boss, (q) => listBuckets(q, true));
    expect(rows.find((x) => x.id === shared)).toMatchObject({
      daily_template_id: okTemplate,
      daily_template_name: "Daily nudge",
      daily_reminder_minute: 570,
    });
    expect(rows.find((x) => x.id === other)).toMatchObject({
      daily_template_id: null,
      daily_template_name: null,
    });
    const seq = await t.db.withUser(boss, (q) => listSequences(q));
    expect(seq[shared]).toEqual([
      expect.objectContaining({
        step_no: 1,
        action: "email",
        template_name: "Daily nudge",
        daily: true,
        daily_minute: 570,
      }),
    ]);
  });

  it("saving the same template again changes nothing: nobody is reset", async () => {
    await setFuture(shared);
    const r = await t.db.withUser(boss, (q) =>
      setBucketDailyTemplate(q, { bucketId: shared, templateId: okTemplate }),
    );
    expect(r).toEqual({ changed: false, reset: 0 });
    expect((await enrollments(shared)).filter((e) => e.live).map((e) => e.next_step)).toEqual([
      3, 3,
    ]);
  });

  it("a different template resets the live members again", async () => {
    const r = await t.db.withUser(boss, (q) =>
      setBucketDailyTemplate(q, { bucketId: shared, templateId: otherTemplate }),
    );
    expect(r.reset).toBe(2);
    expect((await bucketRow(shared))?.daily_template_id).toBe(otherTemplate);
    expect((await enrollments(shared)).filter((e) => e.live).map((e) => e.next_step)).toEqual([
      1, 1,
    ]);
  });

  it("clearing it just empties the column: the step list is back and nobody is reset", async () => {
    await setFuture(shared);
    const r = await t.db.withUser(boss, (q) =>
      setBucketDailyTemplate(q, { bucketId: shared, templateId: null }),
    );
    expect(r).toEqual({ changed: true, reset: 0 });
    expect((await bucketRow(shared))?.daily_template_id).toBeNull();
    expect((await enrollments(shared)).filter((e) => e.live).map((e) => e.next_step)).toEqual([
      3, 3,
    ]);
    const seq = await t.db.withUser(boss, (q) => listSequences(q));
    expect(seq[shared]).toBeUndefined();
  });

  it("a rep cannot, not even on their own bucket: nothing changes (function and real action)", async () => {
    await expect(
      t.db.withUser(rep, (q) =>
        setBucketDailyTemplate(q, { bucketId: repsOwn, templateId: okTemplate }),
      ),
    ).rejects.toThrow("Only a manager");
    expect((await bucketRow(repsOwn))?.daily_template_id).toBeNull();
    expect((await enrollments(repsOwn)).map((e) => e.next_step)).toEqual([3]);
    const { setBucketDailyTemplateAction } = await import("@/app/buckets-actions");
    await as(rep, "rep@x.com", "rep");
    const r = await setBucketDailyTemplateAction({ bucketId: repsOwn, templateId: okTemplate });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("Only a manager");
    expect((await bucketRow(repsOwn))?.daily_template_id).toBeNull();
    expect((await enrollments(repsOwn)).map((e) => e.next_step)).toEqual([3]);
  });

  it("a manager can set it on a rep's own bucket through the real action, and clear it again", async () => {
    const { setBucketDailyTemplateAction } = await import("@/app/buckets-actions");
    await as(boss, "boss@x.com", "manager");
    expect(
      (await setBucketDailyTemplateAction({ bucketId: repsOwn, templateId: okTemplate })).ok,
    ).toBe(true);
    expect((await bucketRow(repsOwn))?.daily_template_id).toBe(okTemplate);
    expect((await enrollments(repsOwn)).map((e) => e.next_step)).toEqual([1]);
    expect((await setBucketDailyTemplateAction({ bucketId: repsOwn, templateId: null })).ok).toBe(
      true,
    );
    expect((await bucketRow(repsOwn))?.daily_template_id).toBeNull();
  });

  it("refuses a template the engine may not send (archived, unapproved private, missing): the column and members are untouched", async () => {
    const archived = await addTemplate("Old nudge", { archived: true });
    const unapproved = await addTemplate("Draft nudge", { owner: rep, approved: false });
    const attempt = (templateId: string) =>
      t.db.withUser(boss, (q) => setBucketDailyTemplate(q, { bucketId: other, templateId }));
    await expect(attempt(archived)).rejects.toThrow("can't be sent on its own");
    await expect(attempt(unapproved)).rejects.toThrow("can't be sent on its own");
    await expect(attempt(NOWHERE)).rejects.toThrow("not found");
    expect((await bucketRow(other))?.daily_template_id).toBeNull();
    expect(await enrollments(other)).toEqual([
      {
        business_name: "Elsewhere Cafe",
        next_step: 3,
        next_due_on: await dayFromToday(9),
        live: true,
      },
    ]);
    expect(await status(queuedOther)).toEqual({ status: "queued", skip_reason: null });
    // and through the action the refusal reaches the person in words
    const { setBucketDailyTemplateAction } = await import("@/app/buckets-actions");
    await as(boss, "boss@x.com", "manager");
    const r = await setBucketDailyTemplateAction({ bucketId: other, templateId: unapproved });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("waiting for a manager's approval");
    expect((await bucketRow(other))?.daily_template_id).toBeNull();
  });

  it("refuses a bucket that does not exist", async () => {
    await expect(
      t.db.withUser(boss, (q) =>
        setBucketDailyTemplate(q, { bucketId: NOWHERE, templateId: okTemplate }),
      ),
    ).rejects.toThrow("Bucket not found");
  });

  it("a template deleted later empties the column (on delete set null)", async () => {
    const gone = await addTemplate("Short lived");
    await t.db.withUser(boss, (q) =>
      setBucketDailyTemplate(q, { bucketId: other, templateId: gone }),
    );
    expect((await bucketRow(other))?.daily_template_id).toBe(gone);
    await t.pool.query("delete from templates where id = $1", [gone]);
    expect((await bucketRow(other))?.daily_template_id).toBeNull();
  });
});
