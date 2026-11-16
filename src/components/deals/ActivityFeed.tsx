import { formatDate } from "@/lib/format";
import type { TimelineEvent, TimelineKind } from "@/lib/deals/timeline";
import { Badge, cn } from "@/components/ui";
import { ProposalDecision } from "./ProposalDecision";

type Tone = "neutral" | "good" | "warn" | "bad" | "accent" | "info";
const KIND: Record<TimelineKind, { label: string; tone: Tone }> = {
  note: { label: "Note", tone: "neutral" },
  call: { label: "Call", tone: "accent" },
  email_in: { label: "Email in", tone: "good" },
  email_out: { label: "Sent", tone: "neutral" },
  ai: { label: "AI read", tone: "accent" },
  lender: { label: "Lender", tone: "warn" },
  offer: { label: "Offer", tone: "good" },
  document: { label: "Document", tone: "neutral" },
  funding: { label: "Funded", tone: "good" },
  ops: { label: "Ops", tone: "neutral" },
  system: { label: "System", tone: "neutral" },
};

function when(iso: string, today: string, timezone: string): string {
  const d = iso.slice(0, 10);
  const t = new Date(iso);
  const hm = t.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
  return d === today ? hm : `${formatDate(d, today)} ${hm}`;
}

/**
 * The deal's timeline, newest first: one row per event with the kind as a badge in its own column, the text,
 * and who and when on the right. AI proposals a manager still has to decide carry Accept / Reject. Sits in a
 * `p-0` card — the rows carry their own padding.
 */
export function ActivityFeed({
  events,
  today,
  canDecide,
  timezone = "America/New_York",
}: {
  events: TimelineEvent[];
  today: string;
  canDecide: boolean;
  /** The viewer's zone for the hour (P2-19); the date part already follows the session zone. */
  timezone?: string;
}) {
  if (events.length === 0) return <p className="px-4 py-4 text-sm text-muted">Nothing yet.</p>;
  return (
    <ol className="divide-y divide-border">
      {events.map((e) => (
        <li
          key={`${e.ref_type}-${e.ref_id}-${e.at}`}
          className={cn(
            "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 py-2.5 sm:grid-cols-[5.5rem_minmax(0,1fr)_auto] sm:px-5",
            e.needs_review && "bg-accent-soft/40",
          )}
        >
          <span className="pt-0.5">
            <Badge tone={KIND[e.kind].tone}>{KIND[e.kind].label}</Badge>
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">{e.title}</span>
            {e.detail ? (
              <span className="block text-xs whitespace-pre-wrap text-muted">{e.detail}</span>
            ) : null}
          </span>
          <span className="col-start-2 text-[11px] whitespace-nowrap text-muted tabular-nums sm:col-start-3 sm:row-start-1 sm:pt-0.5 sm:text-right">
            {e.actor} · {when(e.at, today, timezone)}
          </span>
          {e.needs_review ? (
            <span className="col-start-2 flex justify-start sm:col-start-3 sm:row-start-2 sm:justify-end">
              {e.ref_type === "proposed_update" && canDecide ? (
                <ProposalDecision id={e.ref_id} />
              ) : !canDecide ? (
                <span className="text-xs text-muted">waiting for a manager</span>
              ) : null}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
