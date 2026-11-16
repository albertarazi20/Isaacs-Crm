import Link from "next/link";
import { ProposalDecision } from "@/components/deals/ProposalDecision";
import { LenderChip } from "@/components/submissions/LenderChip";
import { OpsActions } from "@/components/submissions/OpsActions";
import { Card, EmptyState, SectionTitle, cn } from "@/components/ui";
import { requirePage } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import {
  boardFilters,
  isDealFilter,
  listBoardSubmissions,
  listDeals,
  type BoardSubmission,
} from "@/lib/deals/queries";
import { DEAL_STATUS_LABELS, type DealCard, type DealFilter } from "@/lib/deals/types";
import { db } from "@/lib/db";
import { timeAgo } from "@/lib/format";
import { listProposed } from "@/lib/inbox/process";
import { formatMoneyCompact } from "@/lib/money";
import { requestTimeMs } from "@/lib/server-time";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANES: { key: DealFilter; label: string; hint: string }[] = [
  { key: "working_ops", label: "Queued", hint: "New files from the reps" },
  { key: "kicked_back", label: "Kicked back", hint: "Waiting on the rep" },
  { key: "pending_lenders", label: "With lenders", hint: "No answer yet" },
  { key: "stips_needed", label: "Stips", hint: "A lender asked for more" },
  { key: "needs_pitch", label: "Approved", hint: "Present it" },
  { key: "pitched", label: "Presented", hint: "Get the yes" },
  { key: "contracts_out", label: "Closing", hint: "Contracts and funding calls" },
  { key: "expiring", label: "Expiring", hint: "Approvals about to lapse" },
  { key: "no_response_24h", label: "Quiet 24h+", hint: "Lenders to chase" },
  { key: "live", label: "All live", hint: "" },
];

function Row({
  d,
  subs,
  canEdit,
  manager,
  nowMs,
}: {
  d: DealCard;
  subs: BoardSubmission[];
  canEdit: boolean;
  manager: boolean;
  nowMs: number;
}) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/deals/${d.id}`} className="font-semibold hover:underline">
            {d.business_name}
          </Link>
          <span className="ml-2 text-xs text-muted">
            D-{d.number} · {d.rep_name}
            {d.requested_cents ? ` · asks ${formatMoneyCompact(d.requested_cents)}` : ""}
            {d.state ? ` · ${d.state}` : ""}
          </span>
          <p className="text-xs text-muted">
            <span className="rounded bg-accent-soft px-1.5 py-0.5 font-semibold text-accent">
              {DEAL_STATUS_LABELS[d.status]}
            </span>
            {d.kickback_reason ? (
              <span className="ml-2 text-bad">
                {d.kickback_note || d.kickback_reason.replace(/_/g, " ")}
              </span>
            ) : null}
            {d.blocker && !d.kickback_reason ? <span className="ml-2">{d.blocker}</span> : null}
            <span className="ml-2">
              · {d.last_activity_at ? timeAgo(d.last_activity_at, new Date(nowMs)) : "no activity"}
            </span>
          </p>
        </div>
        {canEdit ? <OpsActions dealId={d.id} status={d.status} /> : null}
      </div>
      {subs.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {subs.map((s) => (
            <LenderChip key={s.id} s={s} canEdit={canEdit || manager} />
          ))}
        </div>
      ) : d.status !== "working_ops" && d.status !== "kicked_back" ? (
        <p className="mt-1 text-xs text-muted">No lender rows yet — open the deal to send it.</p>
      ) : null}
    </li>
  );
}

export default async function SubmissionBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ lane?: string; rep?: string; lender?: string; tab?: string }>;
}) {
  const sp = await searchParams;
  const session = await requirePage("/board");
  const canEdit = CAN.runOps(session.role);
  const manager = CAN.seeEveryone(session.role);
  const lane: DealFilter = sp.lane && isDealFilter(sp.lane) ? sp.lane : "working_ops";
  const repId = sp.rep && UUID.test(sp.rep) ? sp.rep : null;
  const funderId = sp.lender && UUID.test(sp.lender) ? sp.lender : null;
  const review = sp.tab === "review";
  const data = await db.withUser(session.userId, async (q) => {
    const filters = await boardFilters(q);
    const counts: Record<string, number> = {};
    for (const l of LANES) counts[l.key] = (await listDeals(q, l.key, { repId, funderId })).length;
    const deals = review ? [] : await listDeals(q, lane, { repId, funderId });
    const subs = await listBoardSubmissions(
      q,
      deals.map((d) => d.id),
    );
    const proposed = manager || canEdit ? await listProposed(q) : [];
    return { filters, counts, deals, subs, proposed };
  });
  const { filters, counts, deals, subs, proposed } = data;
  const byDeal = new Map<string, BoardSubmission[]>();
  for (const s of subs) byDeal.set(s.deal_id, [...(byDeal.get(s.deal_id) ?? []), s]);
  const nowMs = requestTimeMs();
  const qs = (over: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const all = {
      lane: lane === "working_ops" ? null : lane,
      rep: repId,
      lender: funderId,
      tab: review ? "review" : null,
      ...over,
    };
    for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/board?${s}` : "/board";
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Submission Board</h1>
          <p className="text-sm text-muted">
            Every file with ops or with lenders. The lender chips are the status — change them here;
            the AI keeps them current from email.
          </p>
        </div>
        <form className="flex flex-wrap gap-2" action="/board" method="get">
          {lane !== "working_ops" ? <input type="hidden" name="lane" value={lane} /> : null}
          <select
            name="rep"
            defaultValue={repId ?? ""}
            className="h-9 rounded-lg border border-border bg-surface px-2 text-sm"
          >
            <option value="">Every rep</option>
            {filters.reps.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <select
            name="lender"
            defaultValue={funderId ?? ""}
            className="h-9 rounded-lg border border-border bg-surface px-2 text-sm"
          >
            <option value="">Every lender</option>
            {filters.lenders.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="h-9 rounded-lg border border-border px-3 text-sm font-semibold hover:bg-surface-2"
          >
            Filter
          </button>
        </form>
      </div>

      <nav aria-label="Lane" className="flex flex-wrap gap-1.5">
        {LANES.map((l) => (
          <Link
            key={l.key}
            href={qs({ lane: l.key === "working_ops" ? null : l.key, tab: null })}
            aria-current={!review && l.key === lane ? "page" : undefined}
            title={l.hint}
            className={cn(
              "rounded-full border px-3 py-1 text-sm transition",
              !review && l.key === lane
                ? "border-accent bg-accent-soft text-accent"
                : "border-border text-muted hover:text-text",
            )}
          >
            {l.label}
            {counts[l.key] ? (
              <span className="ml-1 tabular-nums opacity-70">{counts[l.key]}</span>
            ) : null}
          </Link>
        ))}
        {manager || canEdit ? (
          <Link
            href={qs({ tab: "review" })}
            aria-current={review ? "page" : undefined}
            className={cn(
              "rounded-full border px-3 py-1 text-sm transition",
              review
                ? "border-accent bg-accent-soft text-accent"
                : proposed.length > 0
                  ? "border-warn/50 bg-warn-soft text-warn"
                  : "border-border text-muted hover:text-text",
            )}
          >
            Review tray
            {proposed.length ? <span className="ml-1 tabular-nums">{proposed.length}</span> : null}
          </Link>
        ) : null}
      </nav>

      {review ? (
        proposed.length === 0 ? (
          <EmptyState title="Nothing to review">
            When the AI reads an approval, a decline or an offer in a lender&apos;s email, it lands
            here for a manager&apos;s yes before it touches the deal.
          </EmptyState>
        ) : (
          <Card className="p-0">
            <ul className="divide-y divide-border">
              {proposed.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      <Link href={`/deals/${p.deal_id}`} className="hover:underline">
                        {p.business_name}
                      </Link>
                      <span className="ml-2 text-xs font-normal text-muted">
                        D-{p.deal_number} · {p.funder_name ?? p.from_address} ·{" "}
                        {Math.round(p.confidence * 100)}% sure
                      </span>
                    </p>
                    <p className="text-sm">{p.summary}</p>
                    {p.evidence.length > 0 ? (
                      <ul className="mt-1 space-y-0.5 text-xs text-muted">
                        {p.evidence.slice(0, 3).map((e, i) => (
                          <li key={i}>
                            <span className="font-medium">{e.field}:</span> “{e.quote}”
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {p.next_step ? <p className="mt-1 text-xs text-accent">{p.next_step}</p> : null}
                  </div>
                  {CAN.editOffers(session.role) ? (
                    <ProposalDecision id={p.id} />
                  ) : (
                    <span className="text-xs text-muted">manager decides</span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )
      ) : deals.length === 0 ? (
        <EmptyState title="Nothing in this lane">
          {LANES.find((l) => l.key === lane)?.hint || "Nothing matches."}
        </EmptyState>
      ) : (
        <Card className="p-0">
          <div className="px-4 pt-3">
            <SectionTitle aside={<span className="text-xs text-muted">{deals.length}</span>}>
              {LANES.find((l) => l.key === lane)?.label}
            </SectionTitle>
          </div>
          <ul className="divide-y divide-border">
            {deals.map((d) => (
              <Row
                key={d.id}
                d={d}
                subs={byDeal.get(d.id) ?? []}
                canEdit={canEdit}
                manager={manager}
                nowMs={nowMs}
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
