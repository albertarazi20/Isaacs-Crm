import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepBrief, summaryOf, triggerKey } from "@/lib/brain/briefs";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The brain: a job that, for each rep, has the assistant prepare the next step for everything new on their "Do this
 * now" list. The model is scripted; everything is read back from the DATABASE: what was queued and for whom, what each
 * preparation holds (a saved conversation with its buttons), that nothing is prepared twice, that the daily limit,
 * the switch, the claim and the account problems hold, and that a rep can read only their own.
 */

type Message = Anthropic.Beta.Messages.BetaMessage;
type StreamParams = Anthropic.Beta.Messages.MessageCreateParamsStreaming;

let t: TestDb;
let rita: string;
let omar: string;
let boss: string;
let ritaMerchant: string;
let brain: typeof import("@/lib/system/brain");
let queries: typeof import("@/lib/brain/queries");
let dbAccess: typeof import("@/lib/db").db;

const rows = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as T[];
const one = async <T>(sql: string, params: unknown[] = []) => (await rows<T>(sql, params))[0];

function script(steps: ((params: StreamParams) => Partial<Message>)[]) {
  const sent: StreamParams[] = [];
  let i = 0;
  const caller = async (params: StreamParams, onText: (d: string) => void): Promise<Message> => {
    sent.push(structuredClone(params));
    const step = steps[i++];
    if (!step) throw new Error("the script ran out");
    const m = step(params);
    for (const b of m.content ?? []) if (b.type === "text") onText(b.text);
    return {
      id: `msg_${i}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 },
      content: [],
      ...m,
    } as Message;
  };
  return { caller, sent, used: () => i };
}
const text = (s: string) =>
  ({ type: "text", text: s, citations: null }) as Anthropic.Beta.Messages.BetaTextBlock;
const use = (id: string, name: string, input: unknown) =>
  ({ type: "tool_use", id, name, input }) as Anthropic.Beta.Messages.BetaToolUseBlock;
const alwaysText = (s: string) => {
  const sent: StreamParams[] = [];
  let n = 0;
  const caller = async (params: StreamParams, onText: (d: string) => void): Promise<Message> => {
    sent.push(structuredClone(params));
    n++;
    onText(s);
    return {
      id: `msg_${n}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 800, output_tokens: 120 },
      content: [text(s)],
    } as Message;
  };
  return { caller, sent, used: () => n };
};

const go = (caller: Parameters<typeof brain.runBrain>[0]["caller"], extra = {}) =>
  brain.runBrain({
    db: dbAccess,
    keySet: true,
    caller,
    now: new Date(),
    budgetMs: 40_000,
    ...extra,
  });

beforeAll(async () => {
  t = await createTestDb();
  const url = new URL(
    (t.pool as unknown as { options: { connectionString: string } }).options.connectionString,
  );
  process.env.DATABASE_URL = url.toString();
  rita = await insertUser(t.pool, "rita@x.com");
  omar = await insertUser(t.pool, "omar@x.com");
  boss = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set name = 'Rita Rep' where id = $1", [rita]);
  await t.pool.query("update app_users set name = 'Omar Rep' where id = $1", [omar]);
  await t.pool.query("update app_users set role = 'manager', name = 'Pat Boss' where id = $1", [
    boss,
  ]);
  await t.pool.query("update shop_settings set ai_enabled = true, ai_daily_cap_cents = 5000");
  const statements = (await one<{ id: string }>(
    "select id from buckets where key = 'missing_statements'",
  ))!.id;
  ritaMerchant = (await one<{ id: string }>(
    "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Harbor Tacos', 'Rosa Diaz', '3105550199', 'rosa@harbortacos.com', 'CA') returning id",
    [rita],
  ))!.id;
  await t.pool.query("select enroll_in_bucket($1, $2)", [ritaMerchant, statements]);
  // Rita's merchant came in ten days ago and its follow-up is overdue: it is on her Do this now list
  await t.pool.query("update clients set created_at = now() - interval '10 days' where id = $1", [
    ritaMerchant,
  ]);
  await t.pool.query(
    "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'follow_up', $3::date)",
    [rita, ritaMerchant, addDays(t.today, -3)],
  );
  brain = await import("@/lib/system/brain");
  queries = await import("@/lib/brain/queries");
  dbAccess = (await import("@/lib/db")).db;
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

describe("the brain's words", () => {
  it("names a merchant by id only and asks for finished work", () => {
    const b = prepBrief("overdue", "11111111-1111-4111-8111-111111111111");
    expect(b).toContain("11111111-1111-4111-8111-111111111111");
    expect(b).toContain("background preparation");
    expect(b).toContain("send_email");
    expect(() => prepBrief("reply", null)).toThrow();
  });
  it("keys a trigger by what put it on the list, so it is prepared once", () => {
    expect(triggerKey("reply", "c1", "2026-01-02T03:04:05Z")).toBe("reply:c1:2026-01-02T03:04:05Z");
    expect(triggerKey("plan", null, "2026-01-02")).toBe("plan:2026-01-02");
  });
  it("shortens an answer to plain sentences", () => {
    const s = summaryOf(
      "**Rosa** went quiet ten days ago.\n\n1. Call her tomorrow.\n2. Email the checklist. " +
        "x".repeat(400),
    );
    expect(s).not.toContain("*");
    expect(s.length).toBeLessThanOrEqual(262);
    expect(s.startsWith("Rosa went quiet ten days ago.")).toBe(true);
  });
});

describe("the switches", () => {
  it("does nothing without a key, with AI off, or with the brain off", async () => {
    const m = alwaysText("x");
    expect((await go(m.caller, { keySet: false })).skipped).toBe("no AI key");
    expect((await go(m.caller)).skipped).toBe("the brain is off");
    await t.pool.query("update shop_settings set brain_on = true, ai_enabled = false");
    expect((await go(m.caller)).skipped).toBe("AI is off");
    await t.pool.query("update shop_settings set ai_enabled = true");
    expect(m.used()).toBe(0);
    expect(await rows("select 1 from brain_preps")).toHaveLength(0);
  });
  it("stops when today's AI budget is spent", async () => {
    await t.pool.query("update shop_settings set ai_daily_cap_cents = 1");
    await t.pool.query(
      "select app.log_ai_run('assistant', 'claude-sonnet-5-5', 'x', 'h', 1, 1, 50, '{}'::jsonb, null)",
    );
    const m = alwaysText("x");
    expect((await go(m.caller)).skipped).toBe("today's AI budget is spent");
    await t.pool.query("update shop_settings set ai_daily_cap_cents = 5000");
    await t.pool.query("delete from ai_runs");
    expect(m.used()).toBe(0);
  });
  it("stops at 70% of the day's cap and keeps the rest for the reps", async () => {
    await t.pool.query("update shop_settings set ai_daily_cap_cents = 100");
    // 75 of 100 cents spent: under the cap, over the brain's share
    await t.pool.query(
      "select app.log_ai_run('assistant', 'claude-sonnet-5-5', 'x', 'h', 1, 1, 75, '{}'::jsonb, null)",
    );
    const m = alwaysText("x");
    const r = await go(m.caller);
    expect(r.skipped).toMatch(/its 70% of today's AI budget.*kept for the reps/);
    expect(m.used()).toBe(0);
    await t.pool.query("update shop_settings set ai_daily_cap_cents = 5000");
    await t.pool.query("delete from ai_runs");
  });
});

describe("preparing", () => {
  it("queues the plan and the merchant on Rita's list, only hers, then prepares both", async () => {
    // the manager sees every merchant on the floor but has none of their own: nothing is queued for them
    const s = script([
      // 1: the plan
      () => ({ content: [text("Start with Harbor Tacos, then the call list.")] }),
      // 2: the overdue merchant, two calls: the buttons, then the words
      () => ({
        stop_reason: "tool_use",
        content: [
          use("tu1", "propose_actions", {
            actions: [
              {
                type: "set_follow_up",
                label: "Call Rosa tomorrow",
                merchant_id: ritaMerchant,
                date: addDays(t.today, 1),
              },
            ],
          }),
        ],
      }),
      () => ({
        content: [text("Rosa went quiet ten days ago. A call tomorrow is the best move.")],
      }),
    ]);
    const r = await go(s.caller);
    expect(r).toMatchObject({ queued: 2, prepared: 2, failed: 0, deferred: 0 });

    const preps = await rows<{
      user_id: string;
      client_id: string | null;
      kind: string;
      status: string;
      thread_id: string | null;
      summary: string;
      actions: number;
      ready_at: string | null;
    }>("select * from brain_preps order by kind");
    expect(preps.map((p) => [p.user_id, p.kind, p.status])).toEqual([
      [rita, "overdue", "ready"],
      [rita, "plan", "ready"],
    ]);
    const overdue = preps.find((p) => p.kind === "overdue")!;
    expect(overdue.client_id).toBe(ritaMerchant);
    expect(overdue.actions).toBe(1);
    expect(overdue.summary).toContain("Rosa went quiet");
    expect(overdue.thread_id).toBeTruthy();
    expect(overdue.ready_at).toBeTruthy();

    // the conversation is Rita's, saved with the brief and the answer, titled for the list
    const th = await one<{ user_id: string; title: string; n: number }>(
      "select user_id, title, jsonb_array_length(messages) as n from assistant_threads where id = $1",
      [overdue.thread_id],
    );
    expect(th).toMatchObject({ user_id: rita, title: "Prepared for you" });
    expect(th!.n).toBe(4);
    // every model call was logged against the daily cap, on the shop's model
    expect((await one<{ n: number }>("select count(*)::int as n from ai_runs"))!.n).toBe(3);
    expect(s.sent[0]!.model).toBe("claude-sonnet-5-5");
  });

  it("prepares nothing twice", async () => {
    const m = alwaysText("again");
    const r = await go(m.caller);
    expect(r).toMatchObject({ queued: 0, prepared: 0 });
    expect(m.used()).toBe(0);
    expect(await rows("select 1 from brain_preps")).toHaveLength(2);
  });

  it("shows a rep only their own, newest unread first, and marks one read when it is opened", async () => {
    const mine = await dbAccess.withUser(rita, (q) => queries.listPreps(q));
    expect(mine.map((p) => p.kind)).toEqual(["plan", "overdue"]);
    expect(mine[1]).toMatchObject({ businessName: "Harbor Tacos", actions: 1 });
    // Omar and the manager cannot read Rita's preparations
    expect(await dbAccess.withUser(omar, (q) => queries.listPreps(q))).toHaveLength(0);
    expect(await dbAccess.withUser(boss, (q) => queries.listPreps(q))).toHaveLength(0);
    const id = mine[1]!.id;
    expect(await dbAccess.withUser(omar, (q) => queries.openPrep(q, id))).toBeNull();
    const thread = await dbAccess.withUser(rita, (q) => queries.openPrep(q, id));
    expect(thread).toBeTruthy();
    expect(
      (await one<{ seen: boolean }>(
        "select seen_at is not null as seen from brain_preps where id = $1",
        [id],
      ))!.seen,
    ).toBe(true);
    const after = await dbAccess.withUser(rita, (q) => queries.listPreps(q));
    expect(after.map((p) => p.kind)).toEqual(["plan"]);
  });

  it("will not let a rep change anything but when they read it", async () => {
    const id = (await one<{ id: string }>("select id from brain_preps limit 1"))!.id;
    await expect(
      dbAccess.withUser(rita, (q) =>
        q.query("update brain_preps set summary = 'x' where id = $1", [id]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("prepares a merchant that turns up later, and respects the daily limit", async () => {
    // a new lead for Omar (so on his list as "call now"); his limit is one a day and the plan already uses it
    const omarMerchant = (await one<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Omar Bakery', 'Lee Kim', '3105550111', 'lee@bakery.com', 'CA') returning id",
      [omar],
    ))!.id;
    await t.pool.query(
      "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'follow_up', $3::date)",
      [omar, omarMerchant, addDays(t.today, -2)],
    );
    await t.pool.query("update shop_settings set brain_daily_per_rep = 1");
    const m = alwaysText("Call Lee.");
    const r = await go(m.caller);
    expect(r.queued).toBe(1); // the plan takes his one
    expect(r.prepared).toBe(1);
    expect(
      (await rows<{ kind: string }>("select kind from brain_preps where user_id = $1", [omar])).map(
        (p) => p.kind,
      ),
    ).toEqual(["plan"]);
    // Rita's earlier ones do not count against Omar, and her limit is also spent now
    await t.pool.query("update shop_settings set brain_daily_per_rep = 5");
    const r2 = await go(alwaysText("Call Lee.").caller);
    expect(r2.queued).toBe(1);
    expect(
      (
        await rows<{ kind: string }>(
          "select kind from brain_preps where user_id = $1 order by kind",
          [omar],
        )
      ).map((p) => p.kind),
    ).toEqual(["call_now", "plan"]);
  });

  it("gives the assistant the shop's house rules", async () => {
    await t.pool.query("update shop_settings set playbook = 'We say funding, never loan.'");
    const omarMerchant = (await one<{ id: string }>("select id from clients where user_id = $1", [
      omar,
    ]))!.id;
    await t.pool.query(
      "insert into brain_preps (user_id, client_id, kind, trigger_key) values ($1, $2, 'overdue', 'overdue:rules:test')",
      [omar, omarMerchant],
    );
    const m = alwaysText("ok");
    await go(m.caller);
    const system = JSON.stringify(m.sent[0]!.system);
    expect(system).toContain("We say funding, never loan.");
    expect(system).toContain("House rules from the shop owner");
    await t.pool.query("update shop_settings set playbook = ''");
  });
});

describe("the model", () => {
  it("is the one chosen in Settings", async () => {
    await t.pool.query("update shop_settings set ai_model = 'claude-opus-5-5'");
    const omarMerchant = (await one<{ id: string }>("select id from clients where user_id = $1", [
      omar,
    ]))!.id;
    await t.pool.query(
      "insert into brain_preps (user_id, client_id, kind, trigger_key) values ($1, $2, 'overdue', 'overdue:model:test')",
      [omar, omarMerchant],
    );
    const m = alwaysText("ok");
    await go(m.caller);
    expect(m.sent[0]!.model).toBe("claude-opus-5-5");
    await t.pool.query("update shop_settings set ai_model = 'claude-sonnet-5-5'");
  });
});

describe("when it cannot or should not", () => {
  const fresh = async (key: string, userId = rita) =>
    (await one<{ id: string }>(
      "insert into brain_preps (user_id, client_id, kind, trigger_key) values ($1, $2, 'overdue', $3) returning id",
      [userId, ritaMerchant, key],
    ))!.id;

  it("leaves a preparation another run is holding alone", async () => {
    const id = await fresh("overdue:held:1");
    await t.pool.query("update brain_preps set claimed_at = now() where id = $1", [id]);
    const m = alwaysText("x");
    await go(m.caller);
    expect(m.used()).toBe(0);
    expect(
      (await one<{ status: string }>("select status from brain_preps where id = $1", [id]))!.status,
    ).toBe("working");
    // a claim older than a few minutes is taken over
    await t.pool.query(
      "update brain_preps set claimed_at = now() - interval '10 minutes' where id = $1",
      [id],
    );
    await go(alwaysText("done").caller);
    expect(
      (await one<{ status: string }>("select status from brain_preps where id = $1", [id]))!.status,
    ).toBe("ready");
  });

  it("stops everything, and keeps the work, when the Anthropic account is out of credit", async () => {
    const id = await fresh("overdue:credit:1");
    const caller = async (): Promise<Message> => {
      throw Anthropic.APIError.generate(
        400,
        { error: { type: "invalid_request_error", message: "Your credit balance is too low" } },
        "Your credit balance is too low",
        new Headers(),
      );
    };
    const r = await go(caller);
    expect(r.skipped).toBe("The Anthropic account is out of credit");
    const p = await one<{
      status: string;
      attempts: number;
      error: string;
      claimed_at: string | null;
    }>("select status, attempts, error, claimed_at from brain_preps where id = $1", [id]);
    expect(p).toMatchObject({ status: "working", attempts: 0, claimed_at: null });
    expect(p!.error).toContain("out of credit");
    // credit comes back: the same preparation is done
    await go(alwaysText("Call her.").caller);
    expect(
      (await one<{ status: string }>("select status from brain_preps where id = $1", [id]))!.status,
    ).toBe("ready");
  });

  it("gives up on a preparation after three failures", async () => {
    const id = await fresh("overdue:broken:1");
    const caller = async (): Promise<Message> => {
      throw new Error("the model fell over");
    };
    for (let i = 0; i < 3; i++) await go(caller);
    const p = await one<{ status: string; attempts: number; error: string }>(
      "select status, attempts, error from brain_preps where id = $1",
      [id],
    );
    expect(p).toMatchObject({ status: "failed", attempts: 3 });
    expect(p!.error).toContain("the model fell over");
    const m = alwaysText("x");
    await go(m.caller);
    expect(m.used()).toBe(0);
  });

  it("ignores a rep who has left", async () => {
    const id = await fresh("overdue:left:1");
    await t.pool.query("update app_users set active = false where id = $1", [rita]);
    const m = alwaysText("x");
    await go(m.caller);
    expect(m.used()).toBe(0);
    expect(
      (await one<{ status: string }>("select status from brain_preps where id = $1", [id]))!.status,
    ).toBe("working");
    await t.pool.query("update app_users set active = true where id = $1", [rita]);
  });

  it("reports what it did for Settings", async () => {
    const s = await brain.brainStatus(dbAccess);
    expect(s.failed24h).toBe(1);
    expect(s.ready24h).toBeGreaterThanOrEqual(4);
    expect(s.working).toBeGreaterThanOrEqual(1);
  });
});
