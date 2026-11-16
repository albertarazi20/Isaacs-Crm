import Link from "next/link";
import { notFound } from "next/navigation";
import { SubmissionsCard } from "@/components/client/SubmissionsCard";
import { CopyContact } from "@/components/CopyContact";
import { ActivityFeed } from "@/components/deals/ActivityFeed";
import { ConfirmFundingButton } from "@/components/deals/ConfirmFundingButton";
import { DocumentsPanel } from "@/components/deals/DocumentsPanel";
import { FundDialog, type FundLender } from "@/components/deals/FundDialog";
import { NoteEditor } from "@/components/deals/NoteEditor";
import { ResubmitToOpsButton } from "@/components/deals/SubmitToOps";
import { UploadLinkButton } from "@/components/deals/UploadLinkButton";
import { Card, SectionTitle, cn } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { getClientDetail, userContext } from "@/lib/data/queries";
import { milestones, suggestNextStep, type Suggestion } from "@/lib/deals/nextStep";
import { getDeal } from "@/lib/deals/queries";
import { loadDealSnapshot } from "@/lib/deals/snapshot";
import { listDealTimeline } from "@/lib/deals/timeline";
import { DEAL_STATUS_LABELS } from "@/lib/deals/types";
import { db } from "@/lib/db";
import { logAccess } from "@/lib/trust/queries";
import { listLiveDocumentLinks } from "@/lib/docs/links";
import { clientFreshness, listDocuments } from "@/lib/docs/upload";
import { formatDate } from "@/lib/format";
import { getClientFundersData } from "@/lib/funders/queries";
import { formatMoneyCompact } from "@/lib/money";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABS = [
  { key: "overview", label: "Overview" },
  { key: "documents", label: "Documents" },
  { key: "activity", label: "Activity" },
  { key: "offers", label: "Lenders & offers" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const URGENCY: Record<Suggestion["urgency"], string> = {
  now: "border-bad/40 bg-bad-soft",
  today: "border-warn/40 bg-warn-soft",
  soon: "border-border bg-surface",
  none: "border-border bg-surface",
};

function NextStep({ s, dealId, clientId }: { s: Suggestion; dealId: string; clientId: string }) {
  const go = (tab: Tab) => `/deals/${dealId}?tab=${tab}`;
  let action: React.ReactNode = null;
  switch (s.action) {
    case "collect_stips":
      action = <UploadLinkButton clientId={clientId} dealId={dealId} size="md" />;
      break;
    case "answer":
      action = (
        <Link
          href={`/clients/${clientId}`}
          className="text-sm font-semibold text-accent hover:underline"
        >
          Open the merchant →
        </Link>
      );
      break;
    case "present":
    case "close":
    case "chase":
    case "contracts":
    case "fund":
      action = (
        <Link href={go("offers")} className="text-sm font-semibold text-accent hover:underline">
          Lenders & offers →
        </Link>
      );
      break;
    case "fix_file":
      action = (
        <Link href={go("documents")} className="text-sm font-semibold text-accent hover:underline">
          Documents →
        </Link>
      );
      break;
    default:
      action = null;
  }
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3",
        URGENCY[s.urgency],
      )}
    >
      <div className="min-w-0">
        <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">
          {s.urgency === "now"
            ? "Do now"
            : s.urgency === "today"
              ? "Today"
              : s.urgency === "soon"
                ? "Soon"
                : "Status"}
        </p>
        <p className="text-base font-semibold">{s.title}</p>
        <p className="text-sm text-muted">{s.why}</p>
      </div>
      {action}
    </div>
  );
}

export default async function DealPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; fund?: string }>;
}) {
  const { id } = await params;
  const { tab: rawTab, fund: rawFund } = await searchParams;
  if (!UUID.test(id)) notFound();
  const tab: Tab = (TABS.find((t) => t.key === rawTab)?.key ?? "overview") as Tab;
  // ?fund=<lender id> opens FUND on arrival with that lender picked ("Mark funded" on an accepted offer)
  const fund = typeof rawFund === "string" && rawFund !== "" ? rawFund : null;
  const hereWithoutFund = tab === "overview" ? `/deals/${id}` : `/deals/${id}?tab=${tab}`;
  const session = await requireSession();
  const manager = CAN.seeEveryone(session.role);
  const data = await db.withUser(session.userId, async (q) => {
    const ctx = await userContext(q);
    const deal = await getDeal(q, id);
    if (!deal) return null;
    // a manager or ops opening a rep's merchant is a contact view the trust panel counts (P2-51)
    if (deal.user_id !== session.userId)
      await logAccess(q, {
        userId: session.userId,
        action: "view_contact",
        clientId: deal.client_id,
        detail: `deal D-${deal.number}`,
      });
    const snapshot = await loadDealSnapshot(q, id, ctx.today);
    const timeline = tab === "activity" ? await listDealTimeline(q, id) : [];
    const documents = tab === "documents" ? await listDocuments(q, deal.client_id) : [];
    const links = tab === "documents" ? await listLiveDocumentLinks(q, deal.client_id) : [];
    const fresh = await clientFreshness(q, deal.client_id, ctx.today);
    const detail = tab === "offers" ? await getClientDetail(q, deal.client_id) : null;
    const funders = await getClientFundersData(q, deal.client_id);
    return { ctx, deal, snapshot, timeline, documents, links, fresh, detail, funders };
  });
  if (!data || !data.snapshot) notFound();
  const { ctx, deal, snapshot, timeline, documents, links, fresh, detail, funders } = data;
  const canSubmitToOps = CAN.workLeads(session.role);
  const next = suggestNextStep(snapshot);
  const chips = milestones(snapshot);
  const lendersForFund: FundLender[] = funders.submissions.map((s) => {
    const live =
      s.offers.find((o) => o.status === "accepted") ??
      s.offers.find((o) => o.status === "presented") ??
      s.offers.find((o) => o.status === "open") ??
      null;
    return { funderId: s.funder_id, name: s.funder_name, status: s.status, offer: live };
  });
  const canNote = (field: "rep_note" | "manager_note" | "ops_note") =>
    field === "rep_note"
      ? CAN.workLeads(session.role)
      : field === "ops_note"
        ? CAN.runOps(session.role)
        : manager;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/deals" className="text-xs font-medium text-muted hover:text-text">
            ← Deals
          </Link>
          <h1 className="mt-0.5 truncate text-2xl font-bold tracking-tight">
            {deal.business_name}{" "}
            <span className="text-base font-medium text-muted">D-{deal.number}</span>
          </h1>
          <p className="text-sm text-muted">
            <span className="rounded-md bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent">
              {DEAL_STATUS_LABELS[deal.status]}
            </span>
            {" · "}
            {deal.contact_name || "—"}
            {deal.phone ? (
              <>
                {" · "}
                <a href={`tel:${deal.phone}`} className="hover:underline">
                  {deal.phone}
                </a>
                <CopyContact clientId={deal.client_id} value={deal.phone} kind="phone" />
              </>
            ) : null}
            {deal.email ? (
              <>
                {" · "}
                <a href={`mailto:${deal.email}`} className="hover:underline">
                  {deal.email}
                </a>
                <CopyContact clientId={deal.client_id} value={deal.email} kind="email" />
              </>
            ) : null}
            {manager ? ` · ${deal.rep_name}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {deal.ops_status === "kicked_back" && deal.outcome === "open" && canSubmitToOps ? (
            <ResubmitToOpsButton clientId={deal.client_id} kind={deal.kind} />
          ) : null}
          {deal.requested_cents ? (
            <span className="text-sm text-muted">
              Asked{" "}
              <span className="font-semibold text-text">
                {formatMoneyCompact(deal.requested_cents)}
              </span>
            </span>
          ) : null}
          {deal.outcome === "open" && snapshot.funding && !snapshot.funding.confirmed ? (
            CAN.confirmFunding(session.role) && snapshot.funding.id ? (
              <ConfirmFundingButton fundingId={snapshot.funding.id} />
            ) : (
              <span className="rounded-lg bg-warn-soft px-3 py-1.5 text-sm font-semibold text-warn">
                FUND waiting for a manager
              </span>
            )
          ) : deal.outcome === "open" ? (
            <FundDialog
              key={fund ?? "closed"}
              clientId={deal.client_id}
              businessName={deal.business_name}
              lenders={lendersForFund}
              canConfirm={CAN.confirmFunding(session.role)}
              initialOpen={fund !== null}
              initialFunderId={fund}
              closeHref={hereWithoutFund}
            />
          ) : deal.funded_cents ? (
            <span className="rounded-lg bg-good-soft px-3 py-1.5 text-sm font-semibold text-good">
              Funded {formatMoneyCompact(deal.funded_cents)}
            </span>
          ) : null}
        </div>
      </div>

      <ol className="flex flex-wrap gap-1.5" aria-label="Milestones">
        {chips.map((m) => (
          <li
            key={m.key}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs font-medium",
              m.done
                ? "border-good/40 bg-good-soft text-good"
                : m.current
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border text-muted",
            )}
            title={m.on ? formatDate(m.on, ctx.today) : undefined}
          >
            {m.done ? "✓ " : ""}
            {m.label}
          </li>
        ))}
      </ol>

      <NextStep s={next} dealId={deal.id} clientId={deal.client_id} />

      <nav aria-label="Deal sections" className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "overview" ? `/deals/${deal.id}` : `/deals/${deal.id}?tab=${t.key}`}
            aria-current={t.key === tab ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              t.key === tab
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-text",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card className="space-y-4">
            <SectionTitle>Notes</SectionTitle>
            <NoteEditor
              dealId={deal.id}
              field="rep_note"
              label="Rep"
              text={deal.rep_note}
              readOnly={!canNote("rep_note")}
            />
            <NoteEditor
              dealId={deal.id}
              field="ops_note"
              label="Ops"
              text={deal.ops_note}
              readOnly={!canNote("ops_note")}
            />
            {manager ? (
              <NoteEditor
                dealId={deal.id}
                field="manager_note"
                label="Manager"
                text={deal.manager_note}
              />
            ) : null}
            {deal.blocker ? (
              <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
                <span className="font-semibold">Blocked:</span> {deal.blocker}
              </p>
            ) : null}
          </Card>
          <div className="space-y-5">
            <Card>
              <SectionTitle>The file</SectionTitle>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted">Kind</dt>
                  <dd className="font-medium capitalize">{deal.kind.replace("_", " ")}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Use of funds</dt>
                  <dd className="font-medium">{deal.use_of_funds || "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Industry · state</dt>
                  <dd className="font-medium">
                    {deal.industry || "—"} · {deal.state || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Opened</dt>
                  <dd className="font-medium">
                    {formatDate(deal.created_at.slice(0, 10), ctx.today)}
                  </dd>
                </div>
              </dl>
              <p
                className={cn(
                  "mt-3 text-sm",
                  fresh.status === "fresh"
                    ? "text-good"
                    : fresh.status === "none"
                      ? "text-muted"
                      : "text-warn",
                )}
              >
                {fresh.message}
              </p>
              {snapshot.stips_missing.length > 0 ? (
                <p className="mt-1 text-sm text-warn">
                  Still missing: {snapshot.stips_missing.join(", ")}
                </p>
              ) : null}
            </Card>
            <Card>
              <SectionTitle
                aside={
                  <Link
                    href={`/deals/${deal.id}?tab=offers`}
                    className="text-xs text-accent hover:underline"
                  >
                    Details
                  </Link>
                }
              >
                Lenders
              </SectionTitle>
              {snapshot.lenders.length === 0 ? (
                <p className="mt-2 text-sm text-muted">Not with any lender yet.</p>
              ) : (
                <ul className="mt-2 divide-y divide-border text-sm">
                  {snapshot.lenders.map((l) => (
                    <li
                      key={`${l.name}-${l.sent_on}`}
                      className="flex items-center justify-between gap-3 py-1.5"
                    >
                      <span className="font-medium">{l.name}</span>
                      <span className="text-xs text-muted">
                        {l.status.replace(/_/g, " ")} · sent {formatDate(l.sent_on, ctx.today)}
                        {l.responded_on
                          ? ` · answered ${formatDate(l.responded_on, ctx.today)}`
                          : l.chase_count > 0
                            ? ` · chased ${l.chase_count}×`
                            : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      ) : null}

      {tab === "documents" ? (
        <DocumentsPanel
          clientId={deal.client_id}
          dealId={deal.id}
          documents={documents}
          freshness={fresh}
          canDelete={manager || deal.user_id === session.userId}
          today={ctx.today}
          lenders={funders.submissions.map((s) => ({
            submissionId: s.id,
            funderId: s.funder_id,
            name: s.funder_name,
            status: s.status,
          }))}
          links={links}
        />
      ) : null}

      {tab === "activity" ? (
        <Card>
          <ActivityFeed
            events={timeline}
            today={ctx.today}
            timezone={ctx.timezone}
            canDecide={CAN.editOffers(session.role)}
          />
        </Card>
      ) : null}

      {tab === "offers" && detail ? (
        <SubmissionsCard
          card={detail.card}
          data={funders}
          positions={detail.positions}
          stips={detail.stips}
          canSubmitToOps={canSubmitToOps}
        />
      ) : null}
    </div>
  );
}
