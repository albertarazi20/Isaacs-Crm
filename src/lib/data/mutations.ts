import type { Db } from "../db";
import { dueFromPreset, validateFollowUpDate, type ISODate } from "../mca/dates";
import type { FundingTerms } from "../mca/funding";
import { defaultTimers, type PlannedTimer, type StageKey } from "../mca/stages";
import { defaultStips } from "../mca/stips";
import { suggestNextFollowUp } from "../mca/touch";
import { getCard } from "./queries";
import type { ClientCard, UserContext } from "./types";
import type { z } from "zod";
import type {
  askSchema,
  bucketSchema,
  followUpSchema,
  fundingUpdateSchema,
  MoveInput,
  NewClientInput,
  noteSchema,
  offerSchema,
  positionSchema,
  scheduleCallSchema,
  settingsSchema,
  stipSchema,
  TouchInput,
  updateClientSchema,
} from "./schemas";

/** A message safe to show Isaac as-is. Anything else is logged and shown generically. */
export class UserError extends Error {}

const DEFAULT_STAGES: readonly StageKey[] = [
  "default_workable",
  "default_bad",
  "legal_collections",
  "written_off",
];

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

export async function moveClient(q: Db, input: MoveInput, ctx: UserContext): Promise<ClientCard> {
  const { clientId, stage } = input;
  if (input.followUpOn) checkDate(input.followUpOn, ctx.today);
  const override: PlannedTimer[] | null = input.followUpOn
    ? [{ kind: "follow_up", dueOn: input.followUpOn, note: "" }]
    : null;

  if (stage === "funded") {
    const f = input.funding;
    if (!f) throw new UserError("Funding terms are required to mark a client funded");
    const terms: FundingTerms = {
      fundedOn: f.fundedOn ?? ctx.today,
      amountCents: f.amount,
      factorRate: f.factorRate,
      paymentCents: f.payment,
      frequency: f.frequency,
    };
    const timers = defaultTimers("funded", { today: ctx.today, funding: terms });
    await q.query("select * from record_funding($1, $2::jsonb, $3::jsonb)", [
      clientId,
      JSON.stringify({
        funded_on: terms.fundedOn,
        funder_name: f.funderName,
        amount_cents: f.amount,
        factor_rate: f.factorRate,
        payment_cents: f.payment,
        frequency: f.frequency,
        position_no: f.positionNo ?? 1,
        term_days: f.termDays ?? null,
        commission_cents: f.commission ?? null,
        note: input.reason,
      }),
      sqlTimers(timers),
    ]);
  } else if (
    DEFAULT_STAGES.includes(stage) &&
    (await q.query("select 1 from fundings where client_id = $1 limit 1", [clientId])).rowCount
  ) {
    const d = input.default ?? { note: "" };
    const promiseAt = d.promiseToPayAt
      ? await localToInstant(q, d.promiseToPayAt, ctx.timezone)
      : null;
    await q.query("select * from record_default($1, $2, $3, $4, $5, $6::jsonb, $7)", [
      clientId,
      stage,
      d.defaultedOn ?? ctx.today,
      promiseAt,
      d.promiseAmount ?? null,
      sqlTimers(override ?? defaultTimers(stage, { today: ctx.today })),
      d.note || input.reason,
    ]);
  } else {
    const c = stage === "lost" ? input.competitor : undefined;
    if (c) {
      await q.query(
        `insert into competing_offers (user_id, client_id, funder_name, amount_cents, factor_rate, payment_cents,
                                       frequency, position_no, term_days, offered_on, won, note)
         select user_id, id, $2, $3, $4, $5, $6, $7, $8, coalesce($9::date, current_date), true, $10 from clients where id = $1`,
        [
          clientId,
          c.funderName,
          c.amount ?? null,
          c.factorRate ?? null,
          c.payment ?? null,
          c.frequency ?? null,
          c.positionNo ?? null,
          c.termDays ?? null,
          c.offeredOn ?? null,
          c.note,
        ],
      );
    }
    const timers =
      override ??
      defaultTimers(stage, { today: ctx.today, competitorTermDays: c?.termDays ?? undefined });
    await q.query("select * from move_client($1, $2, $3::jsonb, $4)", [
      clientId,
      stage,
      sqlTimers(timers),
      input.reason,
    ]);
    if (stage === "application_in") {
      await q.query(
        "update clients set application_received_on = coalesce(application_received_on, $2::date) where id = $1",
        [clientId, ctx.today],
      );
    }
    if (stage === "paid_in_full") {
      await q.query(
        "update fundings set status = 'paid_off' where client_id = $1 and status in ('active', 'defaulted')",
        [clientId],
      );
    }
  }
  return mustCard(q, clientId);
}

export async function setFollowUp(
  q: Db,
  input: z.output<typeof followUpSchema>,
  ctx: UserContext,
): Promise<ClientCard> {
  checkDate(input.dueOn, ctx.today);
  await q.query("select * from set_follow_up($1, $2)", [input.clientId, input.dueOn]);
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
    { clientId: input.clientId, dueOn: bucketDate(input.bucket, ctx.today) },
    ctx,
  );
}

export async function logTouch(q: Db, input: TouchInput, ctx: UserContext): Promise<ClientCard> {
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
  input: z.output<typeof scheduleCallSchema>,
  ctx: UserContext,
): Promise<ClientCard> {
  const at = await localToInstant(q, input.at, ctx.timezone);
  await q.query("select * from schedule_call($1, $2, $3)", [input.clientId, at, input.note]);
  return mustCard(q, input.clientId);
}

export async function cancelCall(q: Db, clientId: string): Promise<ClientCard> {
  await q.query("select * from cancel_call($1)", [clientId]);
  return mustCard(q, clientId);
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
    const res = await q.query(`update clients set ${sets.join(", ")} where id = $1`, values);
    if (res.rowCount === 0) throw new UserError("That client no longer exists");
  }
  return mustCard(q, input.clientId);
}

export async function deleteClient(q: Db, clientId: string): Promise<void> {
  const res = await q.query("delete from clients where id = $1", [clientId]);
  if (res.rowCount === 0) throw new UserError("That client no longer exists");
}

export async function saveAsk(q: Db, input: z.output<typeof askSchema>): Promise<void> {
  await q.query(
    `insert into client_asks (user_id, client_id, wanted_amount_cents, wanted_terms, est_approval_cents, est_approval_note)
     select user_id, id, $2, $3, $4, $5 from clients where id = $1`,
    [
      input.clientId,
      input.wantedAmount,
      input.wantedTerms,
      input.estApproval,
      input.estApprovalNote,
    ],
  );
}

export async function savePosition(q: Db, input: z.output<typeof positionSchema>): Promise<void> {
  const v = [
    input.positionNo,
    input.funderName,
    input.fundedAmount ?? 0,
    input.payback,
    input.balance ?? 0,
    input.payment,
    input.frequency ?? null,
    input.fundedOn ?? null,
    input.note,
  ];
  if (input.id) {
    const res = await q.query(
      `update positions set position_no = $2, funder_name = $3, funded_amount_cents = $4, payback_cents = $5,
              balance_cents = $6, payment_cents = $7, frequency = $8, funded_on = $9, note = $10 where id = $1`,
      [input.id, ...v],
    );
    if (res.rowCount === 0) throw new UserError("That position no longer exists");
    return;
  }
  await q.query(
    `insert into positions (user_id, client_id, position_no, funder_name, funded_amount_cents, payback_cents,
                            balance_cents, payment_cents, frequency, funded_on, note)
     select user_id, id, $2, $3, $4, $5, $6, $7, $8, $9, $10 from clients where id = $1`,
    [input.clientId, ...v],
  );
}

export async function deletePosition(q: Db, id: string): Promise<void> {
  await q.query("delete from positions where id = $1", [id]);
}

export async function saveOffer(q: Db, input: z.output<typeof offerSchema>): Promise<void> {
  const v = [
    input.funderName,
    input.amount,
    input.factorRate,
    input.payment,
    input.frequency ?? null,
    input.positionNo,
    input.termDays,
    input.offeredOn ?? null,
    input.won,
    input.note,
  ];
  if (input.id) {
    const res = await q.query(
      `update competing_offers set funder_name = $2, amount_cents = $3, factor_rate = $4, payment_cents = $5,
              frequency = $6, position_no = $7, term_days = $8, offered_on = coalesce($9::date, offered_on), won = $10, note = $11
        where id = $1`,
      [input.id, ...v],
    );
    if (res.rowCount === 0) throw new UserError("That offer no longer exists");
    return;
  }
  await q.query(
    `insert into competing_offers (user_id, client_id, funder_name, amount_cents, factor_rate, payment_cents,
                                   frequency, position_no, term_days, offered_on, won, note)
     select user_id, id, $2, $3, $4, $5, $6, $7, $8, coalesce($9::date, current_date), $10, $11 from clients where id = $1`,
    [input.clientId, ...v],
  );
}

export async function deleteOffer(q: Db, id: string): Promise<void> {
  await q.query("delete from competing_offers where id = $1", [id]);
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

export async function updateFunding(
  q: Db,
  input: z.output<typeof fundingUpdateSchema>,
  ctx: UserContext,
): Promise<void> {
  const promiseAt = input.promiseToPayAt
    ? await localToInstant(q, input.promiseToPayAt, ctx.timezone)
    : null;
  const res = await q.query(
    `update fundings set paid_back_override_cents = $2, last_payment_on = $3, promise_to_pay_at = $4,
            promise_amount_cents = $5, note = coalesce($6, note) where id = $1`,
    [
      input.fundingId,
      input.paidBackOverride,
      input.lastPaymentOn ?? null,
      promiseAt,
      input.promiseAmount,
      input.note ?? null,
    ],
  );
  if (res.rowCount === 0) throw new UserError("That funding no longer exists");
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
