import { formatDate } from "@/lib/format";
import type { TimelineEvent, TimelineKind } from "@/lib/deals/timeline";
import { cn } from "@/components/ui";
import { ProposalDecision } from "./ProposalDecision";

const KIND: Record<TimelineKind, { label: string; tone: string }> = {
  note: { label: "Note", tone: "bg-surface-2 text-muted" },
  call: { label: "Call", tone: "bg-accent-soft text-accent" },
  email_in: { label: "Email in", tone: "bg-good-soft text-good" },
  email_out: { label: "Sent", tone: "bg-surface-2 text-muted" },
  ai: { label: "AI read", tone: "bg-accent-soft text-accent" },
  lender: { label: "Lender", tone: "bg-warn-soft text-warn" },
  offer: { label: "Offer", tone: "bg-good-soft text-good" },
  document: { label: "Document", tone: "bg-surface-2 text-muted" },
  funding: { label: "Funded", tone: "bg-good-soft text-good" },
  ops: { label: "Ops", tone: "bg-surface-2 text-muted" },
  system: { label: "System", tone: "bg-surface-2 text-muted" },
};

function when(iso: string, today: string): string {
  const d = iso.slice(0, 10);
  const t = new Date(iso);
  const hm = t.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
  return d === today ? hm : `${formatDate(d, today)} ${hm}`;
}

/** The deal's timeline, newest first. AI proposals a manager still has to decide carry Accept / Reject. */
export function ActivityFeed({
  events,
  today,
  canDecide,
}: {
  events: TimelineEvent[];
  today: string;
  canDecide: boolean;
}) {
  if (events.length === 0) return <p className="text-sm text-muted">Nothing yet.</p>;
  return (
    <ol className="divide-y divide-border">
      {events.map((e) => (
        <li
          key={`${e.ref_type}-${e.ref_id}-${e.at}`}
          className={cn("flex gap-3 py-2.5", e.needs_review && "bg-accent-soft/40 -mx-4 px-4")}
        >
          <span
            className={cn(
              "mt-0.5 h-fit shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold",
              KIND[e.kind].tone,
            )}
          >
            {KIND[e.kind].label}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{e.title}</span>
            {e.detail ? (
              <span className="block text-xs text-muted whitespace-pre-wrap">{e.detail}</span>
            ) : null}
            <span className="block text-[11px] text-muted">
              {e.actor} · {when(e.at, today)}
            </span>
          </span>
          {e.needs_review && e.ref_type === "proposed_update" && canDecide ? (
            <ProposalDecision id={e.ref_id} />
          ) : null}
          {e.needs_review && !canDecide ? (
            <span className="text-xs text-muted">waiting for a manager</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
