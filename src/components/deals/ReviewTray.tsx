import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { ChaseDraftActions, UndoAiUpdate } from "@/components/deals/ReviewTrayActions";
import { SUB_TONE } from "@/components/deals/primitives";
import { timeAgo } from "@/lib/format";
import type { AppliedUpdate } from "@/lib/inbox/appliedUpdates";
import type { ChaseDraft } from "@/lib/inbox/chaseDrafts";
import { SUBMISSION_STATUS_LABELS, type SubmissionStatus } from "@/lib/funders/types";

/*
 * The two lists under the proposals in the Review tray: nudges drafted for ops to send, and what the AI already
 * applied (with the way back for a manager). Server components; the buttons are the client file next door.
 */

const statusLabel = (s: string | null): string =>
  s === null ? "—" : (SUBMISSION_STATUS_LABELS[s as SubmissionStatus] ?? s.replace(/_/g, " "));

function ListHeader({ title, aside }: { title: string; aside: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-border px-4 py-2.5">
      <h2 className="text-[13px] font-semibold text-text">{title}</h2>
      <span className="text-xs text-muted">{aside}</span>
    </div>
  );
}

export function ChaseDraftsCard({
  drafts,
  canSend,
  nowMs,
}: {
  drafts: ChaseDraft[];
  canSend: boolean;
  nowMs: number;
}) {
  if (drafts.length === 0) return null;
  return (
    <Card className="p-0">
      <ListHeader
        title="Chase drafts"
        aside={`${drafts.length} waiting · a lender went quiet, the nudge is written`}
      />
      <ul className="divide-y divide-border">
        {drafts.map((d) => (
          <li
            key={d.id}
            data-chase-draft={d.funder_name ?? ""}
            data-chase-id={d.id}
            className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3"
          >
            <div className="min-w-0 flex-1 basis-64">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
                {d.deal_id ? (
                  <Link href={`/deals/${d.deal_id}`} className="hover:underline">
                    {d.business_name ?? "The deal"}
                  </Link>
                ) : (
                  (d.business_name ?? "A deal")
                )}
                <span className="text-xs font-normal text-muted">
                  {d.deal_number ? `D-${d.deal_number} · ` : ""}
                  {d.funder_name ?? "A lender"} · {timeAgo(d.created_at, new Date(nowMs))}
                </span>
                {d.moot ? <Badge tone="neutral">answered since</Badge> : null}
              </p>
              {d.why ? <p className="mt-0.5 text-xs text-muted">{d.why}</p> : null}
              <div className="mt-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs">
                {d.to ? (
                  <p className="text-muted">
                    To {d.to} · {d.subject}
                  </p>
                ) : null}
                <p className="mt-1 whitespace-pre-wrap text-text-2">{d.text}</p>
              </div>
            </div>
            <ChaseDraftActions
              alertId={d.id}
              moot={d.moot}
              canSend={canSend && d.submission_id !== null}
              copyBody={d.to ? `To: ${d.to}\nSubject: ${d.subject}\n\n${d.text}` : d.text}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function AppliedUpdatesCard({
  updates,
  manager,
  nowMs,
}: {
  updates: AppliedUpdate[];
  manager: boolean;
  nowMs: number;
}) {
  if (updates.length === 0) return null;
  return (
    <Card className="p-0">
      <ListHeader
        title="Applied by the AI"
        aside={`last 14 days${manager ? " · a manager can undo" : ""}`}
      />
      <ul className="divide-y divide-border">
        {updates.map((u) => (
          <li
            key={u.id}
            data-applied={u.funder_name ?? ""}
            data-applied-status={u.status}
            className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3"
          >
            <div className="min-w-0 flex-1 basis-64">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
                <Link href={`/deals/${u.deal_id}`} className="hover:underline">
                  {u.business_name}
                </Link>
                <span className="text-xs font-normal text-muted">
                  D-{u.deal_number} · {u.funder_name ?? "A lender"}
                  {u.source === "pasted" ? " · pasted" : ""} · {timeAgo(u.at, new Date(nowMs))}
                </span>
              </p>
              <p className="mt-0.5 text-sm">{u.summary}</p>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                {u.status === "reverted" ? (
                  <>Undone{u.reverted_by_name ? ` by ${u.reverted_by_name}` : ""}. Was</>
                ) : (
                  <>Before the update it was</>
                )}
                <Badge tone={SUB_TONE[u.previous_status ?? ""] ?? "neutral"}>
                  {statusLabel(u.previous_status)}
                </Badge>
                {u.status === "applied" && u.current_status !== null ? (
                  <>
                    · now
                    <Badge tone={SUB_TONE[u.current_status] ?? "neutral"}>
                      {statusLabel(u.current_status)}
                    </Badge>
                  </>
                ) : null}
              </p>
            </div>
            {u.status === "reverted" ? (
              <span className="text-xs text-muted">Undone</span>
            ) : u.can_undo && manager ? (
              <UndoAiUpdate id={u.id} removesOffer={u.created_offer} />
            ) : !manager ? (
              <span className="text-xs text-muted">manager undoes</span>
            ) : (
              <span className="text-xs text-muted">newer change on this row</span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
