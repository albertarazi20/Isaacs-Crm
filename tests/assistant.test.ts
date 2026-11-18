import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRecommendations, type RecommendationFacts } from "@/lib/assistant/recommendations";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The assistant (Claude Opus 5.5 inside the CRM). The model is scripted: these tests prove what the CRM does around
 * it, read back from the DATABASE: the recommendations match the book, the read tools see only what row security
 * lets the person see, proposed actions are checked before they are shown, every model call is logged against the
 * daily cap, conversations are saved exactly and are private to their owner, and a switched-off or spent assistant
 * refuses in words.
 */

type Message = Anthropic.Beta.Messages.BetaMessage;
type StreamParams = Anthropic.Beta.Messages.MessageCreateParamsStreaming;

let t: TestDb;
let rita: string;
let omar: string;
let boss: string;
let ritaMerchant: string;
let omarMerchant: string;
let statements: string;
let run: typeof import("@/lib/assistant/run");
let tools: typeof import("@/lib/assistant/tools");
let recs: typeof import("@/lib/assistant/recommendations");

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as T | undefined;

/** A scripted model: each call returns the next message, and records what it was sent. */
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
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 },
      content: [],
      ...m,
    } as Message;
  };
  return { caller, sent };
}
const text = (s: string) =>
  ({ type: "text", text: s, citations: null }) as Anthropic.Beta.Messages.BetaTextBlock;
const use = (id: string, name: string, input: unknown) =>
  ({ type: "tool_use", id, name, input }) as Anthropic.Beta.Messages.BetaToolUseBlock;

function recorder() {
  const log = {
    thread: "",
    text: "",
    tools: [] as string[],
    actions: [] as unknown[],
    notices: [] as string[],
  };
  return {
    log,
    events: {
      thread: (id: string) => (log.thread = id),
      text: (d: string) => (log.text += d),
      tool: (name: string) => log.tools.push(name),
      actions: (a: unknown[]) => log.actions.push(...a),
      notice: (m: string) => log.notices.push(m),
    },
  };
}

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
  await t.pool.query("update shop_settings set ai_enabled = true, ai_daily_cap_cents = 500");
  statements = (await one<{ id: string }>(
    "select id from buckets where key = 'missing_statements'",
  ))!.id;
  ritaMerchant = (await one<{ id: string }>(
    "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Harbor Tacos', 'Rosa Diaz', '3105550199', 'rosa@harbortacos.com', 'CA') returning id",
    [rita],
  ))!.id;
  omarMerchant = (await one<{ id: string }>(
    "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Omar Bakery', 'Lee Kim', '3105550111', 'lee@bakery.com', 'CA') returning id",
    [omar],
  ))!.id;
  await t.pool.query("select enroll_in_bucket($1, $2)", [ritaMerchant, statements]);
  // Rita's merchant is overdue and quiet for 10 days
  await t.pool.query(
    "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'follow_up', $3::date)",
    [rita, ritaMerchant, addDays(t.today, -3)],
  );
  await t.pool.query(
    "update activities set occurred_at = now() - interval '10 days', created_at = now() - interval '10 days' where client_id = $1",
    [ritaMerchant],
  );
  await t.pool.query("update clients set created_at = now() - interval '10 days' where id = $1", [
    ritaMerchant,
  ]);
  run = await import("@/lib/assistant/run");
  tools = await import("@/lib/assistant/tools");
  recs = await import("@/lib/assistant/recommendations");
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

describe("recommendations", () => {
  const base: RecommendationFacts = {
    manager: false,
    replyWaiting: 0,
    overdue: 0,
    readyToHandOff: 0,
    readyBucketId: null,
    queue: {},
    quietMissingDocs: 0,
    postalAddressSet: true,
    gmailConnected: true,
    weakBuckets: [],
    repBehind: null,
  };

  it("rank by what matters most: a missing postal address first, then replies, then hand-offs; nothing to do is no cards", () => {
    expect(buildRecommendations(base)).toEqual([]);
    const r = buildRecommendations({
      ...base,
      postalAddressSet: false,
      replyWaiting: 2,
      readyToHandOff: 1,
      overdue: 30,
      queue: { call_now: 4 },
    });
    expect(r.map((x) => x.id)).toEqual([
      "postal-address",
      "replies",
      "ready",
      "new-leads",
      "overdue",
    ]);
    expect(r[1]!.title).toBe("Answer 2 merchants who wrote back");
    expect(r[2]!.title).toBe("Hand off 1 merchant");
    expect(r.every((x) => x.prompt.length > 40 && x.href.startsWith("/"))).toBe(true);
  });

  it("a manager is pointed at a rep who is far behind; a rep never is", () => {
    const facts = { ...base, repBehind: { name: "Omar Rep", overdue: 14 } };
    expect(buildRecommendations({ ...facts, manager: true }).map((x) => x.id)).toContain(
      "rep-behind",
    );
    expect(buildRecommendations(facts).map((x) => x.id)).not.toContain("rep-behind");
  });

  it("read from the database under row security: Rita's overdue and quiet merchant counts for Rita, not for Omar", async () => {
    const forRita = await t.db.withUser(rita, (q) =>
      recs.loadRecommendationFacts(q, { today: t.today, manager: false, gmailConnected: true }),
    );
    const forOmar = await t.db.withUser(omar, (q) =>
      recs.loadRecommendationFacts(q, { today: t.today, manager: false, gmailConnected: true }),
    );
    const overdueInDb = await one<{ n: number }>(
      "select count(*)::int as n from timers where user_id = $1 and done_at is null and due_on < current_date",
      [rita],
    );
    expect(forRita.overdue).toBe(overdueInDb!.n);
    expect(forRita.overdue).toBeGreaterThan(0);
    expect(forRita.quietMissingDocs).toBe(1);
    expect(forOmar.quietMissingDocs).toBe(0);
    const titles = (
      await t.db.withUser(rita, (q) =>
        recs.loadRecommendations(q, { today: t.today, manager: false, gmailConnected: true }),
      )
    ).map((x) => x.id);
    expect(titles).toContain("overdue");
    expect(titles).toContain("quiet-docs");
  });
});

describe("tools", () => {
  it("the read tools see only what row security lets the person see", async () => {
    const own = await t.db.withUser(rita, (q) =>
      tools.runReadTool(
        q,
        "get_merchant",
        { merchant_id: ritaMerchant },
        { today: t.today, manager: false },
      ),
    );
    expect(JSON.parse(own.content).business).toBe("Harbor Tacos");
    const other = await t.db.withUser(rita, (q) =>
      tools.runReadTool(
        q,
        "get_merchant",
        { merchant_id: omarMerchant },
        { today: t.today, manager: false },
      ),
    );
    expect(other.isError).toBe(true);
    const found = await t.db.withUser(rita, (q) =>
      tools.runReadTool(
        q,
        "find_merchants",
        { query: "bakery" },
        { today: t.today, manager: false },
      ),
    );
    expect(JSON.parse(found.content)).toEqual([]);
    const bossFinds = await t.db.withUser(boss, (q) =>
      tools.runReadTool(
        q,
        "find_merchants",
        { query: "5550111" },
        { today: t.today, manager: true },
      ),
    );
    expect(JSON.parse(bossFinds.content).map((m: { business: string }) => m.business)).toEqual([
      "Omar Bakery",
    ]);
    const overdue = await t.db.withUser(rita, (q) =>
      tools.runReadTool(
        q,
        "list_follow_ups",
        { when: "overdue" },
        { today: t.today, manager: false },
      ),
    );
    expect(JSON.parse(overdue.content).map((m: { merchant_id: string }) => m.merchant_id)).toEqual([
      ritaMerchant,
    ]);
  });

  it("proposed actions are checked before they are shown: another rep's merchant, a past date, an outside link and a bad bucket are refused in words", async () => {
    const r = await t.db.withUser(rita, (q) =>
      tools.checkActions(
        q,
        {
          actions: [
            {
              type: "set_follow_up",
              label: "Call Rosa Friday",
              merchant_id: ritaMerchant,
              date: addDays(t.today, 2),
            },
            { type: "hand_off", label: "Hand off the bakery", merchant_id: omarMerchant },
            {
              type: "set_follow_up",
              label: "Yesterday",
              merchant_id: ritaMerchant,
              date: addDays(t.today, -1),
            },
            { type: "open", label: "Somewhere else", href: "https://evil.example" },
            {
              type: "move_to_bucket",
              label: "Move",
              merchant_id: ritaMerchant,
              bucket_id: ritaMerchant,
            },
            { type: "open", label: "Call list", href: "/today" },
            { type: "launch_rockets", label: "No" },
          ],
        },
        t.today,
        "call1",
      ),
    );
    expect(r.shown.map((a) => a.label)).toEqual(["Call Rosa Friday", "Call list"]);
    expect(r.shown[0]).toMatchObject({ id: "call1:0", merchant_name: "Harbor Tacos" });
    expect(r.refused).toHaveLength(5);
    expect(r.refused.join(" ")).toMatch(/no merchant with that id is visible/);
  });
});

describe("an email the assistant writes", () => {
  it("is shown with the merchant's address and the rep's own signature, and refused for do-not-contact or no address", async () => {
    await t.pool.query(
      "update app_users set signature = 'Rita Rep\nSelective Capital' where id = $1",
      [rita],
    );
    const noEmail = (await one<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'No Mail Co', 'Al', '3105550188', '', 'CA') returning id",
      [rita],
    ))!.id;
    const dnc = (await one<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state, contact_status) values ($1, 'Stop Co', 'Bo', '3105550177', 'bo@stop.com', 'CA', 'dnc') returning id",
      [rita],
    ))!.id;
    const r = await t.db.withUser(rita, (q) =>
      tools.checkActions(
        q,
        {
          actions: [
            {
              type: "send_email",
              label: "Email Rosa",
              merchant_id: ritaMerchant,
              subject: "Your statements",
              body: "Hi Rosa, here is the link.",
            },
            {
              type: "send_email",
              label: "Email Al",
              merchant_id: noEmail,
              subject: "Hi",
              body: "Hello",
            },
            {
              type: "send_email",
              label: "Email Bo",
              merchant_id: dnc,
              subject: "Hi",
              body: "Hello",
            },
          ],
        },
        t.today,
        "mail1",
      ),
    );
    expect(r.shown).toHaveLength(1);
    expect(r.shown[0]).toMatchObject({
      type: "send_email",
      to: "rosa@harbortacos.com",
      merchant_name: "Harbor Tacos",
      subject: "Your statements",
    });
    expect((r.shown[0] as { body: string }).body).toBe(
      "Hi Rosa, here is the link.\n\nRita Rep\nSelective Capital",
    );
    expect(r.refused.join(" ")).toMatch(/No Mail Co has no email address/);
    expect(r.refused.join(" ")).toMatch(/Stop Co: Marked do-not-contact/);
  });
});

describe("a turn", () => {
  it("reads with a tool, answers, offers checked actions, logs every call against the cap and saves the conversation exactly", async () => {
    const before = await one<{ n: number }>(
      "select count(*)::int as n from ai_runs where purpose = 'assistant'",
    );
    const { caller, sent } = script([
      () => ({
        stop_reason: "tool_use",
        content: [use("t1", "list_follow_ups", { when: "overdue" })],
      }),
      () => ({
        stop_reason: "tool_use",
        content: [
          text("Call Rosa at Harbor Tacos first: she is 3 days past due."),
          use("t2", "propose_actions", {
            actions: [
              {
                type: "set_follow_up",
                label: "Call Rosa tomorrow",
                merchant_id: ritaMerchant,
                date: addDays(t.today, 1),
              },
              { type: "hand_off", label: "Hand off the bakery", merchant_id: omarMerchant },
            ],
          }),
        ],
      }),
      () => ({ content: [text(" I set up the follow-up for you to confirm.")] }),
    ]);
    const { log, events } = recorder();
    const result = await run.runAssistantTurn({
      userId: rita,
      threadId: null,
      message: "Plan my overdue calls",
      keySet: true,
      caller,
      events,
    });
    expect(result.more).toBe(false);
    expect(log.thread).toBe(result.threadId);
    expect(log.tools).toEqual(["list_follow_ups", "propose_actions"]);
    expect(log.text).toContain("Call Rosa at Harbor Tacos first");
    expect(log.actions).toHaveLength(1);
    expect(log.actions[0]).toMatchObject({ type: "set_follow_up", merchant_name: "Harbor Tacos" });

    // the model was asked for the one the shop chose (Sonnet 5.5 is the default), adaptive thinking, the fallbacks,
    // and got Rita's context line
    const first = sent[0]!;
    expect(first.model).toBe("claude-sonnet-5-5");
    expect(first.thinking).toEqual({ type: "adaptive" });
    expect(first.fallbacks).toBe("default");
    const opening = first.messages[0]!.content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(opening[0]!.text).toMatch(/^\[Today is \w+ \d{4}-\d{2}-\d{2}.*Rita Rep \(a rep/);
    // the second call carried the real tool result, read from the database
    const toolResult = (
      sent[1]!.messages[2]!.content as Anthropic.Beta.Messages.BetaToolResultBlockParam[]
    )[0]!;
    expect(JSON.parse(toolResult.content as string)[0].business).toBe("Harbor Tacos");

    // database: three calls logged, the thread saved with every message, owned by Rita, titled by her question
    const after = await one<{ n: number }>(
      "select count(*)::int as n from ai_runs where purpose = 'assistant'",
    );
    expect(after!.n - before!.n).toBe(3);
    const saved = await one<{ user_id: string; title: string; n: number; last: string }>(
      "select user_id, title, jsonb_array_length(messages) as n, messages->-1->>'role' as last from assistant_threads where id = $1",
      [result.threadId],
    );
    expect(saved).toEqual({
      user_id: rita,
      title: "Plan my overdue calls",
      n: 6,
      last: "assistant",
    });
    const spent = await one<{ c: string }>("select app.ai_spent_today_cents()::text as c");
    expect(Number(spent!.c)).toBeGreaterThan(0);

    // the history the panel shows: the question, one answer with the shown action
    const shown = await t.db.withUser(rita, (q) => run.loadThreadForDisplay(q, result.threadId));
    expect(shown).toHaveLength(2);
    expect(shown![0]).toEqual({ role: "user", text: "Plan my overdue calls" });
    expect(shown![1]).toMatchObject({ role: "assistant" });
    expect((shown![1] as { actions: unknown[] }).actions).toHaveLength(1);

    // a second question continues the same conversation, the saved history first and unchanged
    const savedBefore = await one<{ m: unknown[] }>(
      "select messages as m from assistant_threads where id = $1",
      [result.threadId],
    );
    const second = script([() => ({ content: [text("Yes.")] })]);
    await run.runAssistantTurn({
      userId: rita,
      threadId: result.threadId,
      message: "Anything else?",
      keySet: true,
      caller: second.caller,
      events: recorder().events,
    });
    expect(second.sent[0]!.messages).toHaveLength(7);
    expect(second.sent[0]!.messages.slice(0, 6)).toEqual(savedBefore!.m);
  });

  it("a conversation is private: another person cannot read it, continue it or see it in their list", async () => {
    const { caller } = script([() => ({ content: [text("Hello Rita.")] })]);
    const r = await run.runAssistantTurn({
      userId: rita,
      threadId: null,
      message: "Hello",
      keySet: true,
      caller,
      events: recorder().events,
    });
    expect(await t.db.withUser(omar, (q) => run.loadThreadForDisplay(q, r.threadId))).toBeNull();
    expect((await t.db.withUser(omar, (q) => run.listThreads(q))).map((x) => x.id)).not.toContain(
      r.threadId,
    );
    expect((await t.db.withUser(boss, (q) => run.listThreads(q))).map((x) => x.id)).not.toContain(
      r.threadId,
    );
    await expect(
      run.runAssistantTurn({
        userId: omar,
        threadId: r.threadId,
        message: "Let me in",
        keySet: true,
        caller: script([() => ({ content: [text("no")] })]).caller,
        events: recorder().events,
      }),
    ).rejects.toThrow("That conversation is gone");
    const untouched = await one<{ n: number }>(
      "select jsonb_array_length(messages) as n from assistant_threads where id = $1",
      [r.threadId],
    );
    expect(untouched!.n).toBe(2);
  });

  it("refuses in words when switched off, without a key, or past today's budget, and calls no model", async () => {
    const { caller, sent } = script([]);
    const ask = (keySet = true) =>
      run.runAssistantTurn({
        userId: rita,
        threadId: null,
        message: "Hi",
        keySet,
        caller,
        events: recorder().events,
      });
    await expect(ask(false)).rejects.toThrow("not set up");
    await t.pool.query("update shop_settings set ai_enabled = false");
    await expect(ask()).rejects.toThrow("switched off");
    await t.pool.query("update shop_settings set ai_enabled = true, ai_daily_cap_cents = 0");
    await expect(ask()).rejects.toThrow("today's budget");
    await t.pool.query("update shop_settings set ai_daily_cap_cents = 500");
    expect(sent).toHaveLength(0);
  });

  it("a refusal stops the turn with a notice; a tool call cut off at max_tokens is never run", async () => {
    const refused = script([() => ({ stop_reason: "refusal", content: [] })]);
    const a = recorder();
    await run.runAssistantTurn({
      userId: rita,
      threadId: null,
      message: "x",
      keySet: true,
      caller: refused.caller,
      events: a.events,
    });
    expect(a.log.notices[0]).toMatch(/can't help with that/);

    const cut = script([
      () => ({
        stop_reason: "max_tokens",
        content: [use("t9", "get_merchant", { merchant_id: ritaMerchant })],
      }),
    ]);
    const b = recorder();
    const r = await run.runAssistantTurn({
      userId: rita,
      threadId: null,
      message: "y",
      keySet: true,
      caller: cut.caller,
      events: b.events,
    });
    expect(b.log.tools).toEqual([]);
    const saved = await one<{ n: number }>(
      "select jsonb_array_length(messages) as n from assistant_threads where id = $1",
      [r.threadId],
    );
    expect(saved!.n).toBe(1); // the question only: the cut-off call was not kept
  });

  it("a long turn hands back 'more' and a continue request picks it up from the saved tool result", async () => {
    const first = script([
      () => ({ stop_reason: "tool_use", content: [use("t5", "get_overview", {})] }),
    ]);
    const r = await run.runAssistantTurn({
      userId: rita,
      threadId: null,
      message: "Big plan",
      keySet: true,
      caller: first.caller,
      events: recorder().events,
      budgetMs: 0,
    });
    // budget 0: the first call is skipped too, so nothing ran yet and the browser is told to continue
    expect(r.more).toBe(true);
    expect(first.sent).toHaveLength(0);
    const second = script([
      () => ({ stop_reason: "tool_use", content: [use("t6", "get_overview", {})] }),
      () => ({ content: [text("Here is the plan.")] }),
    ]);
    const rec = recorder();
    const r2 = await run.runAssistantTurn({
      userId: rita,
      threadId: r.threadId,
      message: null,
      keySet: true,
      caller: second.caller,
      events: rec.events,
    });
    expect(r2.more).toBe(false);
    expect(rec.log.text).toBe("Here is the plan.");
    expect(second.sent[1]!.messages).toHaveLength(3);
  });

  it("a call stopped at the time limit is still counted, its text is dropped, nothing of it is saved, and the browser continues", async () => {
    const partial = {
      id: "msg_cut",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 4000, output_tokens: 1 },
      content: [text("Here is the start of a long pla")],
    } as unknown as Message;
    const caller = async (_p: StreamParams, onText: (d: string) => void): Promise<Message> => {
      onText("Here is the start of a long pla");
      throw new run.UnfinishedCallError(new Error("aborted"), partial, true);
    };
    let dropped = 0;
    const rec = recorder();
    const r = await run.runAssistantTurn({
      userId: rita,
      threadId: null,
      message: "A very long plan",
      keySet: true,
      caller,
      events: { ...rec.events, discard: () => (dropped += 1) },
    });
    expect(r.more).toBe(true);
    expect(dropped).toBe(1);
    const logged = await one<{ n: number; cost: string }>(
      "select count(*)::int as n, max(cost_cents)::text as cost from ai_runs where purpose = 'assistant' and output->>'stop_reason' = 'timed_out'",
    );
    expect(logged!.n).toBe(1);
    expect(Number(logged!.cost)).toBeGreaterThan(0);
    const saved = await one<{ messages: { role: string }[] }>(
      "select messages from assistant_threads where id = $1",
      [r.threadId],
    );
    // only the question: the cut-off answer is not part of the history the next request continues from
    expect(saved!.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("two stops at the time limit in a row: the second try thinks less, then the person is asked for a shorter question", async () => {
    const stopped = () => {
      throw new run.UnfinishedCallError(new Error("aborted"), undefined, true);
    };
    const efforts: string[] = [];
    const caller = async (p: StreamParams): Promise<Message> => {
      efforts.push(String((p as { output_config?: { effort?: string } }).output_config?.effort));
      return stopped();
    };
    const first = await run.runAssistantTurn({
      userId: rita,
      threadId: null,
      message: "Everything about every merchant",
      keySet: true,
      caller,
      events: recorder().events,
    });
    expect(first.more).toBe(true);
    const timeouts = async () =>
      (await one<{ n: number }>("select timeouts as n from assistant_threads where id = $1", [
        first.threadId,
      ]))!.n;
    expect(await timeouts()).toBe(1);
    const second = await run.runAssistantTurn({
      userId: rita,
      threadId: first.threadId,
      message: null,
      keySet: true,
      caller,
      events: recorder().events,
    });
    expect(second.more).toBe(true);
    expect(efforts).toEqual(["high", "medium"]);
    expect(await timeouts()).toBe(2);
    const rec = recorder();
    const third = await run.runAssistantTurn({
      userId: rita,
      threadId: first.threadId,
      message: null,
      keySet: true,
      caller,
      events: rec.events,
    });
    expect(third.more).toBe(false);
    expect(efforts).toHaveLength(2); // no third paid call
    expect(rec.log.notices.join(" ")).toMatch(/too long to write in one go/);
    expect(await timeouts()).toBe(0);
  });

  it("tools asked for too late in a request run first in the next one", async () => {
    const s = script([
      () => ({ stop_reason: "tool_use", content: [use("late1", "get_overview", {})] }),
      () => ({ content: [text("Done with the overview.")] }),
    ]);
    const first = await run.runAssistantTurn({
      userId: rita,
      threadId: null,
      message: "Overview please",
      title: "Overview: today",
      keySet: true,
      caller: s.caller,
      events: recorder().events,
      toolsByMs: 0,
    });
    expect(first.more).toBe(true);
    const saved = await one<{ messages: { role: string }[]; title: string }>(
      "select messages, title from assistant_threads where id = $1",
      [first.threadId],
    );
    // the call is kept, its tools not yet run; the conversation is named by the button's label
    expect(saved!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(saved!.title).toBe("Overview: today");
    const rec = recorder();
    const second = await run.runAssistantTurn({
      userId: rita,
      threadId: first.threadId,
      message: null,
      keySet: true,
      caller: s.caller,
      events: rec.events,
    });
    expect(second.more).toBe(false);
    expect(rec.log.tools).toEqual(["get_overview"]);
    expect(rec.log.text).toBe("Done with the overview.");
    expect(s.sent[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("a stopped call's cost counts the time it ran, not only the text it showed (thinking is billed unseen)", () => {
    const m = {
      model: "claude-opus-5-5",
      usage: { input_tokens: 100, output_tokens: 1 },
      content: [{ type: "thinking", thinking: "", signature: "" }],
    } as unknown as Message;
    expect(run.partialUsage(m, 30_000).usage.output_tokens).toBeGreaterThanOrEqual(1500);
    expect(run.partialUsage(m, 0).usage.output_tokens).toBeGreaterThanOrEqual(1);
  });

  it("a tool input the stream could not parse is asked for again (the SDK's own error, not an API error)", async () => {
    const { AnthropicError } = await import("@anthropic-ai/sdk");
    let calls = 0;
    const rec = recorder();
    let dropped = 0;
    const r = await run.runAssistantTurn({
      userId: rita,
      threadId: null,
      message: "Plan it",
      keySet: true,
      caller: async (_p, onText) => {
        calls += 1;
        if (calls === 1)
          throw new run.UnfinishedCallError(
            new AnthropicError("Unable to parse tool parameter JSON from model. JSON: {"),
            undefined,
            false,
          );
        onText("Done.");
        return {
          id: "msg_ok",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [text("Done.")],
        } as unknown as Message;
      },
      events: { ...rec.events, discard: () => (dropped += 1) },
    });
    expect(calls).toBe(2);
    expect(dropped).toBe(1);
    expect(r.more).toBe(false);
    expect(rec.log.text).toBe("Done.");
    expect(run.isToolJsonError(new Error("Unable to parse tool parameter JSON"))).toBe(false);
  });
});

describe("a proposed pause", () => {
  it("is refused for a merchant in no bucket (there is nothing to pause)", async () => {
    const loose = (await one<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Loose Co', 'Ann Lee', '3105550177', 'ann@loose.com', 'CA') returning id",
      [rita],
    ))!.id;
    await t.pool.query("select stop_enrollment($1, 'removed')", [loose]);
    const checked = await t.db.withUser(rita, (q) =>
      tools.checkActions(
        q,
        {
          actions: [
            { type: "pause", label: "Pause Loose Co", merchant_id: loose },
            { type: "pause", label: "Pause Harbor Tacos", merchant_id: ritaMerchant },
          ],
        },
        t.today,
        "call_pause",
      ),
    );
    expect(checked.shown.map((a) => ("merchant_id" in a ? a.merchant_id : null))).toEqual([
      ritaMerchant,
    ]);
    expect(checked.refused.join(" ")).toMatch(/not in a bucket/);
  });
});
