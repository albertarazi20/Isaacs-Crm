import { SettingsNav } from "@/components/settings/SettingsNav";
import { ShopSettingsForm } from "@/components/settings/ShopSettingsForm";
import { SuppressionList } from "@/components/settings/SuppressionList";
import { Card, SectionTitle, cn } from "@/components/ui";
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
    <div className="mx-auto max-w-5xl space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <SettingsNav role={session.role} current="/settings/email" />
      {meters.length > 0 ? (
        <Card>
          <SectionTitle>Mailboxes · last 24 hours</SectionTitle>
          <ul className="mt-2 space-y-2 text-sm">
            {meters.map((m) => (
              <li key={m.mailbox_id}>
                <div className="flex justify-between">
                  <span>
                    {m.owner_name ?? "Shop automation"}{" "}
                    <span className="text-muted">· {m.address}</span>
                  </span>
                  <span
                    className={cn(
                      "tabular-nums",
                      m.tone === "red"
                        ? "text-bad"
                        : m.tone === "amber"
                          ? "text-warn"
                          : "text-muted",
                    )}
                  >
                    {m.sent_24h} / {m.cap}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className={cn(
                      "h-full",
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
        </Card>
      ) : null}
      <ShopSettingsForm s={settings} />
      <SuppressionList rows={suppressions} />
    </div>
  );
}
