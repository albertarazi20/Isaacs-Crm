import Link from "next/link";
import { notFound } from "next/navigation";
import { SubmissionsCard } from "@/components/client/SubmissionsCard";
import { CopyContact } from "@/components/CopyContact";
import { ActivityFeed } from "@/components/deals/ActivityFeed";
import { ConfirmFundingButton } from "@/components/deals/ConfirmFundingButton";
import { DocumentsPanel } from "@/components/deals/DocumentsPanel";
import { FundDialog, type FundLender } from "@/components/deals/FundDialog";
import { NoteEditor } from "@/components/deals/NoteEditor";
import { DealStatusBadge, Icon, SUB_TONE } from "@/components/deals/primitives";
import { ResubmitToOpsButton } from "@/components/deals/SubmitToOps";
import { UploadLinkButton } from "@/components/deals/UploadLinkButton";
import { Badge, Card, SectionTitle, buttonClass, cn } from "@/components/ui";
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

const URGENCY: Record<
  Suggestion["urgency"],
  { tone: "bad" | "warn" | "accent" | "neutral"; word: string }
> = {
  now: { tone: "bad", word: "Do now" },
  today: { tone: "warn", word: "Today" },
  soon: { tone: "accent", word: "Soon" },
  none: { tone: "neutral", word: "Status" },
};

/** The blocker line under the header: what to do next, why, and the way there. */
function NextStep({ s, dealId, clientId }: { s: Suggestion; dealId: string; clientId: string }) {
  const go = (tab: Tab) => `/deals/${dealId}?tab=${tab}`;
  const link = (href: string, label: string) => (
    <Link href={href} className={buttonClass("secondary", "sm")}>
      {label}
    </Link>
  );
  let action: React.ReactNode = null;
  switch (s.action) {
    case "collect_stips":
      action = <UploadLinkButton clientId={clientId} dealId={dealId} size="md" />;
      break;
    case "answer":
      action = link(`/clients/${clientId}`, "Open the merchant →");
      break;
    case "present":
    case "close":
    case "chase":
    case "contracts":
    case "fund":
      action = link(go("offers"), "Lenders & offers →");
      break;
    case "fix_file":
      action = link(go("documents"), "Documents →");
      break;
    default:
      action = null;
  }
  const u = URGENCY[s.urgency];
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border px-4 py-3 sm:px-5">
      <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
        <Badge tone={u.tone} className="mt-0.5">
          {u.word}
        </Badge>
        <div className="min-w-0">
          <p className="text-sm font-semibold">{s.title}</p>
          <p className="text-xs text-muted">{s.why}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

/** "FUND waiting for a manager", "Funded $45k": a state the header shows as a pill the height of a button. */
function HeaderPill({ tone, children }: { tone: "warn" | "good"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-10 items-center rounded-lg px-3 text-sm font-semibold sm:h-9",
        tone === "warn" ? "bg-warn-soft text-warn" : "bg-good-soft text-good",
      )}
    >
      {children}
    </span>
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
    <div className="space-y-6">
      <Card className="p-0">
        <div className="px-4 pt-4 pb-4 sm:px-5">
          <Link
            href="/deals"
            className="inline-flex h-8 items-center gap-1 text-xs font-medium text-muted transition hover:text-text"
          >
            ← Deals
          </Link>
          <div className="mt-1 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
            <div className="min-w-0 flex-1 basis-72">
              <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
                {deal.business_name}{" "}
                <span className="text-base font-medium text-muted">D-{deal.number}</span>
              </h1>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1 text-sm text-muted">
                <DealStatusBadge status={deal.status} label={DEAL_STATUS_LABELS[deal.status]} />
                {" · "}
                {deal.contact_name || "—"}
                {deal.phone ? (
                  <>
                    {" · "}
                    <a href={`tel:${deal.phone}`} className="text-text-2 hover:underline">
                      {deal.phone}
                    </a>
                    <CopyContact clientId={deal.client_id} value={deal.phone} kind="phone" />
                  </>
                ) : null}
                {deal.email ? (
                  <>
                    {" · "}
                    <a href={`mailto:${deal.email}`} className="text-text-2 hover:underline">
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
                  <span className="font-semibold text-text tabular-nums">
                    {formatMoneyCompact(deal.requested_cents)}
                  </span>
                </span>
              ) : null}
              {deal.outcome === "open" && snapshot.funding && !snapshot.funding.confirmed ? (
                CAN.confirmFunding(session.role) && snapshot.funding.id ? (
                  <ConfirmFundingButton fundingId={snapshot.funding.id} />
                ) : (
                  <HeaderPill tone="warn">FUND waiting for a manager</HeaderPill>
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
                <HeaderPill tone="good">Funded {formatMoneyCompact(deal.funded_cents)}</HeaderPill>
              ) : null}
            </div>
          </div>

          <ol className="mt-4 flex flex-wrap gap-1.5" aria-label="Milestones">
            {chips.map((m) => (
              <li
                key={m.key}
                className={cn(
                  "inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium whitespace-nowrap",
                  m.done
                    ? "border-good/30 bg-good-soft text-good"
                    : m.current
                      ? "border-accent/40 bg-accent-soft text-accent"
                      : "border-border text-muted",
                )}
                title={m.on ? formatDate(m.on, ctx.today) : undefined}
              >
                {m.done ? "✓ " : ""}
                {m.label}
              </li>
            ))}
          </ol>
        </div>
        <NextStep s={next} dealId={deal.id} clientId={deal.client_id} />
      </Card>

      <nav
        aria-label="Deal sections"
        className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0"
      >
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "overview" ? `/deals/${deal.id}` : `/deals/${deal.id}?tab=${t.key}`}
            aria-current={t.key === tab ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex h-11 shrink-0 items-center border-b-2 px-2 text-[13px] font-medium whitespace-nowrap transition sm:h-10 sm:px-3 sm:text-sm",
              t.key === tab
                ? "border-accent text-text"
                : "border-transparent text-muted hover:text-text",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card className="min-w-0 space-y-4 p-4 sm:p-5">
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
              <p className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
                <Icon name="alert" className="mt-0.5" />
                <span>
                  <span className="font-semibold">Blocked:</span> {deal.blocker}
                </span>
              </p>
            ) : null}
          </Card>
          <div className="min-w-0 space-y-6">
            <Card className="p-4 sm:p-5">
              <SectionTitle>The file</SectionTitle>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
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
                  <dd className="font-medium tabular-nums">
                    {formatDate(deal.created_at.slice(0, 10), ctx.today)}
                  </dd>
                </div>
              </dl>
              <p
                className={cn(
                  "mt-4 flex items-start gap-2 border-t border-border pt-3 text-sm",
                  fresh.status === "fresh"
                    ? "text-good"
                    : fresh.status === "none"
                      ? "text-muted"
                      : "text-warn",
                )}
              >
                <Icon name="file" className="mt-0.5" />
                <span>{fresh.message}</span>
              </p>
              {snapshot.stips_missing.length > 0 ? (
                <p className="mt-1 pl-6 text-sm text-warn">
                  Still missing: {snapshot.stips_missing.join(", ")}
                </p>
              ) : null}
            </Card>
            <Card className="p-0">
              <div className="px-4 pt-4 pb-2 sm:px-5">
                <SectionTitle
                  aside={
                    <Link
                      href={`/deals/${deal.id}?tab=offers`}
                      className="text-xs font-medium text-accent hover:underline"
                    >
                      Details
                    </Link>
                  }
                >
                  Lenders
                </SectionTitle>
              </div>
              {snapshot.lenders.length === 0 ? (
                <p className="px-4 pb-4 text-sm text-muted sm:px-5">Not with any lender yet.</p>
              ) : (
                <ul className="divide-y divide-border border-t border-border text-sm">
                  {snapshot.lenders.map((l) => (
                    <li
                      key={`${l.name}-${l.sent_on}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 sm:px-5"
                    >
                      <span className="min-w-0 flex-1 basis-32 truncate font-medium">{l.name}</span>
                      <Badge tone={SUB_TONE[l.status] ?? "neutral"}>
                        {l.status.replace(/_/g, " ")}
                      </Badge>
                      <span className="text-xs text-muted tabular-nums">
                        sent {formatDate(l.sent_on, ctx.today)}
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
        <Card className="p-0">
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
