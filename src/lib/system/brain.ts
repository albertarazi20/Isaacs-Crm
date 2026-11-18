import Anthropic from "@anthropic-ai/sdk";
import { userContext } from "../data/queries";
import { db as defaultDb, type DbAccess } from "../db";
import { loadQueue } from "../followup/overview";
import {
  AssistantUnavailableError,
  ConversationGoneError,
  loadThreadForDisplay,
  runAssistantTurn,
  type ModelCaller,
  type ShownItem,
} from "../assistant/run";
import { isPreparable, prepBrief, summaryOf, triggerKey, type PrepKind } from "../brain/briefs";

/**
 * The brain: every few minutes, for each active rep, look at their "Do this now" list and have the assistant prepare
 * the next step for anything new (a reply drafted, a nudge written, the file checked), once per trigger. The result is
 * an ordinary assistant conversation with its buttons: nothing is sent or changed here, the rep reads it and clicks.
 * Runs on the owner connection for discovery and bookkeeping; every read of a merchant runs as the rep (row security),
 * exactly as it would if the rep had asked.
 */

/** A run takes a preparation this long; an overlapping run leaves it alone. */
const CLAIM_MINUTES = 3;
/** Failed this many times and it is given up on (the rep can still ask by hand). */
const MAX_ATTEMPTS = 3;
const DEFAULT_BUDGET_MS = 50_000;
/** The brain stops at this share of the day's AI cap: the rest is kept for the reps' own questions and for replies. */
const BRAIN_SHARE = 0.7;

export interface BrainOptions {
  db?: DbAccess;
  /** Whether the AI key is set on this server. */
  keySet: boolean;
  caller: ModelCaller;
  now?: Date;
  /** How long this run may take in all (a hosted request has 60 seconds). */
  budgetMs?: number;
}

export interface BrainResult {
  /** Why nothing ran (switched off, no key, budget spent, the account is out of credit). */
  skipped?: string;
  /** New preparations put on the list this run. */
  queued: number;
  /** Preparations finished this run. */
  prepared: number;
  failed: number;
  /** Still unfinished when the time was up: the next run carries on. */
  deferred: number;
}

interface Prep {
  id: string;
  user_id: string;
  client_id: string | null;
  kind: PrepKind;
  thread_id: string | null;
  attempts: number;
}

/** True for an error that no retry will fix and that every later preparation would hit too. */
export function isAccountProblem(e: unknown): string | null {
  if (e instanceof AssistantUnavailableError) return e.message;
  if (e instanceof Anthropic.APIError) {
    if (/credit balance/i.test(e.message)) return "The Anthropic account is out of credit";
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
      return "The Anthropic key was refused";
  }
  return null;
}

/** True for a failure of the service rather than of this preparation (busy, down, unreachable): try again later. */
export function isTransient(e: unknown): string | null {
  if (
    e instanceof Anthropic.RateLimitError ||
    e instanceof Anthropic.InternalServerError ||
    e instanceof Anthropic.APIConnectionError ||
    (e instanceof Anthropic.APIError && typeof e.status === "number" && e.status >= 500)
  )
    return "The Anthropic service is busy or unreachable: trying again on the next run";
  return null;
}

/** The brain's own stop for spending: when today's cap, or the brain's share of it, is used. Null while there is room. */
async function spendStop(access: DbAccess): Promise<string | null> {
  const { rows } = await access.withSystem((q) =>
    q.query<{ cap: number; spent: string }>(
      "select ai_daily_cap_cents as cap, app.ai_spent_today_cents()::text as spent from shop_settings",
    ),
  );
  const r = rows[0];
  if (!r) return null;
  if (Number(r.spent) >= r.cap) return "today's AI budget is spent";
  if (Number(r.spent) >= r.cap * BRAIN_SHARE)
    return `the brain has used its ${Math.round(BRAIN_SHARE * 100)}% of today's AI budget; the rest is kept for the reps' own questions, and it starts again tomorrow`;
  return null;
}

export async function runBrain(opts: BrainOptions): Promise<BrainResult> {
  const access = opts.db ?? defaultDb;
  const started = Date.now();
  const now = opts.now ?? new Date();
  const deadline = started + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const result: BrainResult = { queued: 0, prepared: 0, failed: 0, deferred: 0 };

  if (!opts.keySet) return { ...result, skipped: "no AI key" };
  const shop = await access.withSystem(async (q) => {
    const { rows } = await q.query<{
      ai_enabled: boolean;
      brain_on: boolean;
      per_rep: number;
    }>(`select ai_enabled, brain_on, brain_daily_per_rep as per_rep from shop_settings`);
    return rows[0];
  });
  if (!shop?.ai_enabled) return { ...result, skipped: "AI is off" };
  if (!shop.brain_on) return { ...result, skipped: "the brain is off" };
  const outOfMoney = await spendStop(access);
  if (outOfMoney) return { ...result, skipped: outOfMoney };

  // 1. what is new on each rep's list
  const reps = await access.withSystem(async (q) => {
    const { rows } = await q.query<{ id: string }>(
      `select id from app_users
        where active and offboarded_at is null and role in ('rep', 'manager')
        order by created_at`,
    );
    return rows;
  });
  for (const rep of reps) {
    if (Date.now() > deadline - 10_000) break;
    try {
      result.queued += await queueForRep(access, rep.id, shop.per_rep, now);
    } catch (e) {
      console.error("brain: could not read a rep's list:", e);
    }
  }

  // 2. prepare them, oldest first, until the time is up
  const claimed = new Set<string>();
  for (;;) {
    if (Date.now() > deadline - 12_000) break;
    // each preparation can spend several calls: look again at the day's spend before taking the next
    const noMoney = await spendStop(access);
    if (noMoney) return { ...result, skipped: noMoney };
    const prep = await claimNext(access, now, claimed);
    if (!prep) break;
    claimed.add(prep.id);
    const done = await prepare(access, prep, opts.caller, now, deadline);
    if (done === "ready") result.prepared++;
    else if (done === "failed") result.failed++;
    else if (done === "unfinished") result.deferred++;
    else {
      // the account cannot run the assistant: every other preparation would fail the same way
      return { ...result, skipped: done.stop };
    }
  }
  return result;
}

/** Puts new triggers on the rep's list of preparations, within their daily limit. Returns how many were added. */
async function queueForRep(
  access: DbAccess,
  userId: string,
  perRep: number,
  now: Date,
): Promise<number> {
  const found = await access.withUser(userId, async (q) => {
    const ctx = await userContext(q, now);
    const queue = await loadQueue(q, ctx.today);
    // a manager sees the whole floor: only the merchants that are theirs are theirs to prepare
    const ids = queue.map((i) => i.clientId);
    const mine = new Set(
      ids.length === 0
        ? []
        : (
            await q.query<{ id: string }>(
              "select id from clients where user_id = app.current_user_id() and id = any($1::uuid[])",
              [ids],
            )
          ).rows.map((r) => r.id),
    );
    return {
      today: ctx.today,
      items: queue.filter((i) => mine.has(i.clientId) && isPreparable(i.kind)),
    };
  });
  if (found.items.length === 0) return 0;

  const wanted: { kind: PrepKind; clientId: string | null; key: string }[] = [
    { kind: "plan", clientId: null, key: triggerKey("plan", null, found.today) },
    ...found.items.map((i) => ({
      kind: i.kind as PrepKind,
      clientId: i.clientId,
      key: triggerKey(i.kind as PrepKind, i.clientId, i.at),
    })),
  ];
  let added = 0;
  await access.withSystem(async (q) => {
    for (const w of wanted) {
      // the daily limit counts the last 24 hours, so a busy morning cannot starve the afternoon for long
      const { rowCount } = await q.query(
        `insert into brain_preps (user_id, client_id, kind, trigger_key)
         select $1, $2::uuid, $3, $4
          where (select count(*) from brain_preps
                  where user_id = $1 and created_at > $5::timestamptz - interval '24 hours') < $6
            -- the same merchant opening their link again every half hour is the same advice: one preparation for the
            -- same merchant and reason stays on the list until the rep has read it (or a day has passed)
            and ($2::uuid is null or not exists (
                  select 1 from brain_preps b
                   where b.user_id = $1 and b.client_id = $2::uuid and b.kind = $3
                     and b.created_at > $5::timestamptz - interval '24 hours'
                     and (b.status = 'working' or (b.status = 'ready' and b.seen_at is null))))
         on conflict (user_id, trigger_key) do nothing`,
        [userId, w.clientId, w.kind, w.key, now.toISOString(), perRep],
      );
      added += rowCount ?? 0;
    }
  });
  return added;
}

/** Takes the oldest unfinished preparation that nobody else has, or null. */
async function claimNext(access: DbAccess, now: Date, skip: Set<string>): Promise<Prep | null> {
  return access.withSystem(async (q) => {
    const { rows } = await q.query<Prep>(
      `update brain_preps set claimed_at = $1
        where id = (select p.id from brain_preps p
                     join app_users u on u.id = p.user_id
                    where p.status = 'working' and p.attempts < $3
                      and u.active and u.offboarded_at is null
                      and (p.claimed_at is null or p.claimed_at < $1::timestamptz - make_interval(mins => $2))
                      and not (p.id = any($4::uuid[]))
                    order by p.created_at, (p.kind = 'plan') desc, p.id limit 1 for update skip locked)
        returning id, user_id, client_id, kind, thread_id, attempts`,
      [now.toISOString(), CLAIM_MINUTES, MAX_ATTEMPTS, [...skip]],
    );
    return rows[0] ?? null;
  });
}

type Outcome = "ready" | "failed" | "unfinished" | { stop: string };

async function prepare(
  access: DbAccess,
  prep: Prep,
  caller: ModelCaller,
  now: Date,
  deadline: number,
): Promise<Outcome> {
  let threadId = prep.thread_id;
  // the conversation's id is written down as soon as it exists, while the turn runs on: a failure of that write is
  // caught where it happens (no unhandled rejection in the middle of a model call) and the write is tried again after
  let saved: Promise<void> = Promise.resolve();
  let saveFailed = false;
  const writeThreadId = (id: string) =>
    access
      .withSystem((q) =>
        q.query("update brain_preps set thread_id = $2 where id = $1", [prep.id, id]),
      )
      .then(() => undefined);
  let notice = "";
  try {
    for (let more = true, first = threadId === null; more; first = false) {
      const left = deadline - Date.now();
      if (left < 12_000) {
        await release(access, prep.id);
        return "unfinished";
      }
      const r = await runAssistantTurn({
        userId: prep.user_id,
        threadId,
        message: first ? prepBrief(prep.kind, prep.client_id) : null,
        title: first ? titleFor(prep) : null,
        keySet: true,
        caller,
        events: {
          thread: (id) => {
            if (id === threadId) return;
            threadId = id;
            saved = writeThreadId(id).catch(() => {
              saveFailed = true;
            });
          },
          text: () => undefined,
          tool: () => undefined,
          actions: () => undefined,
          notice: (m) => {
            notice = m;
          },
        },
        now,
        budgetMs: Math.max(4_000, left - 14_000),
        hardStopMs: left - 2_000,
      });
      await saved;
      if (saveFailed && threadId) {
        saveFailed = false;
        await writeThreadId(threadId);
      }
      threadId = r.threadId;
      more = r.more;
    }
  } catch (e) {
    await saved;
    const stop = isAccountProblem(e) ?? isTransient(e);
    if (stop) {
      await release(access, prep.id, stop);
      return { stop };
    }
    console.error("brain: a preparation failed:", e);
    // the conversation was deleted under it: the next try starts a fresh one
    return fail(
      access,
      prep,
      e instanceof Error ? e.message : String(e),
      e instanceof ConversationGoneError,
    );
  }

  // what came out: the first lines of the last answer and how many buttons it set up
  const shown = await access.withUser(prep.user_id, (q) =>
    threadId ? loadThreadForDisplay(q, threadId) : Promise.resolve(null),
  );
  const answers = (shown ?? []).filter(
    (i): i is Extract<ShownItem, { role: "assistant" }> => i.role === "assistant",
  );
  const actions = answers.reduce((n, a) => n + a.actions.length, 0);
  const text = answers.map((a) => a.text).join(" ");
  // a refusal, a notice that the answer ran too long, a cut-off tool call: the assistant gave nothing to read, so
  // it is not "ready"; a fresh conversation is tried again, up to the usual number of attempts
  if (actions === 0 && !text.trim())
    return fail(access, prep, notice || "The assistant gave no answer", true);
  await access.withSystem((q) =>
    q.query(
      `update brain_preps set status = 'ready', ready_at = now(), claimed_at = null, error = null,
                             thread_id = $2, summary = $3, actions = $4
        where id = $1`,
      [prep.id, threadId, summaryOf(text), actions],
    ),
  );
  return "ready";
}

/** Counts a failed try; after the last one the preparation is given up on. `newThread` forgets the saved conversation. */
async function fail(
  access: DbAccess,
  prep: Prep,
  error: string,
  newThread: boolean,
): Promise<Outcome> {
  const give = prep.attempts + 1 >= MAX_ATTEMPTS;
  await access.withSystem((q) =>
    q.query(
      `update brain_preps set attempts = attempts + 1, claimed_at = null, error = $2,
              thread_id = case when $4 then null else thread_id end,
              status = case when $3 then 'failed' else status end
        where id = $1`,
      [prep.id, error.slice(0, 280), give, newThread],
    ),
  );
  return give ? "failed" : "unfinished";
}

const titleFor = (p: Prep): string => (p.kind === "plan" ? "Plan for today" : "Prepared for you");

async function release(access: DbAccess, id: string, error: string | null = null): Promise<void> {
  await access.withSystem((q) =>
    q.query("update brain_preps set claimed_at = null, error = coalesce($2, error) where id = $1", [
      id,
      error?.slice(0, 280) ?? null,
    ]),
  );
}

/** What the job did lately, for Settings → AI (a manager cannot read other reps' rows, so this reads on the owner connection). */
export interface BrainStatus {
  ready24h: number;
  working: number;
  failed24h: number;
  lastError: string | null;
}

export async function brainStatus(access: DbAccess = defaultDb): Promise<BrainStatus> {
  return access.withSystem(async (q) => {
    const { rows } = await q.query<{
      ready: number;
      working: number;
      failed: number;
      last_error: string | null;
    }>(
      // a rep who has left keeps their unfinished rows, but nothing will ever run them: they are not "working"
      `select count(*) filter (where p.status = 'ready' and p.ready_at > now() - interval '24 hours')::int as ready,
              count(*) filter (where p.status = 'working' and u.active and u.offboarded_at is null)::int as working,
              count(*) filter (where p.status = 'failed' and p.created_at > now() - interval '24 hours')::int as failed,
              (select error from brain_preps where error is not null order by created_at desc limit 1) as last_error
         from brain_preps p join app_users u on u.id = p.user_id`,
    );
    const r = rows[0];
    return {
      ready24h: r?.ready ?? 0,
      working: r?.working ?? 0,
      failed24h: r?.failed ?? 0,
      lastError: r?.last_error ?? null,
    };
  });
}
