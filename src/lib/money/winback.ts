import type { Db, DbAccess } from "../db";
import { addDays, todayIn } from "../mca/dates";
import { effectiveSignature, mergeValues, resolveMergeFields } from "../messaging/merge";
import { enqueueEmail } from "../send/enqueue";

/**
 * Winback pools: the nightly refresh (SQL refresh_winback_pools) decides who is in a pool and when they become
 * workable; this runner sends the pool's steps through the outbox and advances them. Each pool has its own
 * templates in Settings (templates named "Winback — <pool> — step N"); until a shop writes them, a short built-in
 * angle per step is used so the pool is never silent.
 */

export interface WinbackRunSummary {
  refreshed: number;
  due: number;
  emailed: number;
  skipped: number;
  finished: number;
}

const BUILT_IN: Record<string, { subject: string; body: string }[]> = {
  approved_unfunded: [
    {
      subject: "Your approval for {business} is still open",
      body: "Hi {first_name},\n\n{business} was approved and the approval is still open on my side. What stopped you from moving forward? If it was the terms, tell me what would work and I will go back to the lender.\n\n",
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
      body: "Hi {first_name},\n\nWhen we last looked, the lenders passed on {business} for a reason that usually clears with time. Enough has passed that it is worth another look. Send your latest statements here and I will reshop it: {upload_link}\n\n",
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
      body: "Hi {first_name},\n\nYou should be a good way through the advance you took. When it is about half paid, you may qualify for a renewal or a second position on better terms. Want me to run the numbers?\n\n",
    },
    {
      subject: "Renewal numbers for {business}",
      body: "Hi {first_name},\n\nIf the current advance is around half paid, now is the window. Send the latest statement and I will show you what a renewal looks like: {upload_link}\n\n",
    },
  ],
  paid_off: [
    {
      subject: "Congrats on paying off {business}'s advance",
      body: "Hi {first_name},\n\nNice work paying that off. Paid-off merchants get the best terms. If {business} could use capital for the next step, say the word and I will get numbers back the same day.\n\n",
    },
    {
      subject: "Best terms you will see for {business}",
      body: "Hi {first_name},\n\nA clean payoff puts {business} at the top of every lender's list. Happy to show you what that gets you. Just reply.\n\n",
    },
  ],
  cold: [
    {
      subject: "Still here if {business} needs capital",
      body: "Hi {first_name},\n\nIt has been a while since we spoke about {business}. If funding is on your mind, I am glad to run fresh numbers.\n\n",
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

interface DueMember {
  id: string;
  user_id: string;
  client_id: string;
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
}

export async function runWinback(args: {
  db: DbAccess;
  appUrl: string;
  now?: Date;
}): Promise<WinbackRunSummary> {
  const now = args.now ?? new Date();
  const s: WinbackRunSummary = { refreshed: 0, due: 0, emailed: 0, skipped: 0, finished: 0 };
  s.refreshed = await args.db.withSystem(
    async (q) =>
      (await q.query<{ added: number }>("select added from refresh_winback_pools()")).rows[0]
        ?.added ?? 0,
  );
  const due = await args.db.withSystem(
    async (q) =>
      (
        await q.query<DueMember>(
          `select m.id, m.user_id, m.client_id, m.pool, m.next_step, m.steps_sent, p.steps,
                  app.client_timezone(c) as timezone, c.contact_name, c.business_name, c.email,
                  u.name as sender_name, u.application_link, u.signature, c.unsubscribe_token as token,
                  t.subject as tpl_subject, t.body as tpl_body, app.template_may_auto_send(t.id) as tpl_ok
             from winback_members m
             join winback_pools p on p.key = m.pool
             join clients c on c.id = m.client_id
             join app_users u on u.id = m.user_id
             left join templates t on t.owner_id is null and not t.archived and lower(t.name) = lower('Winback — ' || p.name || ' — step ' || m.next_step)
            where m.status = 'active' and m.next_due_on <= (($1::timestamptz at time zone app.client_timezone(c))::date)
              and c.contact_status = 'ok' and not c.email_opt_out
              and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
            order by m.next_due_on`,
          [now.toISOString()],
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
      const body = resolveMergeFields(wording.body, values);
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

/** The Winback board rows, by pool, for the signed-in user (RLS). */
export async function listWinback(q: Db): Promise<
  {
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
  }[]
> {
  const { rows } = await q.query(
    `select m.pool, p.name as pool_name, m.id, m.client_id, m.deal_id, c.business_name, c.contact_name, c.phone, c.email, m.reason,
            m.workable_on::text, m.status, m.steps_sent, m.next_due_on::text,
            (select max(e.received_at) from inbound_emails e where e.client_id = m.client_id and e.kind = 'merchant')::text as last_reply_at,
            (select max(o.amount_cents) from offers o where o.client_id = m.client_id) as best_offer_cents
       from winback_members m join winback_pools p on p.key = m.pool join clients c on c.id = m.client_id
      where m.status in ('waiting', 'active', 'replied', 'stopped')
        and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
      order by p.sort, case m.status when 'replied' then 0 when 'active' then 1 when 'waiting' then 2 else 3 end, m.workable_on`,
  );
  return rows;
}
