import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionError } from "@/lib/data/errors";
import * as m from "@/lib/data/mutations";
import { findDuplicates, getClientDetail, listCards, userContext } from "@/lib/data/queries";
import { bucketSchema, moveSchema, newClientSchema, touchSchema } from "@/lib/data/schemas";
import type { UserContext } from "@/lib/data/types";
import { addBusinessDays, addDays, addMonths } from "@/lib/mca/dates";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let b: string;
let ctx: UserContext;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "America/New_York");
  b = await insertUser(t.pool, "other@x.com");
  ctx = { today: t.today, timezone: "America/New_York" };
});
afterAll(async () => {
  await t.drop();
});

const asA = <T>(fn: (q: Parameters<Parameters<typeof t.db.withUser>[1]>[0]) => Promise<T>) =>
  t.db.withUser(a, fn);
const newClient = (name: string, extra: Record<string, unknown> = {}) =>
  asA((q) =>
    m.createClient(
      q,
      newClientSchema.parse({
        businessName: name,
        contactName: "Mike",
        phone: "(555) 123-4567",
        ...extra,
      }),
      ctx,
    ),
  );
const move = (clientId: string, stage: string, extra: Record<string, unknown> = {}) =>
  asA((q) => m.moveClient(q, moveSchema.parse({ clientId, stage, ...extra }), ctx));
const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;

describe("input schemas", () => {
  it("turns Isaac's shorthand into cents", () => {
    const c = newClientSchema.parse({
      businessName: " Mike's Pizza ",
      wantedAmount: "50k",
      monthlyRevenue: "$85,000",
    });
    expect(c).toMatchObject({
      businessName: "Mike's Pizza",
      wantedAmount: 5_000_000,
      monthlyRevenue: 8_500_000,
      stage: "name_in",
    });
  });
  it("rejects a blank business name and junk money", () => {
    expect(() => newClientSchema.parse({ businessName: "  " })).toThrow(/Business name/);
    expect(() => newClientSchema.parse({ businessName: "X", wantedAmount: "lots" })).toThrow(
      /amount like 50k/,
    );
  });
  it("only accepts the follow-up buckets we actually draw", () => {
    const id = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
    expect(bucketSchema.parse({ clientId: id, bucket: "36m" }).bucket).toBe("36m");
    expect(() => bucketSchema.parse({ clientId: id, bucket: "overdue" })).toThrow();
    expect(() => touchSchema.parse({ clientId: id, kind: "fax" })).toThrow();
  });
});

describe("createClient", () => {
  it("applies the stage's default timer and records the ask", async () => {
    const card = await newClient("Create Pizza", {
      stage: "spoke_with_owner",
      wantedAmount: "75k",
    });
    expect(card).toMatchObject({
      stage: "spoke_with_owner",
      next_due_on: addBusinessDays(ctx.today, 2),
      wanted_amount_cents: 7_500_000,
    });
    expect(
      await rows("select kind, due_on from timers where client_id = $1 and done_at is null", [
        card.id,
      ]),
    ).toEqual([{ kind: "follow_up", due_on: addBusinessDays(ctx.today, 2) }]);
  });
  it("honours a chosen follow-up date, even 36 months out", async () => {
    const far = addMonths(ctx.today, 36);
    expect((await newClient("Far Pizza", { followUpOn: far })).next_due_on).toBe(far);
  });
  it("refuses a date in the past or past 36 months and creates nothing", async () => {
    await expect(newClient("Past Pizza", { followUpOn: addDays(ctx.today, -3) })).rejects.toThrow(
      /past/,
    );
    await expect(
      newClient("Too Far Pizza", { followUpOn: addMonths(ctx.today, 37) }),
    ).rejects.toThrow(/36 months/);
    expect(
      await rows("select 1 from clients where business_name in ('Past Pizza','Too Far Pizza')"),
    ).toEqual([]);
  });
});

describe("moveClient", () => {
  it("moves a card and starts the new stage's timer", async () => {
    const c = await newClient("Move Pizza");
    const moved = await move(c.id, "interested", { reason: "wants 50k" });
    expect(moved).toMatchObject({
      stage: "interested",
      next_due_on: addBusinessDays(ctx.today, 2),
    });
    const last = (
      await rows(
        "select kind, body, from_stage, to_stage from activities where client_id = $1 order by occurred_at desc limit 1",
        [c.id],
      )
    )[0];
    expect(last).toEqual({
      kind: "stage_change",
      body: "wants 50k",
      from_stage: "name_in",
      to_stage: "interested",
    });
  });
  it("lets the chosen date override the stage default", async () => {
    const c = await newClient("Override Pizza");
    const due = addMonths(ctx.today, 3);
    expect((await move(c.id, "dead", { followUpOn: due })).next_due_on).toBe(due);
  });
  it("stamps the application date once and never overwrites it", async () => {
    const c = await newClient("App Pizza");
    await move(c.id, "application_in");
    const first = (
      await rows("select application_received_on from clients where id = $1", [c.id])
    )[0].application_received_on;
    expect(first).toBe(ctx.today);
    await t.pool.query("update clients set application_received_on = $2 where id = $1", [
      c.id,
      addDays(ctx.today, -9),
    ]);
    await move(c.id, "stips");
    await move(c.id, "application_in");
    expect(
      (await rows("select application_received_on from clients where id = $1", [c.id]))[0]
        .application_received_on,
    ).toBe(addDays(ctx.today, -9));
  });

  it("QA I-8: a card moved to 'Phone call scheduled' with a time has that call booked", async () => {
    const c = await newClient("Booked By Drag");
    const day = addDays(ctx.today, 2);
    const moved = await move(c.id, "call_scheduled", {
      callAt: `${day}T10:30`,
      reason: "go over offers",
    });
    expect(moved.stage).toBe("call_scheduled");
    expect(moved.scheduled_call_at).not.toBeNull();
    const [row] = await rows(
      "select kind, due_on::text d, note from timers where client_id = $1 and kind = 'scheduled_call' and done_at is null",
      [c.id],
    );
    expect(row).toMatchObject({ kind: "scheduled_call", d: day, note: "go over offers" });
    // and without a time (Move without a time) it still moves
    const bare = await newClient("Moved Bare");
    expect((await move(bare.id, "call_scheduled")).scheduled_call_at).toBeNull();
  });
  it("QA I-6: skipping Application in still records the day the application came in", async () => {
    const c = await newClient("Skipper Pizza");
    await move(c.id, "interested");
    expect(
      (await rows("select application_received_on from clients where id = $1", [c.id]))[0]
        .application_received_on,
    ).toBeNull();
    await move(c.id, "stips");
    expect(
      (await rows("select application_received_on from clients where id = $1", [c.id]))[0]
        .application_received_on,
    ).toBe(ctx.today);
    // an exit stage does not claim an application came in
    const e = await newClient("Never Applied Pizza");
    await move(e.id, "not_interested");
    expect(
      (await rows("select application_received_on from clients where id = $1", [e.id]))[0]
        .application_received_on,
    ).toBeNull();
  });

  it("refuses a move on another user's client and changes nothing", async () => {
    const c = await newClient("Private Pizza");
    await expect(
      t.db.withUser(b, (q) =>
        m.moveClient(q, moveSchema.parse({ clientId: c.id, stage: "dead" }), ctx),
      ),
    ).rejects.toThrow(/client not found/);
    expect((await rows("select stage from clients where id = $1", [c.id]))[0].stage).toBe(
      "name_in",
    );
  });
});

describe("follow-up timers", () => {
  it("drag-to-bucket sets today + N months/weeks, out to 36 months", async () => {
    const c = await newClient("Bucket Pizza");
    const cases: [Parameters<typeof m.bucketDate>[0], string][] = [
      ["today", ctx.today],
      ["1w", addDays(ctx.today, 7)],
      ["1m", addMonths(ctx.today, 1)],
      ["3m", addMonths(ctx.today, 3)],
      ["36m", addMonths(ctx.today, 36)],
    ];
    for (const [bucket, expected] of cases) {
      const card = await asA((q) => m.moveToBucket(q, { clientId: c.id, bucket }, ctx));
      expect(card.next_due_on, bucket).toBe(expected);
    }
  });
  it("rejects a custom date past 36 months with a message Isaac can read", async () => {
    const c = await newClient("Edge Pizza");
    const err = await asA((q) =>
      m.setFollowUp(q, { clientId: c.id, dueOn: addMonths(ctx.today, 37) }, ctx),
    ).catch((e: unknown) => e);
    expect(toActionError(err)).toMatch(/36 months/);
  });
  it("logTouch suggests a quick retry after no answer and resets the timer", async () => {
    const c = await newClient("Touch Pizza");
    const card = await asA((q) =>
      m.logTouch(q, touchSchema.parse({ clientId: c.id, kind: "call", outcome: "no_answer" }), ctx),
    );
    expect(card.next_due_on).toBe(addBusinessDays(ctx.today, 1));
    expect(card.last_call_at).not.toBeNull();
  });
  it("logTouch uses the date Isaac picked and keeps the call note on the card", async () => {
    const c = await newClient("Note Pizza");
    const due = addMonths(ctx.today, 2);
    const card = await asA((q) =>
      m.logTouch(
        q,
        touchSchema.parse({
          clientId: c.id,
          kind: "call",
          outcome: "reached",
          body: "Wants 75k after tax season",
          nextDueOn: due,
        }),
        ctx,
      ),
    );
    expect(card).toMatchObject({ next_due_on: due, last_call_note: "Wants 75k after tax season" });
  });
  it("schedules a reminder on Isaac's local day and leaves the stage alone", async () => {
    const c = await newClient("Call Pizza", { stage: "interested" });
    const day = addDays(ctx.today, 3);
    const card = await asA((q) =>
      m.scheduleCall(
        q,
        { clientId: c.id, at: `${day}T21:30`, note: "ask about 2nd position" },
        ctx,
      ),
    );
    expect(card.stage).toBe("interested");
    expect(card.scheduled_call_at).not.toBeNull();
    expect(
      await rows(
        "select due_on from timers where client_id = $1 and kind = 'scheduled_call' and done_at is null",
        [c.id],
      ),
    ).toEqual([{ due_on: day }]);
  });
});

describe("client record", () => {
  it("updates only the fields provided", async () => {
    const c = await newClient("Edit Pizza", { industry: "Restaurant" });
    const card = await asA((q) =>
      m.updateClient(q, {
        clientId: c.id,
        fields: { phone: "5559998888", monthlyRevenue: 9_000_000 },
      }),
    );
    expect(card).toMatchObject({
      phone: "5559998888",
      industry: "Restaurant",
      monthly_revenue_cents: 9_000_000,
      business_name: "Edit Pizza",
    });
  });
  it("seeds stips, ticks them, and the card shows 'ready' counts", async () => {
    const c = await newClient("Stip Pizza");
    expect(await asA((q) => m.seedStips(q, c.id, ctx))).toBe(11);
    expect(await asA((q) => m.seedStips(q, c.id, ctx))).toBe(0);
    const d = await asA((q) => getClientDetail(q, c.id));
    for (const s of d?.stips.filter((x) => x.required) ?? [])
      await asA((q) => m.setStip(q, { stipId: s.id, received: true }));
    const card = (await asA((q) => listCards(q))).find((x) => x.id === c.id);
    expect(card).toMatchObject({ stips_required: 7, stips_received: 7 });
  });
  it("adds notes to the timeline, newest first", async () => {
    const c = await newClient("Timeline Pizza");
    await asA((q) => m.addNote(q, { clientId: c.id, body: "First thing" }));
    await new Promise((r) => setTimeout(r, 15));
    await asA((q) => m.addNote(q, { clientId: c.id, body: "Second thing" }));
    const d = await asA((q) => getClientDetail(q, c.id));
    expect(d?.activities.filter((x) => x.kind === "note").map((x) => x.body)).toEqual([
      "Second thing",
      "First thing",
    ]);
  });
  it("deleting forever removes everything attached, only that client, only from the trash", async () => {
    const doomed = await newClient("Doomed Pizza");
    const keeper = await newClient("Keeper Pizza");
    await asA((q) => m.addNote(q, { clientId: doomed.id, body: "bye" }));
    await asA((q) => m.seedStips(q, doomed.id, ctx));
    await expect(asA((q) => m.purgeClient(q, doomed.id))).rejects.toThrow(/not in the trash/);
    expect(await rows("select 1 from clients where id = $1", [doomed.id])).toHaveLength(1);
    await asA((q) => m.trashClient(q, doomed.id));
    await asA((q) => m.purgeClient(q, doomed.id));
    for (const table of ["timers", "activities", "stips"]) {
      expect(await rows(`select 1 from ${table} where client_id = $1`, [doomed.id]), table).toEqual(
        [],
      );
    }
    expect(await rows("select 1 from clients where id = $1", [keeper.id])).toHaveLength(1);
    await expect(t.db.withUser(b, (q) => m.trashClient(q, keeper.id))).rejects.toThrow(
      /no longer exists/,
    );
    expect(await rows("select 1 from clients where id = $1", [keeper.id])).toHaveLength(1);
  });
});

describe("queries and settings", () => {
  it("resolves 'today' in the user's own timezone", async () => {
    const tokyo = await insertUser(t.pool, "tokyo@x.com", "Asia/Tokyo");
    const noon = new Date("2026-10-23T23:30:00Z");
    expect((await t.db.withUser(tokyo, (q) => userContext(q, noon))).today).toBe("2026-10-24");
    expect((await t.db.withUser(a, (q) => userContext(q, noon))).today).toBe("2026-10-23");
  });
  it("lists only my cards, soonest follow-up first", async () => {
    const mine = await asA((q) => listCards(q));
    expect(mine.length).toBeGreaterThan(5);
    const dates = mine.map((c) => c.next_due_on).filter((d): d is string => d !== null);
    expect(dates).toEqual([...dates].sort());
    expect(await t.db.withUser(b, (q) => listCards(q))).toEqual([]);
  });
  it("saves settings, and rejects a time zone Postgres doesn't know even when Intl accepts it", async () => {
    const { settingsSchema } = await import("@/lib/data/schemas");
    await asA((q) =>
      m.updateSettings(
        q,
        settingsSchema.parse({
          timezone: "America/Chicago",
          digestEnabled: false,
          digestHour: "7",
        }),
      ),
    );
    expect(
      (
        await rows("select timezone, digest_enabled, digest_hour from app_users where id = $1", [a])
      )[0],
    ).toEqual({ timezone: "America/Chicago", digest_enabled: false, digest_hour: 7 });
    expect(() =>
      settingsSchema.parse({ timezone: "Mars/Base", digestEnabled: true, digestHour: 8 }),
    ).toThrow(/timezone/);
    // Intl may accept a name Postgres rejects, and a bad zone would break every booked call.
    const intlOk = settingsSchema.safeParse({
      timezone: "America/Argentina/ComodRivadavia",
      digestEnabled: true,
      digestHour: 8,
    });
    // Only meaningful where Postgres's tz data lacks the alias (CI's Linux image does; a full tzdata build such as
    // EnterpriseDB's macOS one knows it, and then saving it would be correct).
    const pgKnows =
      (
        await rows("select 1 from pg_timezone_names where name = $1", [
          "America/Argentina/ComodRivadavia",
        ])
      ).length > 0;
    if (intlOk.success && !pgKnows) {
      await expect(asA((q) => m.updateSettings(q, intlOk.data))).rejects.toThrow(/time zone/);
    }
    expect((await rows("select timezone from app_users where id = $1", [a]))[0].timezone).toBe(
      "America/Chicago",
    );
  });
  it("cannot point the reminder digest at another address, and cannot create temp tables", async () => {
    await expect(
      asA((q) =>
        q.query("update app_users set notify_email = 'attacker@evil.test' where id = $1", [a]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(asA((q) => q.query("create temp table clients (id int)"))).rejects.toThrow(
      /permission denied/,
    );
  });
  it("caps how many emails a session can send in a day", async () => {
    const c = await newClient("Quota Pizza");
    for (let i = 0; i < 3; i += 1) {
      await asA((q) =>
        q.query(
          "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'email', 'x')",
          [a, c.id],
        ),
      );
    }
    await expect(asA((q) => m.assertEmailQuota(q, 3))).rejects.toThrow(/Daily email limit/);
    await asA((q) => m.assertEmailQuota(q, 4));
  });
});

describe("error messages", () => {
  it("turns database errors into messages Isaac can act on, and hides the rest", () => {
    expect(toActionError(Object.assign(new Error("client not found"), { code: "P0002" }))).toBe(
      "That record no longer exists",
    );
    expect(
      toActionError(
        Object.assign(new Error("follow-up date 2020-01-01 is in the past"), { code: "22023" }),
      ),
    ).toMatch(/in the past/);
    expect(
      toActionError(
        Object.assign(new Error("insert or update on table x violates foreign key"), {
          code: "23503",
        }),
      ),
    ).toBe("That record no longer exists");
    expect(toActionError(new m.UserError("Nope"))).toBe("Nope");
    expect(
      toActionError(
        Object.assign(new Error("connection to 10.0.0.5 refused, password=hunter2"), {
          code: "08006",
        }),
      ),
    ).toBe("Something went wrong — try again");
  });
});

describe("duplicate detection when adding", () => {
  it("finds the same phone however it was typed, and the same name ignoring punctuation and case", async () => {
    const c = await newClient("Dupe Check Pizza & Grill, LLC", { phone: "(305) 555-7777" });
    const byPhone = await asA((q) =>
      findDuplicates(q, { phone: "1-305-555-7777", businessName: "Totally Different" }),
    );
    expect(byPhone).toEqual([
      expect.objectContaining({ id: c.id, reason: "same phone", stage: "name_in" }),
    ]);
    const byName = await asA((q) =>
      findDuplicates(q, { businessName: "dupe check pizza grill llc" }),
    );
    expect(byName).toEqual([expect.objectContaining({ id: c.id, reason: "same business name" })]);
  });
  it("finds nothing for a new merchant, a short junk phone, or empty input", async () => {
    expect(
      await asA((q) =>
        findDuplicates(q, { phone: "555-12", businessName: "Never Seen Before Co" }),
      ),
    ).toEqual([]);
    expect(await asA((q) => findDuplicates(q, {}))).toEqual([]);
  });
  it("never reveals another user's clients", async () => {
    expect(
      await t.db.withUser(b, (q) =>
        findDuplicates(q, {
          phone: "(305) 555-7777",
          businessName: "Dupe Check Pizza & Grill, LLC",
        }),
      ),
    ).toEqual([]);
  });
});
