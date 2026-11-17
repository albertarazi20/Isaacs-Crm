import type { Metadata } from "next";
import Link from "next/link";
import { AddApprovalButton } from "@/components/approvals/AddApprovalButton";
import { ApprovalList } from "@/components/approvals/ApprovalList";
import { EmptyState, PageHeader, Segmented, StatCard } from "@/components/ui";
import {
  approvalCadence,
  approvalStats,
  getApprovalSettings,
  listApprovals,
  type ApprovalStatus,
} from "@/lib/approvals/queries";
import { cadenceSummary } from "@/lib/approvals/words";
import { CAN } from "@/lib/auth/roles";
import { requirePage } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { formatMoneyCompact } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Open approvals" };

const VIEWS: readonly { key: ApprovalStatus; label: string }[] = [
  { key: "open", label: "Waiting on a pitch" },
  { key: "pitched", label: "Pitched" },
  { key: "closed", label: "Closed" },
];

/**
 * Open approvals: every merchant who got an offer and has not been pitched yet. The approval emails go out on their
 * own; the rep's job here is the call. A reply puts the merchant at the top.
 */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const session = await requirePage("/approvals");
  const { view: raw } = await searchParams;
  const view: ApprovalStatus = raw === "pitched" || raw === "closed" ? raw : "open";
  const data = await db.withUser(session.userId, async (q) => ({
    rows: await listApprovals(q, view),
    stats: await approvalStats(q),
    cadence: await approvalCadence(q),
    settings: await getApprovalSettings(q),
    myPhone: (
      await q.query<{ phone: string }>("select phone from app_users where id = $1", [
        session.userId,
      ])
    ).rows[0]?.phone,
  }));
  const { rows, stats, cadence, settings } = data;
  const manager = CAN.manageTeam(session.role);
  const unready = cadence.filter((s) => !s.ready).length;
  // only when a design actually asks the merchant to call the rep does a missing phone number hold anything
  const needsPhone = !data.myPhone && cadence.some((s) => s.uses_phone);
  const counts: Record<ApprovalStatus, number | undefined> = {
    open: stats.open,
    pitched: undefined,
    closed: undefined,
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Funding desk"
        title="Open approvals"
        description="Merchants with an offer who haven't been pitched yet. The approval emails go out on their own; the call is yours. Press Pitched when you've walked them through it."
        actions={<AddApprovalButton cadence={cadence} />}
      />

      {unready > 0 ||
      !settings.approval_emails_on ||
      settings.postal_address.trim() === "" ||
      !data.myPhone ? (
        <div className="space-y-2">
          {!settings.approval_emails_on ? (
            <Notice>
              Approval emails are switched off, so nothing goes out on its own.{" "}
              {manager ? (
                <Link className="font-semibold underline" href="/settings/approvals">
                  Turn them on
                </Link>
              ) : (
                "A manager can turn them on."
              )}
            </Notice>
          ) : null}
          {unready > 0 ? (
            <Notice>
              {unready === cadence.length
                ? "The approval emails don't have their designs yet, so approvals wait at the first email."
                : `${unready} of the ${cadence.length} approval emails ${unready === 1 ? "has" : "have"} no design yet: approvals wait at that email.`}{" "}
              {manager ? (
                <Link className="font-semibold underline" href="/settings/approvals">
                  Add them
                </Link>
              ) : (
                "A manager adds them in Settings."
              )}
            </Notice>
          ) : null}
          {settings.postal_address.trim() === "" ? (
            <Notice>
              Automated email waits until the shop&apos;s postal address is set.{" "}
              {manager ? (
                <Link className="font-semibold underline" href="/settings/email">
                  Set it
                </Link>
              ) : (
                "A manager sets it in Settings."
              )}
            </Notice>
          ) : null}
          {needsPhone ? (
            <Notice>
              Your approval emails ask the merchant to call you, so they wait for your phone number.{" "}
              <Link className="font-semibold underline" href="/settings">
                Add it in My account
              </Link>
            </Notice>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          hero
          label="Waiting on a pitch"
          value={stats.open}
          hint={stats.open === 1 ? "merchant with an offer" : "merchants with an offer"}
        />
        <StatCard
          label="On the table"
          value={formatMoneyCompact(stats.open_cents)}
          hint={
            stats.expiring > 0
              ? `${stats.expiring} hold${stats.expiring === 1 ? " ends" : "s end"} within 3 days`
              : "approved, not pitched yet"
          }
        />
        <StatCard
          label="Replied"
          value={stats.replied}
          tone="accent"
          hint={stats.replied > 0 ? "call them now" : "no replies waiting"}
        />
        <StatCard
          label="Pitched this week"
          value={stats.pitched_7d}
          tone="good"
          hint={
            stats.pitched_7d > 0
              ? `${formatMoneyCompact(stats.pitched_cents_7d)} walked through`
              : "none yet this week"
          }
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Which approvals"
          items={VIEWS.map((v) => ({
            href: v.key === "open" ? "/approvals" : `/approvals?view=${v.key}`,
            label: v.label,
            active: v.key === view,
            count: counts[v.key],
          }))}
        />
        <p className="text-xs text-muted">{cadenceSummary(cadence)}</p>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={
            view === "open"
              ? "No approvals waiting"
              : view === "pitched"
                ? "Nothing pitched yet"
                : "Nothing closed"
          }
          action={view === "open" ? <AddApprovalButton cadence={cadence} /> : undefined}
        >
          {view === "open"
            ? "When a funder approves a merchant, mark it here or on the merchant's page. The approval email goes out on its own."
            : "Approvals you pitch or close show up here, newest first."}
        </EmptyState>
      ) : (
        <ApprovalList rows={rows} view={view} cadence={cadence} />
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-2xl border border-warn/30 bg-warn-soft px-4 py-2.5 text-sm text-warn">
      {children}
    </p>
  );
}
