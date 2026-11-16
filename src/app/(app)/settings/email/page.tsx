import { SettingsCard } from "@/components/settings/primitives";
import { SettingsHeader } from "@/components/settings/SettingsNav";
import { ShopSettingsForm } from "@/components/settings/ShopSettingsForm";
import { SuppressionList } from "@/components/settings/SuppressionList";
import { cn } from "@/components/ui";
import { requireRole } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { emailMeters } from "@/lib/dashboard/queries";
import { db } from "@/lib/db";
import { getShopSettings, listSuppressions } from "@/lib/settings/queries";

export const dynamic = "force-dynamic";

export default async function EmailSettingsPage() {
  const session = await requireRole(CAN.manageTeam);
  const { settings, meters, suppressions } = await db.withUser(session.userId, async (q) => ({
    settings: await getShopSettings(q),
    meters: await emailMeters(q),
    suppressions: await listSuppressions(q),
  }));
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <SettingsHeader role={session.role} current="/settings/email" />
      {meters.length > 0 ? (
        <SettingsCard title="Mailboxes · last 24 hours" flush>
          <ul className="divide-y divide-border border-t border-border">
            {meters.map((m) => (
              <li key={m.mailbox_id} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{m.owner_name ?? "Shop automation"}</span>{" "}
                    <span className="text-xs text-muted">· {m.address}</span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-xs tabular-nums",
                      m.tone === "red"
                        ? "font-semibold text-bad"
                        : m.tone === "amber"
                          ? "font-semibold text-warn"
                          : "text-muted",
                    )}
                  >
                    {m.sent_24h} / {m.cap}
                  </span>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      m.tone === "red" ? "bg-bad" : m.tone === "amber" ? "bg-warn" : "bg-good",
                    )}
                    style={{
                      width: `${Math.min(100, Math.round((100 * m.sent_24h) / Math.max(1, m.cap)))}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </SettingsCard>
      ) : null}
      <ShopSettingsForm s={settings} />
      <SuppressionList rows={suppressions} />
    </div>
  );
}
