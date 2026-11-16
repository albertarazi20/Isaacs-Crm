import type { Db, DbAccess } from "../db";
import { costCents } from "../ai/readLenderEmail";
import {
  draftWinbackOpener,
  OPENER_PROMPT_VERSION,
  type OpenerInput,
  type OpenerOutcome,
} from "../ai/draftWinbackOpener";
import { addDays, diffDays, todayIn, type ISODate } from "../mca/dates";
import { effectiveSignature, mergeValues, resolveMergeFields } from "../messaging/merge";
import { enqueueEmail } from "../send/enqueue";

/**
 * Winback pools: the nightly refresh (SQL refresh_winback_pools) decides who is in a pool and when they become
 * workable; this runner sends the pool's steps through the outbox and advances them. Each pool has its own
 * templates in Settings (templates named "Winback — <pool> — step N"); until a shop writes them, a short built-in
 * angle per step is used so the pool is never silent. Step 1 carries {opener}: the one line Claude drafts for the
 * merchant from the facts on file (auto mode merges it as drafted; review mode waits up to two days for a manager).
 * Rescue nudges (days 20, 25, 29 of a live approval) are a separate runner below, as are the hot list and the
 * recovered-money score.
 */

export interface WinbackRunSummary {
  refreshed: number;
  due: number;
  emailed: number;
  skipped: number;
  finished: number;
  /** Openers drafted this run (0 without a drafter). */
  drafted: number;
}

/** How long review mode holds step 1 for a manager's eye before the email goes without the opener. */
export const OPENER_REVIEW_HOURS = 48;

const BUILT_IN: Record<string, { subject: string; body: string }[]> = {
  approved_unfunded: [
    {
      subject: "Your approval for {business} is still open",
      body: "Hi {first_name},\n\n{opener}\n\n{business} was approved and the approval is still open on my side. What stopped you from moving forward? If it was the terms, tell me what would work and I will go back to the lender.\n\n",
    },
    {
      subject: "Anything change for {business}?",
      body: "Hi {first_name},\n\nChecking in. A lot can change in a few weeks. If capital would help {business} this month, I can refresh the approval with your latest statement: {upload_link}\n\n",
    },
    {
      subject: "A fresh offer only needs one statement",
      body: "Hi {first_name},\n\nLenders want the newest month before they re-approve. Upload it here and I will have numbers back fast: {upload_link}\n\n",
    },
    {
      subject: "Closing your file for now",
      body: "Hi {first_name},\n\nI have not heard back, so I will set {business} aside for now. If funding comes up again, reply here and I will pick it right back up.\n\n",
    },
    {
      subject: "Still here if {business} needs capital",
      body: "Hi {first_name},\n\nQuarterly check-in. If {business} is looking at capital, I am glad to run fresh numbers. Just reply.\n\n",
    },
  ],
  declined_curable: [
    {
      subject: "Worth another look for {business}",
      body: "Hi {first_name},\n\n{opener}\n\nWhen we last looked, the lenders passed on {business} for a reason that usually clears with time. Enough has passed that it is worth another look. Send your latest statements here and I will reshop it: {upload_link}\n\n",
    },
    {
      subject: "Reshopping {business}",
      body: "Hi {first_name},\n\nStill happy to reshop {business} with lenders who did not see the file before. Latest statements here: {upload_link}\n\n",
    },
    {
      subject: "Last check-in on {business}",
      body: "Hi {first_name},\n\nOne last note. If funding is on the table for {business} this quarter, reply and I will get it moving.\n\n",
    },
  ],
  funded_elsewhere: [
    {
      subject: "How is the advance going for {business}?",
      body: "Hi {first_name},\n\n{opener}\n\nYou should be a good way through the advance you took. When it is about half paid, you may qualify for a renewal or a second position on better terms. Want me to run the numbers?\n\n",
    },
    {
      subject: "Renewal numbers for {business}",
      body: "Hi {first_name},\n\nIf the current advance is around half paid, now is the window. Send the latest statement and I will show you what a renewal looks like: {upload_link}\n\n",
    },
  ],
  paid_off: [
    {
      subject: "Congrats on paying off {business}'s advance",
      body: "Hi {first_name},\n\n{opener}\n\nNice work paying that off. Paid-off merchants get the best terms. If {business} could use capital for the next step, say the word and I will get numbers back the same day.\n\n",
    },
    {
      subject: "Best terms you will see for {business}",
      body: "Hi {first_name},\n\nA clean payoff puts {business} at the top of every lender's list. Happy to show you what that gets you. Just reply.\n\n",
    },
  ],
  cold: [
    {
      subject: "Still here if {business} needs capital",
      body: "Hi {first_name},\n\n{opener}\n\nIt has been a while since we spoke about {business}. If funding is on your mind, I am glad to run fresh numbers.\n\n",
    },
    {
      subject: "Checking in on {business}",
      body: "Hi {first_name},\n\nQuick check-in. Anything changed for {business}? If capital would help, reply and I will take it from there.\n\n",
    },
    {
      subject: "One more note for {business}",
      body: "Hi {first_name},\n\nLast check-in from me for a while. If {business} needs funding later, this email is the easiest way to reach me.\n\n",
    },
  ],
};

/** {opener} becomes the line, or disappears (with its blank line) when there is none. */
export function mergeOpener(body: string, opener: string): string {
  const line = opener.trim();
  if (!/\{opener\}/i.test(body)) return body;
  if (line === "") return body.replace(/[ \t]*\{opener\}[ \t]*(\r?\n){0,2}/gi, "");
  return body.replace(/\{opener\}/gi, line);
}

interface DueMember {
  id: string;
  user_id: string;
  client_id: string;
  deal_id: string | null;
  pool: string;
  next_step: number;
  steps_sent: number;
  steps: { day: number }[];
  timezone: string;
  contact_name: string;
  business_name: string;
  email: string;
  sender_name: string;
  application_link: string;
  signature: string;
  token: string;
  tpl_subject: string | null;
  tpl_body: string | null;
  tpl_ok: boolean | null;
  opener: string;
  opener_status: string;
  opener_drafted_at: Date | null;
}

export type OpenerDrafter = (i: OpenerInput, model: string) => Promise<OpenerOutcome>;

/** The real drafter, for the route; tests inject a fake. */
export const claudeOpenerDrafter: OpenerDrafter = (i, model) => draftWinbackOpener(i, { model });

interface AiSettings {
  ai_enabled: boolean;
  ai_model: string;
  ai_daily_cap_cents: number;
  winback_opener_mode: "auto" | "review";
  spent: string;
}

interface DraftCandidate {
  id: string;
  deal_id: string | null;
  pool: string;
  reason: string;
  business_name: string;
  contact_name: string;
  state: string;
  why_label: string | null;
  offer_funder: string | null;
  offer_amount_cents: number | null;
  offer_factor: string | null;
  months_since: number;
}

/**
 * Draft the opener for every active member about to get step 1 that has none yet. Obeys the kill switch and the
 * daily spend cap; every call is logged in ai_runs with its cost. A line that fails the code checks is kept as
 * 'rejected' for a manager to fix, so the model is not asked again and again.
 */
export async function draftOpeners(
  db: DbAccess,
  drafter: OpenerDrafter,
  now: Date,
): Promise<number> {
  const settings = await db.withSystem(
    async (q) =>
      (
        await q.query<AiSettings>(
          "select ai_enabled, ai_model, ai_daily_cap_cents, winback_opener_mode, app.ai_spent_today_cents()::text as spent from shop_settings",
        )
      ).rows[0],
  );
  if (!settings || !settings.ai_enabled) return 0;
  const candidates = await db.withSystem(
    async (q) =>
      (
        await q.query<DraftCandidate>(
          `select m.id, m.deal_id, m.pool, m.reason, c.business_name, c.contact_name, c.state,
                  r.label as why_label, o.funder_name as offer_funder, o.amount_cents as offer_amount_cents, o.factor_rate::text as offer_factor,
                  greatest(0, (extract(epoch from ($1::timestamptz - greatest(c.stage_changed_at, coalesce(c.last_contact_at, c.stage_changed_at)))) / 2629800)::int) as months_since
             from winback_members m join clients c on c.id = m.client_id
             left join winback_reasons r on r.key = m.why_not_funded
             left join lateral (select fu.name as funder_name, o.amount_cents, o.factor_rate
                                  from offers o join submissions s on s.id = o.submission_id join funders fu on fu.id = s.funder_id
                                 where o.client_id = m.client_id order by o.amount_cents desc limit 1) o on true
            where m.status = 'active' and m.next_step = 1 and m.opener_status = 'none'
              and c.contact_status = 'ok' and not c.email_opt_out and c.email <> ''
              and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
            order by m.next_due_on limit 50`,
          [now.toISOString()],
        )
      ).rows,
  );
  let spent = Number(settings.spent);
  let drafted = 0;
  for (const m of candidates) {
    if (spent >= settings.ai_daily_cap_cents) break;
    const input: OpenerInput = {
      businessName: m.business_name,
      contactFirstName: (m.contact_name ?? "").trim().split(/\s+/)[0] ?? "",
      pool: m.pool,
      reason: m.reason,
      whyNotFunded: m.why_label,
      bestOffer:
        m.offer_amount_cents !== null
          ? {
              funderName: m.offer_funder ?? "a lender",
              amountDollars: Math.round(Number(m.offer_amount_cents) / 100),
              factorRate: m.offer_factor === null ? null : Number(m.offer_factor),
            }
          : null,
      monthsSince: m.months_since,
      state: m.state || null,
    };
    try {
      const out = await drafter(input, settings.ai_model);
      const cost = costCents(out.model, out.inputTokens, out.outputTokens);
      spent += cost;
      const ok = out.problems.length === 0;
      const status = ok
        ? settings.winback_opener_mode === "auto"
          ? "approved"
          : "drafted"
        : "rejected";
      await db.withSystem(async (q) => {
        await q.query(
          `insert into ai_runs (purpose, model, prompt_version, input_hash, input_tokens, output_tokens, cost_cents, output, deal_id)
           values ('draft_winback', $1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            out.model,
            OPENER_PROMPT_VERSION,
            out.inputHash,
            out.inputTokens,
            out.outputTokens,
            cost,
            JSON.stringify({ ...out.result, problems: out.problems }),
            m.deal_id,
          ],
        );
        await q.query(
          "update winback_members set opener = $2, opener_status = $3, opener_model = $4, opener_drafted_at = $5 where id = $1",
          [m.id, out.result.opener.trim().slice(0, 300), status, out.model, now.toISOString()],
        );
      });
      if (ok) drafted += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.withSystem((q) =>
        q.query(
          "insert into ai_runs (purpose, model, prompt_version, input_hash, error, deal_id) values ('draft_winback', $1, $2, 'n/a', $3, $4)",
          [settings.ai_model, OPENER_PROMPT_VERSION, msg.slice(0, 500), m.deal_id],
        ),
      );
    }
  }
  return drafted;
}

export async function runWinback(args: {
  db: DbAccess;
  appUrl: string;
  now?: Date;
  /** Claude, for the step-1 opener. Undefined = no drafting (the step goes without an opener). */
  drafter?: OpenerDrafter;
}): Promise<WinbackRunSummary> {
  const now = args.now ?? new Date();
  const s: WinbackRunSummary = {
    refreshed: 0,
    due: 0,
    emailed: 0,
    skipped: 0,
    finished: 0,
    drafted: 0,
  };
  s.refreshed = await args.db.withSystem(
    async (q) =>
      (await q.query<{ added: number }>("select added from refresh_winback_pools()")).rows[0]
        ?.added ?? 0,
  );
  if (args.drafter) s.drafted = await draftOpeners(args.db, args.drafter, now);
  const due = await args.db.withSystem(
    async (q) =>
      (
        await q.query<DueMember>(
          `select m.id, m.user_id, m.client_id, m.deal_id, m.pool, m.next_step, m.steps_sent, p.steps,
                  app.client_timezone(c) as timezone, c.contact_name, c.business_name, c.email,
                  u.name as sender_name, u.application_link, u.signature, c.unsubscribe_token as token,
                  t.subject as tpl_subject, t.body as tpl_body, app.template_may_auto_send(t.id) as tpl_ok,
                  m.opener, m.opener_status, m.opener_drafted_at
             from winback_members m
             join winback_pools p on p.key = m.pool
             join clients c on c.id = m.client_id
             join app_users u on u.id = m.user_id
             left join templates t on t.owner_id is null and not t.archived and lower(t.name) = lower('Winback — ' || p.name || ' — step ' || m.next_step)
            where m.status = 'active' and m.next_due_on <= (($1::timestamptz at time zone app.client_timezone(c))::date)
              and c.contact_status = 'ok' and not c.email_opt_out
              and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
              -- review mode holds step 1 for a manager's eye, two days at most
              and not (m.next_step = 1 and m.opener_status = 'drafted'
                       and m.opener_drafted_at > $1::timestamptz - make_interval(hours => $2::int))
            order by m.next_due_on`,
          [now.toISOString(), OPENER_REVIEW_HOURS],
        )
      ).rows,
  );
  s.due = due.length;
  for (const m of due) {
    await args.db.withSystem(async (q) => {
      const stepIdx = m.next_step - 1;
      const step = m.steps[stepIdx];
      const after = m.steps[stepIdx + 1];
      if (!step) {
        await q.query(
          "update winback_members set status = 'stopped', stop_reason = 'sequence_done' where id = $1",
          [m.id],
        );
        s.finished += 1;
        return;
      }
      const builtIn = BUILT_IN[m.pool]?.[Math.min(stepIdx, (BUILT_IN[m.pool]?.length ?? 1) - 1)];
      const wording =
        m.tpl_body && m.tpl_ok ? { subject: m.tpl_subject ?? "", body: m.tpl_body } : builtIn;
      const today = todayIn(m.timezone, now);
      const advance = async () => {
        if (!after) {
          await q.query(
            "update winback_members set status = 'stopped', stop_reason = 'sequence_done', steps_sent = steps_sent + 1 where id = $1",
            [m.id],
          );
          s.finished += 1;
          return;
        }
        const entered =
          (
            await q.query<{ d: string }>(
              "select (workable_on)::text as d from winback_members where id = $1",
              [m.id],
            )
          ).rows[0]?.d ?? today;
        const nextDue =
          addDays(entered, after.day) > today ? addDays(entered, after.day) : addDays(today, 1);
        await q.query(
          "update winback_members set next_step = $2, next_due_on = $3, steps_sent = steps_sent + 1 where id = $1",
          [m.id, m.next_step + 1, nextDue],
        );
      };
      if (!wording || !m.email) {
        s.skipped += 1;
        await advance();
        return;
      }
      const values = mergeValues({
        contactName: m.contact_name,
        businessName: m.business_name,
        senderName: m.sender_name,
        applicationLink: m.application_link,
        wantedAmountCents: null,
        bestOffer: null,
        uploadLink: `${args.appUrl}/upload/${m.token}`,
      });
      const opener = m.next_step === 1 && m.opener_status === "approved" ? m.opener : "";
      const body = resolveMergeFields(mergeOpener(wording.body, opener), values);
      const subject = resolveMergeFields(wording.subject, values);
      if (body.missing.length || subject.missing.length) {
        s.skipped += 1;
        await advance();
        return;
      }
      const r = await enqueueEmail(
        q,
        {
          clientId: m.client_id,
          dealId: m.deal_id,
          lane: "sequence",
          source: `winback:${m.pool}:${m.next_step}`,
          subject: subject.text || `About ${m.business_name}`,
          text: `${body.text.replace(/\s+$/, "")}\n\n${effectiveSignature(m.signature, m.sender_name)}`,
          when: "window",
          expiresInHours: 48,
        },
        now,
      );
      if (r.queued) {
        await q.query("update winback_members set last_outbox_id = $2 where id = $1", [
          m.id,
          r.outboxId,
        ]);
        s.emailed += 1;
      } else s.skipped += 1;
      await advance();
    });
  }
  return s;
}

// ---------- rescue nudges (S3-11): days 20, 25 and 29 of a live approval ----------

export const RESCUE_DAYS = [20, 25, 29] as const;
/** A nudge for day N goes out until day N + this; after that the next nudge is the one that counts. */
const RESCUE_GRACE_DAYS = 3;

const RESCUE_BUILT_IN: Record<number, { subject: string; body: string }> = {
  20: {
    subject: "Your approval for {business} is still open",
    body: "Hi {first_name},\n\n{funder} approved {business} for {amount} and that approval is still open on my side. Approvals do not last forever, so if you want to move, now is a good time. Reply here or send your latest statement and I will keep it live: {upload_link}\n\n",
  },
  25: {
    subject: "A few days left on {business}'s approval",
    body: "Hi {first_name},\n\nThe {funder} approval for {business} ({amount}) has only a few days left before the lender re-underwrites. If the terms were the problem, tell me what would work and I will go back to them.\n\n",
  },
  29: {
    subject: "Last day on {business}'s approval",
    body: "Hi {first_name},\n\nThis is the last day the {funder} approval for {business} ({amount}) stays open. After today it takes a fresh statement to get it back. Reply and I will hold it as long as I can.\n\n",
  },
};

interface RescueRow {
  deal_id: string;
  user_id: string;
  client_id: string;
  business_name: string;
  contact_name: string;
  email: string;
  sender_name: string;
  application_link: string;
  signature: string;
  token: string;
  timezone: string;
  approved_on: string;
  funder_name: string;
  amount_cents: number | null;
  expires_on: string | null;
  sent_days: number[];
  tpl: Record<string, { subject: string; body: string }> | null;
}

export interface RescueRunSummary {
  live: number;
  emailed: number;
  skipped: number;
}

/**
 * While an approval is live (approved or revised, not expired, deal open, no funding since, no reply from the
 * merchant since), the merchant hears on days 20, 25 and 29 after the approval. One row per deal per day, so a
 * re-run never doubles a nudge. Opt-out and the suppression list stop it at the outbox door.
 */
export async function runRescueNudges(args: {
  db: DbAccess;
  appUrl: string;
  now?: Date;
}): Promise<RescueRunSummary> {
  const now = args.now ?? new Date();
  const s: RescueRunSummary = { live: 0, emailed: 0, skipped: 0 };
  const live = await args.db.withSystem(
    async (q) =>
      (
        await q.query<RescueRow>(
          `select d.id as deal_id, d.user_id, d.client_id, c.business_name, c.contact_name, c.email,
                  u.name as sender_name, u.application_link, u.signature, c.upload_token as token, app.client_timezone(c) as timezone,
                  a.approved_on::text as approved_on, a.funder_name, a.amount_cents, a.expires_on::text as expires_on,
                  coalesce((select array_agg(r.day) from rescue_nudges r where r.deal_id = d.id), '{}') as sent_days,
                  (select jsonb_object_agg(substring(t.name from '\\d+$'), jsonb_build_object('subject', t.subject, 'body', t.body))
                     from templates t where t.owner_id is null and not t.archived and t.name ~* '^Rescue — day \\d+$' and app.template_may_auto_send(t.id)) as tpl
             from deals d
             join clients c on c.id = d.client_id
             join app_users u on u.id = d.user_id
             join lateral (
               select s.responded_at, s.responded_at::date as approved_on, fu.name as funder_name, s.approval_expires_on as expires_on,
                      (select o.amount_cents from offers o where o.submission_id = s.id order by o.created_at desc limit 1) as amount_cents
                 from submissions s join funders fu on fu.id = s.funder_id
                where s.deal_id = d.id and s.status in ('approved', 'revised') and s.responded_at is not null
                order by s.responded_at limit 1) a on true
            where d.outcome = 'open'
              and c.contact_status = 'ok' and not c.email_opt_out and c.email <> ''
              and (a.expires_on is null or a.expires_on >= (($1::timestamptz at time zone app.client_timezone(c))::date))
              and c.reply_waiting_since is null
              and not exists (select 1 from inbound_emails e where e.client_id = c.id and e.kind = 'merchant' and e.received_at > a.responded_at)
              and not exists (select 1 from activities x where x.client_id = c.id and x.kind = 'email' and x.body like 'Merchant replied%' and x.occurred_at > a.responded_at)
              and not exists (select 1 from fundings f where f.client_id = c.id and f.funded_on >= a.approved_on)
              and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
              and a.approved_on <= (($1::timestamptz at time zone app.client_timezone(c))::date) - 20`,
          [now.toISOString()],
        )
      ).rows,
  );
  s.live = live.length;
  for (const r of live) {
    const today: ISODate = todayIn(r.timezone, now);
    const days = diffDays(r.approved_on, today);
    const day = [...RESCUE_DAYS]
      .reverse()
      .find((d) => days >= d && days <= d + RESCUE_GRACE_DAYS && !r.sent_days.includes(d));
    if (!day) {
      s.skipped += 1;
      continue;
    }
    await args.db.withSystem(async (q) => {
      const wording = r.tpl?.[String(day)] ?? RESCUE_BUILT_IN[day];
      if (!wording) {
        s.skipped += 1;
        return;
      }
      const values = mergeValues({
        contactName: r.contact_name,
        businessName: r.business_name,
        senderName: r.sender_name,
        applicationLink: r.application_link,
        wantedAmountCents: null,
        bestOffer: null,
        uploadLink: `${args.appUrl}/upload/${r.token}`,
      });
      const amount =
        r.amount_cents !== null
          ? `$${Math.round(Number(r.amount_cents) / 100).toLocaleString("en-US")}`
          : "the amount on file";
      const fill = (t: string) =>
        t.replace(/\{funder\}/gi, r.funder_name).replace(/\{amount\}/gi, amount);
      const body = resolveMergeFields(fill(wording.body), values);
      const subject = resolveMergeFields(fill(wording.subject), values);
      if (body.missing.length || subject.missing.length) {
        s.skipped += 1;
        return;
      }
      const sent = await enqueueEmail(
        q,
        {
          clientId: r.client_id,
          dealId: r.deal_id,
          lane: "sequence",
          source: `rescue:${r.deal_id}:${day}`,
          subject: subject.text || `About ${r.business_name}`,
          text: `${body.text.replace(/\s+$/, "")}\n\n${effectiveSignature(r.signature, r.sender_name)}`,
          when: "window",
          expiresInHours: 48,
        },
        now,
      );
      await q.query(
        "insert into rescue_nudges (deal_id, user_id, client_id, day, outbox_id) values ($1, $2, $3, $4, $5) on conflict (deal_id, day) do nothing",
        [r.deal_id, r.user_id, r.client_id, day, sent.queued ? sent.outboxId : null],
      );
      if (sent.queued) s.emailed += 1;
      else s.skipped += 1;
    });
  }
  return s;
}

// ---------- the board, the hot list, the pick-list, the score ----------

export interface WinbackBoardRow {
  pool: string;
  pool_name: string;
  id: string;
  client_id: string;
  deal_id: string | null;
  business_name: string;
  contact_name: string;
  phone: string;
  email: string;
  reason: string;
  workable_on: string;
  status: string;
  steps_sent: number;
  next_due_on: string | null;
  last_reply_at: string | null;
  best_offer_cents: number | null;
  why_not_funded: string | null;
  why_note: string;
  opener: string;
  opener_status: string;
  /** The merchant opened their own upload link (the hot-list signal). */
  link_opened_at: string | null;
}

/** The Winback board rows, by pool, for the signed-in user (RLS). */
export async function listWinback(q: Db): Promise<WinbackBoardRow[]> {
  const { rows } = await q.query<WinbackBoardRow>(
    `select m.pool, p.name as pool_name, m.id, m.client_id, m.deal_id, c.business_name, c.contact_name, c.phone, c.email, m.reason,
            m.workable_on::text, m.status, m.steps_sent, m.next_due_on::text,
            (select max(e.received_at) from inbound_emails e where e.client_id = m.client_id and e.kind = 'merchant')::text as last_reply_at,
            (select max(o.amount_cents) from offers o where o.client_id = m.client_id) as best_offer_cents,
            m.why_not_funded, m.why_note, m.opener, m.opener_status,
            (select max(s.created_at) from upload_sessions s where s.client_id = m.client_id and s.created_by is null and s.created_at >= m.created_at)::text as link_opened_at
       from winback_members m join winback_pools p on p.key = m.pool join clients c on c.id = m.client_id
      where m.status in ('waiting', 'active', 'replied', 'stopped')
        and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
      order by p.sort, case m.status when 'replied' then 0 when 'active' then 1 when 'waiting' then 2 else 3 end, m.workable_on`,
  );
  return rows;
}

export interface HotRow {
  id: string;
  client_id: string;
  business_name: string;
  pool: string;
  signal: "replied" | "link_opened";
  at: string;
}

/** Who to call first: members who wrote back or opened their upload link in the last `days`, newest signal first. */
export async function hotList(q: Db, days = 14): Promise<HotRow[]> {
  const { rows } = await q.query<HotRow>(
    `select x.* from (
       select m.id, m.client_id, c.business_name, m.pool,
              case when r.at is not null and (l.at is null or r.at >= l.at) then 'replied' else 'link_opened' end as signal,
              greatest(r.at, l.at)::text as at
         from winback_members m join clients c on c.id = m.client_id
         left join lateral (select max(e.received_at) as at from inbound_emails e where e.client_id = m.client_id and e.kind = 'merchant' and e.received_at >= m.created_at) r on true
         left join lateral (select max(s.created_at) as at from upload_sessions s where s.client_id = m.client_id and s.created_by is null and s.created_at >= m.created_at) l on true
        where m.status in ('waiting', 'active', 'replied')
          and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
     ) x where x.at is not null and x.at::timestamptz > now() - make_interval(days => $1::int)
     order by x.at desc`,
    [days],
  );
  return rows;
}

export interface WinbackReason {
  key: string;
  label: string;
}

export async function listWinbackReasons(q: Db): Promise<WinbackReason[]> {
  return (await q.query<WinbackReason>("select key, label from winback_reasons order by sort"))
    .rows;
}

export async function setWinbackReason(
  q: Db,
  i: { memberId: string; reason: string; note?: string },
): Promise<void> {
  await q.query("select set_winback_reason($1, $2, $3)", [i.memberId, i.reason, i.note ?? ""]);
}

export async function reviewWinbackOpener(
  q: Db,
  i: { memberId: string; text: string; approve: boolean },
): Promise<void> {
  await q.query("select review_winback_opener($1, $2, $3)", [i.memberId, i.text, i.approve]);
}

export interface RecoveredRow {
  pool: string;
  pool_name: string;
  /** The outbox source of the last email before the money came back ('winback:<pool>:<step>'), or null. */
  template: string | null;
  recovered: number;
  funded_cents: number;
  commission_cents: number;
}

/** Recovered money: what funded after a member was worked, per pool and per template (the last step that went). */
export async function winbackRecovered(q: Db, months = 12): Promise<RecoveredRow[]> {
  const { rows } = await q.query<RecoveredRow>(
    `select m.pool, p.name as pool_name, o.source as template, count(*)::int as recovered,
            coalesce(sum(f.amount_cents), 0)::bigint as funded_cents, coalesce(sum(f.commission_cents), 0)::bigint as commission_cents
       from winback_members m join winback_pools p on p.key = m.pool
       left join outbox o on o.id = m.last_outbox_id
       join lateral (select f.amount_cents, f.commission_cents from fundings f
                      where f.client_id = m.client_id and f.funded_on >= m.created_at::date and f.confirmed_at is not null
                      order by f.funded_on limit 1) f on true
      where m.status = 'recovered' and m.created_at > now() - ($1 || ' months')::interval
      group by m.pool, p.name, p.sort, o.source order by p.sort, o.source nulls last`,
    [String(months)],
  );
  return rows.map((r) => ({
    ...r,
    funded_cents: Number(r.funded_cents),
    commission_cents: Number(r.commission_cents),
  }));
}
