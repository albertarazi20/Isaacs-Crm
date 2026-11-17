import type { Db } from "../db";
import { dueFromPreset, validateFollowUpDate, type ISODate } from "../mca/dates";
import { contactAllowed } from "../mca/contact";
import { defaultTimers, stageDef, type PlannedTimer } from "../mca/stages";
import { defaultStips } from "../mca/stips";
import { suggestNextFollowUp } from "../mca/touch";
import { describeEdit } from "./audit";
import { getCard } from "./queries";
import type { ClientCard, UserContext } from "./types";
import type { z } from "zod";
import type {
  mergeSchema,
  bucketSchema,
  contactStatusSchema,
  followUpSchema,
  MoveInput,
  NewClientInput,
  noteSchema,
  scheduleCallSchema,
  settingsSchema,
  stipSchema,
  TouchInput,
  updateClientSchema,
} from "./schemas";

/** A message safe to show Isaac as-is. Anything else is logged and shown generically. */
export class UserError extends Error {}

const sqlTimers = (timers: PlannedTimer[]) =>
  JSON.stringify(timers.map((t) => ({ kind: t.kind, due_on: t.dueOn, note: t.note })));

function checkDate(dueOn: ISODate, today: ISODate): void {
  const err = validateFollowUpDate(dueOn, today);
  if (err) throw new UserError(err);
}

async function mustCard(q: Db, id: string): Promise<ClientCard> {
  const card = await getCard(q, id);
  if (!card) throw new UserError("That client no longer exists");
  return card;
}

/** "2026-10-27T14:30" typed in Isaac's timezone → the real instant. */
async function localToInstant(q: Db, local: string, timezone: string): Promise<Date> {
  const { rows } = await q.query<{ t: Date }>("select ($1::timestamp at time zone $2) as t", [
    local,
    timezone,
  ]);
  const t = rows[0]?.t;
  if (!t) throw new UserError("That date and time isn't valid");
  return t;
}

export async function createClient(
  q: Db,
  input: NewClientInput,
  ctx: UserContext,
): Promise<ClientCard> {
  if (input.followUpOn) checkDate(input.followUpOn, ctx.today);
  const timers = input.followUpOn
    ? [{ kind: "follow_up" as const, dueOn: input.followUpOn, note: "" }]
    : defaultTimers(input.stage, { today: ctx.today });
  const fields = {
    business_name: input.businessName,
    contact_name: input.contactName,
    phone: input.phone,
    email: input.email,
    industry: input.industry,
    state: input.state,
    source: input.source,
    monthly_revenue_cents: input.monthlyRevenue ?? null,
    stage: input.stage,
  };
  const { rows } = await q.query<{ id: string }>(
    "select id from create_client($1::jsonb, $2::jsonb)",
    [JSON.stringify(fields), sqlTimers(timers)],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("create_client returned no row");
  if (input.wantedAmount) {
    await q.query(
      "insert into client_asks (user_id, client_id, wanted_amount_cents) select user_id, id, $2 from clients where id = $1",
      [id, input.wantedAmount],
    );
  }
  return mustCard(q, id);
}

/**
 * Stamp the merchant's time zone the way `app.client_timezone()` derives it — the state first, then the phone's
 * area code — and say which, so a rep can see where it came from and override it. A zone set by hand is kept;
 * a merchant with neither a known state nor a known area code stays unstamped (reads fall back to the rep's zone).
 */
export async function stampClientTimezone(q: Db, clientId: string): Promise<void> {
  await q.query(
    `with z as (
       select c.id,
              (select tz from app_state_tz where state = upper(btrim(c.state))) as state_tz,
              (select tz from area_code_tz
                where code = substr(p.d, case when length(p.d) = 11 then 2 else 1 end, 3)) as area_tz
         from clients c, lateral (select regexp_replace(c.phone, '\\D', '', 'g') as d) p
        where c.id = $1 and c.timezone is null)
     update clients c
        set timezone = coalesce(z.state_tz, z.area_tz),
            timezone_source = case when z.state_tz is not null then 'state'
                                   when z.area_tz is not null then 'area_code' end
       from z where z.id = c.id`,
    [clientId],
  );
}

export async function moveClient(q: Db, input: MoveInput, ctx: UserContext): Promise<ClientCard> {
  const { clientId, stage } = input;
  if (input.followUpOn) checkDate(input.followUpOn, ctx.today);
  const override: PlannedTimer[] | null = input.followUpOn
    ? [{ kind: "follow_up", dueOn: input.followUpOn, note: "" }]
    : null;

  await q.query("select * from move_client($1, $2, $3::jsonb, $4)", [
    clientId,
    stage,
    sqlTimers(override ?? defaultTimers(stage, { today: ctx.today })),
    input.reason,
  ]);
  if (stage === "call_scheduled" && input.callAt) {
    if (input.callAt.slice(0, 10) < ctx.today)
      throw new UserError("That call time has already passed — pick a time from now on");
    const at = await localToInstant(q, input.callAt, ctx.timezone);
    await q.query("select * from schedule_call($1, $2, $3)", [clientId, at, input.reason]);
  }
  // However he got there (skipping "Application in" included), a merchant in Application in had an application.
  if (stageDef(stage).group === "application") {
    await q.query(
      "update clients set application_received_on = coalesce(application_received_on, $2::date) where id = $1",
      [clientId, ctx.today],
    );
  }
  return mustCard(q, clientId);
}

export async function setFollowUp(
  q: Db,
  input: z.output<typeof followUpSchema>,
  ctx: UserContext,
): Promise<ClientCard> {
  checkDate(input.dueOn, ctx.today);
  await q.query("select * from set_follow_up($1, $2, '', $3)", [
    input.clientId,
    input.dueOn,
    input.keepCalls ?? false,
  ]);
  return mustCard(q, input.clientId);
}

/** Dragging a card into a follow-up column: "1 month" means a month from today. */
export function bucketDate(
  bucket: z.output<typeof bucketSchema>["bucket"],
  today: ISODate,
): ISODate {
  return bucket === "today" ? today : dueFromPreset(bucket, today);
}

export async function moveToBucket(
  q: Db,
  input: z.output<typeof bucketSchema>,
  ctx: UserContext,
): Promise<ClientCard> {
  return setFollowUp(
    q,
    { clientId: input.clientId, dueOn: bucketDate(input.bucket, ctx.today), keepCalls: true },
    ctx,
  );
}

/** Server-side backstop: the buttons are disabled in the UI, but "stop" has to mean stop even if one is not. */
export async function assertContactAllowed(
  q: Db,
  clientId: string,
  kind: "call" | "text" | "email",
): Promise<ClientCard> {
  const card = await mustCard(q, clientId);
  const check = contactAllowed(card.contact_status, kind);
  if (!check.ok)
    throw new UserError(`${check.reason} — ${card.business_name} can't be contacted that way`);
  return card;
}

export async function setContactStatus(
  q: Db,
  input: z.output<typeof contactStatusSchema>,
): Promise<ClientCard> {
  await q.query("select * from set_contact_status($1, $2, $3)", [
    input.clientId,
    input.status,
    input.note,
  ]);
  return mustCard(q, input.clientId);
}

export async function logTouch(q: Db, input: TouchInput, ctx: UserContext): Promise<ClientCard> {
  await assertContactAllowed(q, input.clientId, input.kind);
  const next = input.nextDueOn ?? suggestNextFollowUp(input.outcome ?? null, ctx.today);
  checkDate(next, ctx.today);
  await q.query("select * from log_touch($1, $2, $3, $4, $5)", [
    input.clientId,
    input.kind,
    input.outcome ?? null,
    input.body,
    next,
  ]);
  return mustCard(q, input.clientId);
}

export async function scheduleCall(
  q: Db,
  input: z.input<typeof scheduleCallSchema>,
  ctx: UserContext,
): Promise<ClientCard> {
  // The database would call this "a follow-up date in the past"; he is booking a call.
  if (input.at.slice(0, 10) < ctx.today)
    throw new UserError("That call time has already passed — pick a time from now on");
  const at = await localToInstant(q, input.at, ctx.timezone);
  await q.query("select * from schedule_call($1, $2, $3)", [input.clientId, at, input.note ?? ""]);
  await q.query(
    "update timers set channel = $2 where client_id = $1 and kind = 'scheduled_call' and done_at is null",
    [input.clientId, input.channel ?? "call"],
  );
  return mustCard(q, input.clientId);
}

export async function mergeClients(
  q: Db,
  input: z.output<typeof mergeSchema>,
): Promise<ClientCard> {
  await q.query("select * from merge_clients($1, $2)", [input.keepId, input.dropId]);
  return mustCard(q, input.keepId);
}

/** Star or unstar a merchant: starred ones sit at the top of Today and the dial. */
export async function setHot(q: Db, input: { clientId: string; hot: boolean }): Promise<void> {
  const res = await q.query("update clients set hot = $2 where id = $1", [
    input.clientId,
    input.hot,
  ]);
  if (res.rowCount === 0) throw new UserError("That client no longer exists");
}

/** One-time move of the stars a browser kept for itself to the server. Ids that are not his are skipped. */
export async function importHot(q: Db, ids: readonly string[]): Promise<number> {
  const res = await q.query(
    "update clients set hot = true where id = any($1::uuid[]) and not hot",
    [ids],
  );
  return res.rowCount ?? 0;
}

export async function cancelCall(q: Db, clientId: string): Promise<ClientCard> {
  await q.query("select * from cancel_call($1)", [clientId]);
  return mustCard(q, clientId);
}

/** A line on the timeline that the app wrote (not Isaac): what changed, what was moved, what was merged. */
async function addSystemNote(q: Db, clientId: string, body: string): Promise<void> {
  await q.query(
    "insert into activities (user_id, client_id, kind, body) select user_id, id, 'system', $2 from clients where id = $1",
    [clientId, body],
  );
}

export async function addNote(q: Db, input: z.output<typeof noteSchema>): Promise<void> {
  const res = await q.query(
    "insert into activities (user_id, client_id, kind, body) select user_id, id, 'note', $2 from clients where id = $1",
    [input.clientId, input.body],
  );
  if (res.rowCount === 0) throw new UserError("That client no longer exists");
}

const CLIENT_COLUMNS = {
  businessName: "business_name",
  dba: "dba",
  contactName: "contact_name",
  phone: "phone",
  email: "email",
  industry: "industry",
  state: "state",
  source: "source",
  monthlyRevenue: "monthly_revenue_cents",
  timeInBusinessMonths: "time_in_business_months",
  applicationReceivedOn: "application_received_on",
} as const;

export async function updateClient(
  q: Db,
  input: z.output<typeof updateClientSchema>,
): Promise<ClientCard> {
  const sets: string[] = [];
  const values: unknown[] = [input.clientId];
  for (const [key, column] of Object.entries(CLIENT_COLUMNS)) {
    const value = (input.fields as Record<string, unknown>)[key];
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length > 0) {
    // what it was, so the timeline can say what changed (row locked: a second save at the same time can't mix the two)
    const was = await q.query<{ j: Record<string, unknown> }>(
      "select to_jsonb(c) as j from clients c where id = $1 for update",
      [input.clientId],
    );
    const res = await q.query(`update clients set ${sets.join(", ")} where id = $1`, values);
    if (res.rowCount === 0 || !was.rows[0]) throw new UserError("That client no longer exists");
    const now = await q.query<{ j: Record<string, unknown> }>(
      "select to_jsonb(c) as j from clients c where id = $1",
      [input.clientId],
    );
    const line = describeEdit(was.rows[0].j, now.rows[0]?.j ?? {});
    if (line) await addSystemNote(q, input.clientId, line);
  }
  return mustCard(q, input.clientId);
}

/** Hides the client everywhere and closes every timer; the history stays. Undo with restoreClient. */
export async function trashClient(q: Db, clientId: string): Promise<void> {
  await trashCall(q, "trash_client", clientId, "That client no longer exists");
}

export async function restoreClient(q: Db, clientId: string): Promise<void> {
  await trashCall(q, "restore_client", clientId, "That client is not in the trash");
}

/** Removes a trashed client and everything attached to it. Refuses a client that is not in the trash. */
export async function purgeClient(q: Db, clientId: string): Promise<void> {
  await trashCall(q, "purge_client", clientId, "That client is not in the trash");
}

async function trashCall(q: Db, fn: string, clientId: string, missing: string): Promise<void> {
  try {
    await q.query(`select ${fn}($1)`, [clientId]);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P0002") throw new UserError(missing);
    // A rule the database enforces, worded for the person (e.g. "that merchant is in the trash").
    if (code === "22023" && e instanceof Error) throw new UserError(e.message);
    throw e;
  }
}

export async function seedStips(q: Db, clientId: string, ctx: UserContext): Promise<number> {
  const seeds = defaultStips(ctx.today).map((s) => ({
    kind: s.kind,
    period: s.period,
    required: s.required,
  }));
  const { rows } = await q.query<{ n: number }>("select add_stips($1, $2::jsonb) as n", [
    clientId,
    JSON.stringify(seeds),
  ]);
  return rows[0]?.n ?? 0;
}

export async function setStip(q: Db, input: z.output<typeof stipSchema>): Promise<void> {
  await q.query("select * from set_stip_received($1, $2)", [input.stipId, input.received]);
}

export async function updateSettings(q: Db, input: z.output<typeof settingsSchema>): Promise<void> {
  // Postgres, not Intl, decides what a time zone is: "+05:00" and a few legacy names pass one and fail the other.
  const known = await q.query("select 1 from pg_timezone_names where name = $1", [input.timezone]);
  if (known.rowCount === 0) throw new UserError("Pick a time zone from the list");
  await q.query(
    "update app_users set timezone = $1, digest_enabled = $2, digest_hour = $3 where id = app.current_user_id()",
    [input.timezone, input.digestEnabled, input.digestHour],
  );
}

/** A stolen session can't turn Isaac's own Gmail into a spam cannon: at most this many emails a day. */
export const DAILY_EMAIL_LIMIT = 100;

export async function assertEmailQuota(q: Db, limit: number = DAILY_EMAIL_LIMIT): Promise<void> {
  const { rows } = await q.query<{ n: number }>(
    "select count(*)::int as n from activities where kind = 'email' and occurred_at > now() - interval '24 hours'",
  );
  if ((rows[0]?.n ?? 0) >= limit) {
    throw new UserError(
      `Daily email limit reached (${limit}). It resets 24 hours after your oldest email today.`,
    );
  }
}
