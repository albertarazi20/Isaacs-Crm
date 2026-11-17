"use client";

import { mintUploadLinkAction } from "@/app/docs-actions";
import { copyText } from "@/components/client/parts";
import { Badge, cn } from "@/components/ui";
import type { BucketMember } from "@/lib/buckets/queries";
import type { SequenceStep } from "@/lib/followup/bucketBoard";
import { formatDate, relativeDay } from "@/lib/format";
import type { ISODate } from "@/lib/mca/dates";
import type { MemberMeta } from "@/lib/messaging/memberMeta";
import { pausedLabel, replyChip } from "@/lib/messaging/replyTagLabels";
import { stepTitle } from "./bucketCopy";

/** Small line icons this area needs that the shell's set does not carry. */
export function Ico({
  name,
  className,
}: {
  name: "pause" | "play" | "copy" | "chevron";
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className ?? "size-4"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === "pause" ? (
        <path d="M8.5 5v14M15.5 5v14" />
      ) : name === "play" ? (
        <path d="M7 4.5v15l12-7.5z" />
      ) : name === "copy" ? (
        <>
          <rect x="9" y="9" width="11" height="11" rx="2.5" />
          <path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" />
        </>
      ) : (
        <path d="m9 6 6 6-6 6" />
      )}
    </svg>
  );
}

/** True when the sequence cannot reach this merchant by email. */
export const noUsableEmail = (m: BucketMember): boolean =>
  !m.email || m.email_opt_out || m.email_bounced;

/** Every status a lead line carries, as chips. A merchant with nothing to flag reads "On track". */
export function MemberChips({
  m,
  meta,
  today,
  className,
}: {
  m: BucketMember;
  meta: MemberMeta | undefined;
  today: ISODate;
  className?: string;
}) {
  const chip = meta ? replyChip(meta.tag, meta.tag_revive_on, today) : null;
  const quiet =
    !m.paused && !chip && !m.reply_waiting && !noUsableEmail(m) && m.stips_missing === 0;
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      {m.reply_waiting ? <Badge tone="bad">Reply waiting</Badge> : null}
      {m.paused ? <Badge tone="warn">{pausedLabel(meta?.resume_on ?? null, today)}</Badge> : null}
      {chip ? <Badge tone={chip.tone}>{chip.label}</Badge> : null}
      {m.email_opt_out ? (
        <Badge tone="bad">Opted out</Badge>
      ) : m.email_bounced ? (
        <Badge tone="bad">Email bounced</Badge>
      ) : !m.email ? (
        <Badge>No email</Badge>
      ) : null}
      {m.stips_missing > 0 ? (
        <Badge>
          {m.stips_missing} doc{m.stips_missing === 1 ? "" : "s"} missing
        </Badge>
      ) : null}
      {quiet ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <span aria-hidden className="size-1.5 rounded-full bg-good" />
          On track
        </span>
      ) : null}
    </span>
  );
}

export interface NextUp {
  /** "Step 2" */
  step: string;
  /** What that step does: the subject the merchant will see, or the task it makes. */
  title: string;
  /** "Due today", "2 days overdue", "Paused"… */
  when: string;
  tone: "accent" | "bad" | "muted";
  /** The plain date, for a tooltip. */
  date: string | null;
}

/** What goes out next for one merchant, and when. */
export function nextUp(m: BucketMember, steps: readonly SequenceStep[], today: ISODate): NextUp {
  const s = steps.find((x) => x.step_no === m.next_step);
  const step = `Step ${m.next_step}`;
  const title = s ? stepTitle(s) : steps.length === 0 ? "No sequence" : "Sequence finished";
  const date = m.next_due_on ? formatDate(m.next_due_on, today) : null;
  if (m.paused) return { step, title, when: "Paused", tone: "muted", date };
  if (!s || !m.next_due_on) return { step, title, when: "Nothing scheduled", tone: "muted", date };
  const rel = relativeDay(m.next_due_on, today);
  if (m.next_due_on < today) return { step, title, when: rel, tone: "bad", date };
  if (m.next_due_on === today) return { step, title, when: "Due today", tone: "accent", date };
  return { step, title, when: `Due ${rel.toLowerCase()}`, tone: "muted", date };
}

export const NEXT_TONE: Record<NextUp["tone"], string> = {
  accent: "text-accent",
  bad: "text-bad",
  muted: "text-muted",
};

/** Mints the merchant's two-hour upload link and puts it on the clipboard. */
export async function copyUploadLink(
  clientId: string,
): Promise<{ ok: true; copied: boolean; url: string } | { ok: false; error: string }> {
  try {
    const r = await mintUploadLinkAction({ clientId });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, copied: await copyText(r.data.url), url: r.data.url };
  } catch {
    return { ok: false, error: "Couldn't reach the server. Check your connection" };
  }
}
