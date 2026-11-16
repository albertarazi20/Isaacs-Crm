import { PlanForm } from "@/components/settings/PlanForm";
import { SettingsCard, SHEET } from "@/components/settings/primitives";
import { RetentionForm } from "@/components/settings/RetentionForm";
import { StatementsCard } from "@/components/settings/StatementsCard";
import { SettingsHeader } from "@/components/settings/SettingsNav";
import { Badge, cn } from "@/components/ui";
import { requireRole } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { formatMoneyCompact } from "@/lib/money";
import { getShopSettings, listCommissionPlans } from "@/lib/settings/queries";
import { listClosedMonths } from "@/lib/settings/statements";

export const dynamic = "force-dynamic";

export default async function PlanSettingsPage() {
  const session = await requireRole(CAN.manageTeam);
  const { plans, reps, months, retentionDays } = await db.withUser(session.userId, async (q) => ({
    plans: await listCommissionPlans(q),
    months: await listClosedMonths(q),
    retentionDays: (await getShopSettings(q)).document_retention_days,
    reps: (
      await q.query<{ id: string; name: string }>(
        "select id, coalesce(nullif(name, ''), email) as name from app_users where active and role in ('rep', 'manager') order by name",
      )
    ).rows,
  }));
  const shopCurrent = plans.find((p) => p.user_id === null && p.current) ?? null;
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <SettingsHeader role={session.role} current="/settings/plan" />
      <p className="text-sm text-muted">
        How a funding splits: the rep&apos;s share of the points, of the PSF, self-generated and
        renewal rates, volume tiers, and who eats a clawback. FUND previews use whatever applies on
        the funded date.
      </p>
      <SettingsCard title="Plans on file" flush className="min-w-0 overflow-x-auto">
        <table className={cn(SHEET.table, "border-t border-border")}>
          <thead className={SHEET.thead}>
            <tr>
              <th className={SHEET.th}>Applies to</th>
              <th className={SHEET.th}>From</th>
              <th className={SHEET.thNum}>Split</th>
              <th className={SHEET.thNum}>Self-gen</th>
              <th className={SHEET.thNum}>PSF share</th>
              <th className={SHEET.thNum}>Renewal</th>
              <th className={SHEET.th}>Tiers</th>
              <th className={SHEET.th}>Clawback</th>
              <th className={SHEET.th}>Note</th>
            </tr>
          </thead>
          <tbody className={SHEET.tbody}>
            {plans.map((p) => (
              <tr key={p.id} className={cn(SHEET.tr, !p.current && "text-muted")}>
                <td className={cn(SHEET.td, "whitespace-nowrap")}>
                  <span className="font-medium">{p.user_name ?? "Whole shop"}</span>
                  {p.current ? (
                    <Badge tone="good" className="ml-1.5">
                      current
                    </Badge>
                  ) : null}
                </td>
                <td className={cn(SHEET.td, "whitespace-nowrap tabular-nums")}>
                  {p.effective_from}
                </td>
                <td className={SHEET.tdNum}>{p.split_pct}%</td>
                <td className={SHEET.tdNum}>{p.self_gen_split_pct ?? "—"}</td>
                <td className={SHEET.tdNum}>{p.psf_share_pct}%</td>
                <td className={SHEET.tdNum}>{p.renewal_split_pct ?? "—"}</td>
                <td className={cn(SHEET.td, "text-xs whitespace-nowrap")}>
                  {p.tiers.length
                    ? p.tiers
                        .map((t) => `${formatMoneyCompact(t.from_cents)}+ → ${t.split_pct}%`)
                        .join(", ")
                    : "—"}
                </td>
                <td className={SHEET.td}>{p.clawback_borne_by}</td>
                <td className={cn(SHEET.td, "max-w-48 truncate text-xs")}>{p.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SettingsCard>
      <PlanForm reps={reps} base={shopCurrent} />
      <StatementsCard months={months} />
      <RetentionForm days={retentionDays} />
    </div>
  );
}
