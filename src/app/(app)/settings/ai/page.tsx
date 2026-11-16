import { AiSettingsForm } from "@/components/settings/AiSettingsForm";
import { AiSpendCard } from "@/components/settings/AiSpendCard";
import { Note, SettingsCard, StatTile } from "@/components/settings/primitives";
import { SettingsHeader } from "@/components/settings/SettingsNav";
import { requireRole } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { aiSpendByPurpose } from "@/lib/settings/ai";
import { aiStatus, getShopSettings } from "@/lib/settings/queries";

export const dynamic = "force-dynamic";

export default async function AiSettingsPage() {
  const session = await requireRole(CAN.manageTeam);
  const { settings, status, spend } = await db.withUser(session.userId, async (q) => ({
    settings: await getShopSettings(q),
    status: await aiStatus(q),
    spend: await aiSpendByPurpose(q),
  }));
  const keySet = Boolean(env().ANTHROPIC_API_KEY);
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <SettingsHeader role={session.role} current="/settings/ai" />
      <p className="text-sm text-muted">
        The AI reads lender emails and proposes the update with a quote as evidence. Money and
        merchant-facing status always wait for a manager&apos;s click. Every run is logged with its
        cost.
      </p>
      {!keySet ? (
        <Note tone="warn">
          ANTHROPIC_API_KEY is not set on the server — nothing is read until it is.
        </Note>
      ) : null}
      <div className="grid grid-cols-3 gap-3">
        <StatTile
          label="Spent today"
          value={`$${(status.spent_today_cents / 100).toFixed(2)}`}
          sub={`cap $${(settings.ai_daily_cap_cents / 100).toFixed(2)}`}
        />
        <StatTile label="Runs today" value={status.runs_today} />
        <StatTile
          label="Errors today"
          value={status.errors_today}
          tone={status.errors_today ? "bad" : undefined}
        />
      </div>
      <AiSettingsForm s={settings} />
      <AiSpendCard rows={spend} />
      <SettingsCard title="Recent runs" flush>
        {status.runs.length === 0 ? (
          <p className="border-t border-border px-4 py-3 text-sm text-muted">None yet.</p>
        ) : (
          <ul className="divide-y divide-border border-t border-border text-[13px]">
            {status.runs.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-3 px-4 py-2.5 transition hover:bg-surface-3 sm:py-2"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">{r.purpose.replace(/_/g, " ")}</span>
                  {r.business_name ? (
                    <span className="text-muted"> · {r.business_name}</span>
                  ) : null}
                  {r.error ? (
                    <span className="block truncate text-xs text-bad">{r.error}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs whitespace-nowrap text-muted tabular-nums">
                  {r.cost_cents !== null ? `${r.cost_cents.toFixed(2)}¢ · ` : ""}
                  {r.created_at.slice(0, 16).replace("T", " ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </div>
  );
}
