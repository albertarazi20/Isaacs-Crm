/**
 * What the assistant suggests you work on next. Each recommendation is a workflow: a short title, why it matters,
 * how many merchants it touches, a link to do it yourself, and the brief the assistant gets when you click "Plan it"
 * (it then reads the merchants, writes the steps and sets up the actions you can run).
 *
 * `buildRecommendations` is pure, so the rules are tested without a database; `loadRecommendations` reads the facts
 * under the caller's row security, so a rep gets their own book and a manager the shop.
 */
import { bucketScores } from "../buckets/queries";
import { monthOf } from "../dashboard/queries";
import type { Db } from "../db";
import { loadOverview, type QueueKind } from "../followup/overview";
import type { ISODate } from "../mca/dates";

export type RecommendationTone = "accent" | "warn" | "good" | "bad" | "info";
export type RecommendationIcon =
  | "reply"
  | "clock"
  | "flag"
  | "phone"
  | "file"
  | "alert"
  | "mail"
  | "sparkles"
  | "trend"
  | "zap"
  | "merchants";

export interface Recommendation {
  /** Stable key, one per rule. */
  id: string;
  title: string;
  /** One line: why this is worth doing now. */
  why: string;
  /** How many merchants (or emails) it touches; 0 for a setup task. */
  count: number;
  tone: RecommendationTone;
  icon: RecommendationIcon;
  /** Do it yourself, without the assistant. */
  href: string;
  /** The brief the assistant gets when the person clicks the recommendation. */
  prompt: string;
  /** Higher comes first. */
  weight: number;
}

export interface RecommendationFacts {
  manager: boolean;
  replyWaiting: number;
  overdue: number;
  readyToHandOff: number;
  readyBucketId: string | null;
  /** Merchants on the "do this now" list, by why they are on it. */
  queue: Partial<Record<QueueKind, number>>;
  /** In a documents bucket, not touched for 7 days or more. */
  quietMissingDocs: number;
  postalAddressSet: boolean;
  gmailConnected: boolean;
  /** Buckets whose email is not landing: enough sends and almost no replies or documents. */
  weakBuckets: { id: string; name: string; sent: number; replies: number; docsIn: number }[];
  /** Managers only: the rep with the most follow-ups past due, when it is worth a word. */
  repBehind: { name: string; overdue: number } | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function buildRecommendations(f: RecommendationFacts): Recommendation[] {
  const out: Recommendation[] = [];
  const q = (k: QueueKind) => f.queue[k] ?? 0;

  if (!f.postalAddressSet)
    out.push({
      id: "postal-address",
      title: "Turn automated follow-up back on",
      why: "Bucket emails are on hold until the shop's postal address is set.",
      count: 0,
      tone: "bad",
      icon: "alert",
      href: "/settings/email",
      prompt:
        "Automated follow-up emails are on hold because the shop has no postal address. Explain in two sentences why the address is required, then walk me through setting it in Settings, Email, and tell me what starts sending once it is saved.",
      weight: 100,
    });

  if (f.replyWaiting > 0)
    out.push({
      id: "replies",
      title: `Answer ${plural(f.replyWaiting, "merchant")} who wrote back`,
      why: "A reply answered within the hour is the most likely to send documents.",
      count: f.replyWaiting,
      tone: "accent",
      icon: "reply",
      href: "/",
      prompt: `${plural(f.replyWaiting, "merchant")} wrote back and ${f.replyWaiting === 1 ? "is" : "are"} waiting for an answer. Read each reply and the merchant's file, tell me who to answer first and why, write a short answer for each that asks for exactly what is still missing, and set up the actions (a note with the answer to copy, and the next follow-up date).`,
      weight: 90,
    });

  if (q("opened") > 0)
    out.push({
      id: "opened",
      title: `Call ${plural(q("opened"), "merchant")} who just opened their link`,
      why: "They looked at the application or the upload page and stopped. Call while it is fresh.",
      count: q("opened"),
      tone: "warn",
      icon: "zap",
      href: "/",
      prompt: `${plural(q("opened"), "merchant")} opened their application or upload link in the last two days and did not finish. Find them (the overview's do-this-now list marks them "opened"), read each file, tell me who to call first and what to say so they finish it on the call, and set up the actions.`,
      weight: 88,
    });

  if (f.readyToHandOff > 0)
    out.push({
      id: "ready",
      title: `Hand off ${plural(f.readyToHandOff, "merchant")}`,
      why: "Their application and documents are in. Handing off stops the chase and counts the win.",
      count: f.readyToHandOff,
      tone: "good",
      icon: "flag",
      href: f.readyBucketId ? `/follow-up?b=${f.readyBucketId}` : "/follow-up",
      prompt: `${plural(f.readyToHandOff, "merchant")} ${f.readyToHandOff === 1 ? "is" : "are"} in the Ready to hand off bucket. Check each file: is the signed application in and are the required documents received? For each complete file set up a Hand off action; for anything missing, say what is missing and set up the follow-up instead.`,
      weight: 85,
    });

  if (q("call_now") > 0)
    out.push({
      id: "new-leads",
      title: `Call ${plural(q("call_now"), "new lead")}`,
      why: "Nobody has spoken to them yet. The first hour after a lead lands decides most of them.",
      count: q("call_now"),
      tone: "info",
      icon: "phone",
      href: "/today",
      prompt: `${plural(q("call_now"), "new lead")} ${q("call_now") === 1 ? "has" : "have"} not been contacted yet. Put them in the order I should call them and say why, give me a 3-line opener for the first call that leads to the application, and set up the follow-up dates for anyone I cannot reach today.`,
      weight: 80,
    });

  if (f.overdue > 0)
    out.push({
      id: "overdue",
      title: `Clear ${plural(f.overdue, "overdue follow-up")}`,
      why: "Every day past the date costs a little more of the merchant's interest.",
      count: f.overdue,
      tone: "warn",
      icon: "clock",
      href: "/today",
      prompt: `I have ${plural(f.overdue, "follow-up")} past due. Build me a plan to clear them today: which ones to call first and why, which ones to move to a new date or pause, and what to say on the calls that matter most. Set up the date changes and notes as actions.`,
      weight: 70 + Math.min(f.overdue, 20) / 2,
    });

  if (f.quietMissingDocs > 0)
    out.push({
      id: "quiet-docs",
      title: `Wake up ${plural(f.quietMissingDocs, "merchant")} missing documents`,
      why: "They are still missing documents and have not heard from anyone in a week.",
      count: f.quietMissingDocs,
      tone: "warn",
      icon: "file",
      href: "/follow-up",
      prompt: `${plural(f.quietMissingDocs, "merchant")} in the document buckets ${f.quietMissingDocs === 1 ? "has" : "have"} not been touched in 7 days or more. Find them, say exactly what each one still owes, and write a short personal note I can send each that makes it easy to finish (the upload link does the rest). Set up the next follow-up dates as actions.`,
      weight: 60,
    });

  if (q("bounced") > 0)
    out.push({
      id: "bounced",
      title: `Fix ${plural(q("bounced"), "bounced email address", "bounced email addresses")}`,
      why: "Follow-up stops for these merchants until the address is right.",
      count: q("bounced"),
      tone: "bad",
      icon: "mail",
      href: "/",
      prompt: `${plural(q("bounced"), "merchant")} had email bounce. List them, suggest how to get a good address (a quick call, a text from my phone), and set up a follow-up for each.`,
      weight: 55,
    });

  for (const b of f.weakBuckets.slice(0, 1))
    out.push({
      id: `weak-bucket-${b.id}`,
      title: `Rework the ${b.name} emails`,
      why: `${plural(b.sent, "email")} went out in 90 days and ${plural(b.replies, "merchant")} replied.`,
      count: b.sent,
      tone: "info",
      icon: "trend",
      href: `/follow-up?b=${b.id}`,
      prompt: `The "${b.name}" bucket sent ${plural(b.sent, "email")} in the last 90 days, got ${plural(b.replies, "reply", "replies")} and ${plural(b.docsIn, "merchant")} sent documents. Read its sequence, tell me what is likely not working, and write a better first email (subject and body, under 90 words, plain, one clear ask). I will paste it into the template myself.`,
      weight: 40,
    });

  if (f.manager && f.repBehind)
    out.push({
      id: "rep-behind",
      title: `Check in with ${f.repBehind.name}`,
      why: `${plural(f.repBehind.overdue, "follow-up")} past due on their book.`,
      count: f.repBehind.overdue,
      tone: "warn",
      icon: "merchants",
      href: "/",
      prompt: `${f.repBehind.name} has ${plural(f.repBehind.overdue, "follow-up")} past due. Look at the team numbers this month and tell me what is going on with their book compared with the others, and give me three specific things to go over with them.`,
      weight: 35,
    });

  if (!f.gmailConnected)
    out.push({
      id: "gmail",
      title: "Send from your own Gmail",
      why: "Merchants answer a person faster than a shop address.",
      count: 0,
      tone: "info",
      icon: "mail",
      href: "/settings",
      prompt:
        "My Gmail is not connected. Explain in a few lines what changes once it is (which emails go out from my address, where replies land), and walk me through connecting it in Settings, My account.",
      weight: 20,
    });

  return out.sort((a, b) => b.weight - a.weight);
}

export { PLAN_MY_DAY } from "./prompts";

/** `gmailConnected` comes from gmailStatus (the token table is not readable under row security, on purpose). */
export async function loadRecommendationFacts(
  q: Db,
  args: { today: ISODate; manager: boolean; gmailConnected: boolean },
): Promise<RecommendationFacts> {
  const o = await loadOverview(q, {
    today: args.today,
    month: monthOf(args.today),
    manager: args.manager,
  });
  // counted on their own: the "do this now" list is capped at 25 and shows one reason per merchant
  const counts = await q.query<{ new_leads: number; bounced: number; opened: number }>(
    `select
       -- the "do this now" list's own rule: the newest link opened, unfinished, never do-not-contact
       (select count(*)::int from clients c
          join lateral (select lo.kind, max(lo.opened_at) as at from link_opens lo
                         where lo.client_id = c.id and lo.opened_at > now() - interval '48 hours'
                         group by lo.kind order by max(lo.opened_at) desc limit 1) o on true
         where c.brought_in_at is null and c.contact_status <> 'dnc'
           and not exists (select 1 from trashed_clients t where t.client_id = c.id)
           and not (o.kind = 'apply' and exists (select 1 from applications a
                                                  where a.client_id = c.id and a.signed_at >= o.at))
           and not (o.kind = 'upload' and exists (select 1 from documents d where d.client_id = c.id
                                                   and d.deleted_at is null and d.created_at >= o.at))) as opened,
       (select count(*)::int from clients c
         where c.brought_in_at is null and c.created_at > now() - interval '24 hours' and c.contact_status <> 'dnc'
           and not exists (select 1 from activities a where a.client_id = c.id and a.kind = 'call')
           and not exists (select 1 from trashed_clients t where t.client_id = c.id)) as new_leads,
       (select count(*)::int from clients c
         where c.email_bounced_at is not null and c.brought_in_at is null
           and not exists (select 1 from trashed_clients t where t.client_id = c.id)) as bounced`,
  );
  const queue: Partial<Record<QueueKind, number>> = {
    opened: counts.rows[0]?.opened ?? 0,
    call_now: counts.rows[0]?.new_leads ?? 0,
    bounced: counts.rows[0]?.bounced ?? 0,
  };

  const quiet = await q.query<{ n: number }>(
    `select count(*)::int as n
       from enrollments e
       join buckets b on b.id = e.bucket_id
       join clients c on c.id = e.client_id
      where e.stopped_at is null
        and b.key in ('missing_app', 'missing_statements', 'missing_newest', 'missing_id')
        and c.brought_in_at is null
        and not exists (select 1 from trashed_clients t where t.client_id = c.id)
        and coalesce((select max(a.created_at) from activities a
                       where a.client_id = c.id and a.kind in ('call', 'text', 'email', 'note')), c.created_at)
            < now() - interval '7 days'`,
  );
  const shop = await q.query<{ postal: string }>(
    "select postal_address as postal from shop_settings",
  );
  const scores = await bucketScores(q, 90);
  const weakBuckets = scores
    .filter((s) => s.sent >= 20 && s.reply_rate < 0.03 && s.docs_rate < 0.03)
    .sort((a, b) => b.sent - a.sent)
    .map((s) => ({
      id: s.bucket_id,
      name: s.name,
      sent: s.sent,
      replies: s.replies,
      docsIn: s.docs_in,
    }));
  const behind =
    args.manager && o.reps ? ([...o.reps].sort((a, b) => b.overdue - a.overdue)[0] ?? null) : null;

  return {
    manager: args.manager,
    replyWaiting: o.kpis.replyWaiting,
    overdue: o.kpis.overdue,
    readyToHandOff: o.kpis.readyToHandOff,
    readyBucketId: o.buckets.find((b) => b.key === "ready_for_ops")?.id ?? null,
    queue,
    quietMissingDocs: quiet.rows[0]?.n ?? 0,
    postalAddressSet: (shop.rows[0]?.postal ?? "").trim() !== "",
    gmailConnected: args.gmailConnected,
    weakBuckets,
    repBehind:
      behind && behind.overdue >= 10 ? { name: behind.name, overdue: behind.overdue } : null,
  };
}

export async function loadRecommendations(
  q: Db,
  args: { today: ISODate; manager: boolean; gmailConnected: boolean },
): Promise<Recommendation[]> {
  return buildRecommendations(await loadRecommendationFacts(q, args)).slice(0, 6);
}
