import { PlanForm } from "@/components/settings/PlanForm";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { Card, SectionTitle, cn } from "@/components/ui";
import { requireRole } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { formatMoneyCompact } from "@/lib/money";
import { listCommissionPlans } from "@/lib/settings/queries";

export const dynamic = "force-dynamic";

export default async function PlanSettingsPage() {
  const session = await requireRole(CAN.manageTeam);
  const { plans, reps } = await db.withUser(session.userId, async (q) => ({
    plans: await listCommissionPlans(q),
    reps: (
      await q.query<{ id: string; name: string }>(
        "select id, coalesce(nullif(name, ''), email) as name from app_users where active and role in ('rep', 'manager') order by name",
      )
    ).rows,
  }));
  const shopCurrent = plans.find((p) => p.user_id === null && p.current) ?? null;
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <SettingsNav role={session.role} current="/settings/plan" />
      <p className="text-sm text-muted">
        How a funding splits: the rep&apos;s share of the points, of the PSF, self-generated and
        renewal rates, volume tiers, and who eats a clawback. FUND previews use whatever applies on
        the funded date.
      </p>
      <Card className="overflow-x-auto p-0">
        <div className="px-4 pt-4">
          <SectionTitle>Plans on file</SectionTitle>
        </div>
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Applies to</th>
              <th className="px-2 py-2 font-medium">From</th>
              <th className="px-2 py-2 text-right font-medium">Split</th>
              <th className="px-2 py-2 text-right font-medium">Self-gen</th>
              <th className="px-2 py-2 text-right font-medium">PSF share</th>
              <th className="px-2 py-2 text-right font-medium">Renewal</th>
              <th className="px-2 py-2 font-medium">Tiers</th>
              <th className="px-2 py-2 font-medium">Clawback</th>
              <th className="px-4 py-2 font-medium">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {plans.map((p) => (
              <tr key={p.id} className={cn(!p.current && "text-muted")}>
                <td className="px-4 py-2 font-medium">
                  {p.user_name ?? "Whole shop"}
                  {p.current ? (
                    <span className="ml-1 rounded bg-good-soft px-1.5 py-0.5 text-[11px] text-good">
                      current
                    </span>
                  ) : null}
                </td>
                <td className="px-2 py-2">{p.effective_from}</td>
                <td className="px-2 py-2 text-right tabular-nums">{p.split_pct}%</td>
                <td className="px-2 py-2 text-right tabular-nums">{p.self_gen_split_pct ?? "—"}</td>
                <td className="px-2 py-2 text-right tabular-nums">{p.psf_share_pct}%</td>
                <td className="px-2 py-2 text-right tabular-nums">{p.renewal_split_pct ?? "—"}</td>
                <td className="px-2 py-2 text-xs">
                  {p.tiers.length
                    ? p.tiers
                        .map((t) => `${formatMoneyCompact(t.from_cents)}+ → ${t.split_pct}%`)
                        .join(", ")
                    : "—"}
                </td>
                <td className="px-2 py-2">{p.clawback_borne_by}</td>
                <td className="px-4 py-2 text-xs">{p.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <PlanForm reps={reps} base={shopCurrent} />
    </div>
  );
}
