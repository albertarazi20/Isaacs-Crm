import { AiSettingsForm } from "@/components/settings/AiSettingsForm";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { Card, SectionTitle } from "@/components/ui";
import { requireRole } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { aiStatus, getShopSettings } from "@/lib/settings/queries";

export const dynamic = "force-dynamic";

export default async function AiSettingsPage() {
  const session = await requireRole(CAN.manageTeam);
  const { settings, status } = await db.withUser(session.userId, async (q) => ({
    settings: await getShopSettings(q),
    status: await aiStatus(q),
  }));
  const keySet = Boolean(env().ANTHROPIC_API_KEY);
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <SettingsNav role={session.role} current="/settings/ai" />
      <p className="text-sm text-muted">
        The AI reads lender emails and proposes the update with a quote as evidence. Money and
        merchant-facing status always wait for a manager&apos;s click. Every run is logged with its
        cost.
      </p>
      {!keySet ? (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          ANTHROPIC_API_KEY is not set on the server — nothing is read until it is.
        </p>
      ) : null}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">
            Spent today
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums">
            ${(status.spent_today_cents / 100).toFixed(2)}
          </p>
          <p className="text-xs text-muted">
            cap ${(settings.ai_daily_cap_cents / 100).toFixed(2)}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">Runs today</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{status.runs_today}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">
            Errors today
          </p>
          <p
            className={`mt-1 text-2xl font-bold tabular-nums ${status.errors_today ? "text-bad" : ""}`}
          >
            {status.errors_today}
          </p>
        </div>
      </div>
      <AiSettingsForm s={settings} />
      <Card className="p-0">
        <div className="px-4 pt-4">
          <SectionTitle>Recent runs</SectionTitle>
        </div>
        {status.runs.length === 0 ? (
          <p className="px-4 pb-4 pt-2 text-sm text-muted">None yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border text-sm">
            {status.runs.map((r) => (
              <li key={r.id} className="flex justify-between gap-3 px-4 py-1.5">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{r.purpose.replace(/_/g, " ")}</span>
                  {r.business_name ? (
                    <span className="text-muted"> · {r.business_name}</span>
                  ) : null}
                  {r.error ? (
                    <span className="block truncate text-xs text-bad">{r.error}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs text-muted tabular-nums">
                  {r.cost_cents !== null ? `${r.cost_cents.toFixed(2)}¢ · ` : ""}
                  {r.created_at.slice(0, 16).replace("T", " ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
