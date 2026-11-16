import Link from "next/link";
import { ProposalDecision } from "@/components/deals/ProposalDecision";
import { AppliedUpdatesCard, ChaseDraftsCard } from "@/components/deals/ReviewTray";
import { DealStatusBadge, FilterChip, Icon, PageHeader } from "@/components/deals/primitives";
import { LenderChip } from "@/components/submissions/LenderChip";
import { OpsActions } from "@/components/submissions/OpsActions";
import { Card, EmptyState, SectionTitle, buttonClass } from "@/components/ui";
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
import { listAppliedUpdates } from "@/lib/inbox/appliedUpdates";
import { listChaseDrafts } from "@/lib/inbox/chaseDrafts";
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

const SELECT =
  "h-10 rounded-lg border border-border bg-surface px-3 text-sm text-text transition hover:border-border-strong focus:border-accent focus:ring-2 focus:ring-ring focus:outline-none sm:h-9";

/** "2 approved · 1 declined · 1 waiting" for the row's lender summary. */
function lenderSummary(subs: BoardSubmission[]): string {
  const n = (f: (s: BoardSubmission) => boolean) => subs.filter(f).length;
  const bits = [
    [n((s) => ["approved", "revised"].includes(s.status)), "approved"],
    [n((s) => s.status === "declined"), "declined"],
    [n((s) => s.status === "stips_requested"), "stips"],
    [n((s) => s.status === "sent"), "waiting"],
  ] as const;
  return bits
    .filter(([c]) => c > 0)
    .map(([c, w]) => `${c} ${w}`)
    .join(" · ");
}

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
  const summary = lenderSummary(subs);
  return (
    <li className="px-4 py-3 sm:py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              href={`/deals/${d.id}`}
              className="max-w-full truncate text-sm font-semibold hover:underline"
            >
              {d.business_name}
            </Link>
            <DealStatusBadge status={d.status} label={DEAL_STATUS_LABELS[d.status]} />
            <span className="text-xs text-muted">
              D-{d.number} · {d.rep_name}
              {d.requested_cents ? ` · asks ${formatMoneyCompact(d.requested_cents)}` : ""}
              {d.state ? ` · ${d.state}` : ""}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {d.kickback_reason ? (
              <span className="font-medium text-bad">
                {d.kickback_note || d.kickback_reason.replace(/_/g, " ")}
              </span>
            ) : null}
            {d.blocker && !d.kickback_reason ? <span>{d.blocker}</span> : null}
            {d.kickback_reason || d.blocker ? " · " : ""}
            {d.last_activity_at ? timeAgo(d.last_activity_at, new Date(nowMs)) : "no activity"}
          </p>
        </div>
        {canEdit ? <OpsActions dealId={d.id} clientId={d.client_id} status={d.status} /> : null}
      </div>
      {subs.length > 0 ? (
        <details open className="group mt-2">
          <summary className="inline-flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-md pr-2 text-xs font-medium text-muted transition select-none hover:text-text sm:h-7 [&::-webkit-details-marker]:hidden">
            <Icon name="chevron-right" className="size-3.5 group-open:rotate-90" />
            {subs.length} lender{subs.length === 1 ? "" : "s"}
            {summary ? <span className="font-normal">· {summary}</span> : null}
          </summary>
          <ul className="mt-1 divide-y divide-border rounded-lg border border-border bg-surface-3/60">
            {subs.map((s) => (
              <LenderChip key={s.id} s={s} canEdit={canEdit || manager} />
            ))}
          </ul>
        </details>
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
    const chaseDrafts = manager || canEdit ? await listChaseDrafts(q) : [];
    const applied = review && (manager || canEdit) ? await listAppliedUpdates(q) : [];
    return { filters, counts, deals, subs, proposed, chaseDrafts, applied };
  });
  const { filters, counts, deals, subs, proposed, chaseDrafts, applied } = data;
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
  const current = LANES.find((l) => l.key === lane);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Submission Board"
        context="Every file with ops or with lenders. The lender chips are the status — change them here; the AI keeps them current from email."
        actions={
          <form className="flex flex-wrap items-center gap-2" action="/board" method="get">
            {lane !== "working_ops" ? <input type="hidden" name="lane" value={lane} /> : null}
            <select name="rep" defaultValue={repId ?? ""} className={SELECT}>
              <option value="">Every rep</option>
              {filters.reps.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <select name="lender" defaultValue={funderId ?? ""} className={SELECT}>
              <option value="">Every lender</option>
              {filters.lenders.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <button type="submit" className={buttonClass("secondary", "md")}>
              <Icon name="filter" className="size-3.5 text-muted" />
              Filter
            </button>
          </form>
        }
      />

      <nav aria-label="Lane" className="flex flex-wrap gap-1.5">
        {LANES.map((l) => (
          <FilterChip
            key={l.key}
            href={qs({ lane: l.key === "working_ops" ? null : l.key, tab: null })}
            active={!review && l.key === lane}
            count={counts[l.key]}
            title={l.hint}
          >
            {l.label}
          </FilterChip>
        ))}
        {manager || canEdit ? (
          <FilterChip
            href={qs({ tab: "review" })}
            active={review}
            count={proposed.length + chaseDrafts.length}
            tone={proposed.length + chaseDrafts.length > 0 ? "warn" : "neutral"}
          >
            Review tray
          </FilterChip>
        ) : null}
      </nav>

      {review ? (
        <div className="space-y-6">
          {proposed.length === 0 ? (
            <EmptyState title="Nothing to review">
              When the AI reads an approval, a decline or an offer in a lender&apos;s email, it
              lands here for a manager&apos;s yes before it touches the deal.
            </EmptyState>
          ) : (
            <Card className="p-0">
              <ul className="divide-y divide-border">
                {proposed.map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1 basis-64">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
                        <Link href={`/deals/${p.deal_id}`} className="hover:underline">
                          {p.business_name}
                        </Link>
                        <span className="text-xs font-normal text-muted">
                          D-{p.deal_number} · {p.funder_name ?? p.from_address} ·{" "}
                          {Math.round(p.confidence * 100)}% sure
                        </span>
                      </p>
                      <p className="mt-0.5 text-sm">{p.summary}</p>
                      {p.evidence.length > 0 ? (
                        <ul className="mt-1 space-y-0.5 border-l-2 border-border pl-2.5 text-xs text-muted">
                          {p.evidence.slice(0, 3).map((e, i) => (
                            <li key={i}>
                              <span className="font-medium text-text-2">{e.field}:</span> “{e.quote}
                              ”
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {p.next_step ? (
                        <p className="mt-1 flex items-center gap-1 text-xs text-accent">
                          <Icon name="sparkles" className="size-3.5" />
                          {p.next_step}
                        </p>
                      ) : null}
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
          )}
          <ChaseDraftsCard drafts={chaseDrafts} canSend={canEdit} nowMs={nowMs} />
          <AppliedUpdatesCard
            updates={applied}
            manager={CAN.editOffers(session.role)}
            nowMs={nowMs}
          />
        </div>
      ) : deals.length === 0 ? (
        <EmptyState title="Nothing in this lane">{current?.hint || "Nothing matches."}</EmptyState>
      ) : (
        <Card className="p-0">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
            <SectionTitle
              aside={
                <span className="text-xs text-muted">
                  {deals.length}
                  {current?.hint ? (
                    <span className="hidden sm:inline"> · {current.hint}</span>
                  ) : null}
                </span>
              }
            >
              {current?.label}
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
