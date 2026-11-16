import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/auth/session";
import { runBucketSteps } from "@/lib/buckets/engine";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The page controls' server actions, called the way the browser calls them: a signed session cookie, the real action,
 * then the DATABASE read back. Paste a lead line (the model is scripted), the cross-rep owner line, the manager's
 * override and the pause with a date.
 */

const jar = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "isaac_session" && jar.token ? { value: jar.token } : undefined,
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

// the model: scripted per test; the key is whatever the test says (the server's own env() is cached after first use)
const fake = vi.hoisted(() => ({
  key: undefined as string | undefined,
  split: {} as Record<string, string>,
  calls: 0,
}));
vi.mock("@/lib/env", async (orig) => {
  const m = await orig<typeof import("@/lib/env")>();
  return { ...m, env: () => ({ ...m.env(), ANTHROPIC_API_KEY: fake.key }) };
});
vi.mock("@/lib/ai/splitLeadLine", async (orig) => {
  const m = await orig<typeof import("@/lib/ai/splitLeadLine")>();
  return {
    ...m,
    splitLeadLine: async (_text: string, opts: { model?: string } = {}) => {
      fake.calls += 1;
      return {
        result: { ...BLANK, ...fake.split },
        model: opts.model ?? "m",
        inputTokens: 200,
        outputTokens: 80,
        inputHash: "h",
      };
    },
  };
});
const BLANK = {
  first_name: "",
  last_name: "",
  business_name: "",
  phone: "",
  phone2: "",
  email: "",
  email2: "",
  industry: "",
  state: "",
  wanted_amount: "",
  looking_for: "",
  notes: "",
};

const SECRET = "s".repeat(40);
let t: TestDb;
let mike: string;
let dana: string;
let boss: string;
let statements: string;
let harbor: string;
let actions: typeof import("@/app/intake-actions");
let buckets: typeof import("@/app/buckets-actions");

const as = async (id: string, email: string, role: "rep" | "manager") => {
  jar.token = await signSession({ userId: id, email, role, epoch: 0 }, SECRET);
};
const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await t.pool.query<T>(sql, params)).rows[0];

beforeAll(async () => {
  t = await createTestDb();
  const url = new URL(
    (t.pool as unknown as { options: { connectionString: string } }).options.connectionString,
  );
  process.env.DATABASE_URL = url.toString();
  process.env.SESSION_SECRET = SECRET;
  process.env.APP_URL = "https://crm.test";
  mike = await insertUser(t.pool, "mike@x.com");
  dana = await insertUser(t.pool, "dana@x.com");
  boss = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set name = 'Mike Jones' where id = $1", [mike]);
  await t.pool.query("update app_users set name = 'Dana Lee' where id = $1", [dana]);
  await t.pool.query("update app_users set role = 'manager', name = 'Pat Boss' where id = $1", [
    boss,
  ]);
  statements = (await one<{ id: string }>(
    "select id from buckets where key = 'missing_statements'",
  ))!.id;
  harbor = (await one<{ id: string }>(
    "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Harbor Tacos', 'Rosa Diaz', '3105550199', 'rosa@harbortacos.com', 'CA') returning id",
    [mike],
  ))!.id;
  await t.pool.query("select enroll_in_bucket($1, $2)", [harbor, statements]);
  await t.pool.query(
    "update activities set occurred_at = now() - interval '3 days' where client_id = $1",
    [harbor],
  );
  actions = await import("@/app/intake-actions");
  buckets = await import("@/app/buckets-actions");
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});
beforeEach(() => {
  fake.key = undefined;
  fake.split = {};
  fake.calls = 0;
});

describe("paste a lead line: the action behind the box", () => {
  const LINE =
    "Rosa Lind, Harbor Tacos, (310) 555-0142, rosa@harbortacos.com, CA, wants 60k for a truck";

  it("refuses with no model key, in words, and never calls the model", async () => {
    await as(dana, "dana@x.com", "rep");
    const r = await actions.splitLeadLineAction({ text: LINE });
    expect(r).toEqual({ ok: false, error: "The assistant is not set up on this server" });
    expect(fake.calls).toBe(0);
  });

  it("refuses when the assistant is switched off in Settings, or over today's budget", async () => {
    fake.key = "sk-test";
    await as(dana, "dana@x.com", "rep");
    await t.pool.query("update shop_settings set ai_enabled = false");
    expect(await actions.splitLeadLineAction({ text: LINE })).toEqual({
      ok: false,
      error: "The assistant is switched off in Settings",
    });
    await t.pool.query("update shop_settings set ai_enabled = true, ai_daily_cap_cents = 0");
    expect(await actions.splitLeadLineAction({ text: LINE })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/used today's budget/),
    });
    await t.pool.query("update shop_settings set ai_daily_cap_cents = 500");
    expect(fake.calls).toBe(0);
  });

  it("fills the fields and logs the run in ai_runs", async () => {
    fake.key = "sk-test";
    fake.split = {
      first_name: "Rosa",
      last_name: "Lind",
      business_name: "Harbor Tacos",
      phone: "(310) 555-0142",
      email: "rosa@harbortacos.com",
      state: "ca",
      wanted_amount: "60k",
      looking_for: "a truck",
    };
    await as(dana, "dana@x.com", "rep");
    const before = (await one<{ n: number }>("select count(*)::int as n from ai_runs"))!.n;
    const r = await actions.splitLeadLineAction({ text: LINE });
    expect(r).toMatchObject({
      ok: true,
      data: { fields: { first_name: "Rosa", phone: "(310) 555-0142", state: "CA" } },
    });
    const run = await one<{ purpose: string; n: number }>(
      "select purpose, (select count(*)::int from ai_runs) as n from ai_runs order by created_at desc limit 1",
    );
    expect(run).toEqual({ purpose: "split_lead_line", n: before + 1 });
  });

  it("refuses a phone the text does not contain; nothing is logged", async () => {
    fake.key = "sk-test";
    fake.split = { first_name: "Rosa", phone: "3105550100" };
    await as(dana, "dana@x.com", "rep");
    const before = (await one<{ n: number }>("select count(*)::int as n from ai_runs"))!.n;
    expect(await actions.splitLeadLineAction({ text: LINE })).toEqual({
      ok: false,
      error: "The split did not match what was pasted: the phone 3105550100 is not in the text",
    });
    expect((await one<{ n: number }>("select count(*)::int as n from ai_runs"))!.n).toBe(before);
  });
});

describe("the duplicate warning: whose merchant is it", () => {
  it("a rep is told the server's line and nothing more", async () => {
    await as(dana, "dana@x.com", "rep");
    const r = await actions.leadOwnerAction({ phone: "(310) 555-0199", email: "" });
    expect(r).toEqual({
      ok: true,
      data: {
        owner: {
          line: "Already in the system: Mike's lead, in Missing statements, touched 3 days ago",
          matchedOn: "phone",
          clientId: null,
          businessName: null,
        },
        canOverride: false,
      },
    });
    // by email alone, too
    const byEmail = await actions.leadOwnerAction({ phone: "", email: "ROSA@harbortacos.com" });
    expect(byEmail).toMatchObject({ ok: true, data: { owner: { matchedOn: "email" } } });
  });

  it("a manager also gets the merchant to open, and may override", async () => {
    await as(boss, "boss@x.com", "manager");
    const r = await actions.leadOwnerAction({ phone: "3105550199", email: "" });
    expect(r).toMatchObject({
      ok: true,
      data: { owner: { clientId: harbor, businessName: "Harbor Tacos" }, canOverride: true },
    });
  });

  it("the owner's own merchant, and a number nobody has, are not a cross-rep case", async () => {
    await as(mike, "mike@x.com", "rep");
    expect(await actions.leadOwnerAction({ phone: "3105550199", email: "" })).toMatchObject({
      ok: true,
      data: { owner: null },
    });
    expect(await actions.leadOwnerAction({ phone: "7185550111", email: "" })).toMatchObject({
      ok: true,
      data: { owner: null },
    });
  });
});

describe("the manager's override on submit", () => {
  const lead = { businessName: "Harbor Tacos II", phone: "310-555-0199", firstName: "Rosa" };
  const rowsFor = async () =>
    (
      await t.pool.query<{ user_id: string }>(
        "select user_id from clients where right(regexp_replace(phone, '\\D', '', 'g'), 10) = '3105550199' order by created_at",
      )
    ).rows.map((r) => r.user_id);

  it("a rep cannot override, and a rep without it is refused with the owner line; nothing is written", async () => {
    await as(dana, "dana@x.com", "rep");
    expect(await actions.intakeLeadAction({ ...lead, override: true })).toEqual({
      ok: false,
      error: "Only a manager can add a lead another rep already has",
    });
    expect(await actions.intakeLeadAction(lead)).toEqual({
      ok: false,
      error: "Already in the system: Mike's lead, in Missing statements, touched 3 days ago",
    });
    expect(await rowsFor()).toEqual([mike]);
  });

  it("a manager without the override gets the ordinary duplicate outcome; with it, the lead is added to their book", async () => {
    await as(boss, "boss@x.com", "manager");
    const plain = await actions.intakeLeadAction(lead);
    expect(plain).toMatchObject({
      ok: true,
      data: { result: "duplicate", clientId: harbor, existing: { ownerName: "Mike Jones" } },
    });
    expect(await rowsFor()).toEqual([mike]);
    const forced = await actions.intakeLeadAction({ ...lead, override: true });
    expect(forced).toMatchObject({ ok: true, data: { result: "created" } });
    expect(await rowsFor()).toEqual([mike, boss]);
  });
});

describe("pause until a date", () => {
  let merchant: string;
  let today: string;
  let day: string;
  const enrol = async () =>
    one<{ paused: boolean; resume_on: string | null }>(
      "select paused, resume_on::text from enrollments where client_id = $1 and stopped_at is null",
      [merchant],
    );

  beforeAll(async () => {
    merchant = (await one<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Golden Wok', 'David Chen', '2125550182', 'd@gw.com', 'NY') returning id",
      [dana],
    ))!.id;
    await t.pool.query("select enroll_in_bucket($1, $2)", [merchant, statements]);
    today = t.today;
    day = addDays(today, 10);
  });

  it("refuses a day that is not after today, one too far out, and a date on a resume", async () => {
    await as(dana, "dana@x.com", "rep");
    for (const [until, want] of [
      [today, "Pick a day after today"],
      [addDays(today, 400), "Pick a day within a year"],
    ] as const)
      expect(
        await buckets.pauseEnrollmentAction({ clientIds: [merchant], paused: true, until }),
      ).toEqual({ ok: false, error: want });
    expect(
      await buckets.pauseEnrollmentAction({ clientIds: [merchant], paused: false, until: day }),
    ).toEqual({ ok: false, error: "A date only goes with a pause" });
    expect(await enrol()).toEqual({ paused: false, resume_on: null });
  });

  it("pauses with the date in the database, and the engine lifts it on that day", async () => {
    await as(dana, "dana@x.com", "rep");
    expect(
      await buckets.pauseEnrollmentAction({ clientIds: [merchant], paused: true, until: day }),
    ).toEqual({ ok: true, data: null });
    expect(await enrol()).toEqual({ paused: true, resume_on: day });
    // the day before: still paused. The day: lifted by the engine, date cleared.
    let run = await runBucketSteps({
      db: t.db,
      now: new Date(`${addDays(day, -1)}T20:00:00Z`),
      appUrl: "https://crm.test",
    });
    expect(run.resumed).toBe(0);
    expect(await enrol()).toEqual({ paused: true, resume_on: day });
    run = await runBucketSteps({
      db: t.db,
      now: new Date(`${day}T20:00:00Z`),
      appUrl: "https://crm.test",
    });
    expect(run.resumed).toBe(1);
    expect(await enrol()).toEqual({ paused: false, resume_on: null });
  });

  it("a plain Pause has no date; a new date replaces the old one; Resume clears it", async () => {
    await as(dana, "dana@x.com", "rep");
    await buckets.pauseEnrollmentAction({ clientIds: [merchant], paused: true });
    expect(await enrol()).toEqual({ paused: true, resume_on: null });
    await buckets.pauseEnrollmentAction({ clientIds: [merchant], paused: true, until: day });
    expect(await enrol()).toEqual({ paused: true, resume_on: day });
    const later = addDays(today, 20);
    await buckets.pauseEnrollmentAction({ clientIds: [merchant], paused: true, until: later });
    expect(await enrol()).toEqual({ paused: true, resume_on: later });
    await buckets.pauseEnrollmentAction({ clientIds: [merchant], paused: false });
    expect(await enrol()).toEqual({ paused: false, resume_on: null });
  });

  it("another rep's merchant is not theirs to pause", async () => {
    await as(mike, "mike@x.com", "rep");
    const r = await buckets.pauseEnrollmentAction({
      clientIds: [merchant],
      paused: true,
      until: day,
    });
    expect(r.ok).toBe(false);
    expect(await enrol()).toEqual({ paused: false, resume_on: null });
  });
});
