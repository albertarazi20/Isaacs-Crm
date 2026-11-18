import type { Metadata } from "next";
import Link from "next/link";
import { AddApprovalButton } from "@/components/approvals/AddApprovalButton";
import { ApprovalList } from "@/components/approvals/ApprovalList";
import { ApprovalsHero } from "@/components/approvals/ApprovalsHero";
import { Glyph } from "@/components/shell/icons";
import { EmptyState, PageHeader, Segmented } from "@/components/ui";
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
import { userContext } from "@/lib/data/queries";
import { db } from "@/lib/db";

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
    open: view === "open" ? null : await listApprovals(q, "open"),
    today: (await userContext(q)).today,
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
        description="Merchants with an offer who haven't been pitched yet. The emails go out on their own; the call is yours. Press Pitched once you've walked them through it."
        actions={<AddApprovalButton cadence={cadence} />}
      />

      {unready > 0 ||
      !settings.approval_emails_on ||
      settings.postal_address.trim() === "" ||
      !data.myPhone ? (
        <div
          role="status"
          className="rounded-2xl border border-warn/30 bg-warn-soft/60 px-4 py-3 text-sm text-warn"
        >
          <p className="flex items-center gap-2 font-semibold">
            <Glyph name="alert" className="size-4" />
            Before the approval emails can go out
          </p>
          <ul className="mt-1.5 space-y-1 pl-6">
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
                Your approval emails ask the merchant to call you, so they wait for your phone
                number.{" "}
                <Link className="font-semibold underline" href="/settings">
                  Add it in My account
                </Link>
              </Notice>
            ) : null}
          </ul>
        </div>
      ) : null}

      <ApprovalsHero stats={stats} open={data.open ?? rows} today={data.today} />

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
  return <li className="list-disc text-[13px] leading-relaxed text-text-2">{children}</li>;
}
