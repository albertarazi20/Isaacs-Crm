import { DnsCard } from "@/components/settings/DnsCard";
import { MailboxSync } from "@/components/settings/MailboxSync";
import { SettingsCard } from "@/components/settings/primitives";
import { SettingsPage } from "@/components/settings/SettingsNav";
import { ShopSettingsForm } from "@/components/settings/ShopSettingsForm";
import { SuppressionList } from "@/components/settings/SuppressionList";
import { Avatar, Badge, cn, Meter } from "@/components/ui";
import { requireRole } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { emailMeters } from "@/lib/dashboard/queries";
import { db } from "@/lib/db";
import { mailboxSyncStatus } from "@/lib/inbox/sync";
import { dnsView } from "@/lib/settings/dnsView";
import { getShopSettings, listSuppressions } from "@/lib/settings/queries";
import { requestTimeMs } from "@/lib/server-time";

export const dynamic = "force-dynamic";

export default async function EmailSettingsPage() {
  const session = await requireRole(CAN.manageTeam);
  const { settings, meters, suppressions, mailboxes } = await db.withUser(
    session.userId,
    async (q) => ({
      settings: await getShopSettings(q),
      meters: await emailMeters(q),
      suppressions: await listSuppressions(q),
      mailboxes: await mailboxSyncStatus(q),
    }),
  );
  const sent = meters.reduce((n, m) => n + m.sent_24h, 0);
  const room = meters.reduce((n, m) => n + m.cap, 0);
  return (
    <SettingsPage
      role={session.role}
      current="/settings/email"
      title="Email"
      description="How much each mailbox has sent, who the automated emails come from, when they may go out and who must never get one."
    >
      {meters.length > 0 ? (
        <SettingsCard
          title="Sending today"
          description="Emails each mailbox sent in the last 24 hours, against its cap. Amber means close; red means the mailbox is waiting."
          aside={
            <span className="tabular-nums">
              <span className="font-semibold text-text">{sent.toLocaleString("en-US")}</span> of{" "}
              {room.toLocaleString("en-US")} sent
            </span>
          }
          flush
        >
          <ul className="divide-y divide-border">
            {meters.map((m) => {
              const tone = m.tone === "red" ? "bad" : m.tone === "amber" ? "warn" : "good";
              const pct = Math.min(100, Math.round((100 * m.sent_24h) / Math.max(1, m.cap)));
              return (
                <li key={m.mailbox_id} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
                  <Avatar name={m.owner_name ?? "Shop automation"} size={34} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                        <span className="truncate">{m.owner_name ?? "Shop automation"}</span>
                        <Badge tone={m.kind === "gmail" ? "neutral" : "info"}>
                          {m.kind === "gmail" ? "Gmail" : "Automation"}
                        </Badge>
                      </p>
                      <p
                        className={cn(
                          "shrink-0 text-[13px] tabular-nums",
                          tone === "bad"
                            ? "font-semibold text-bad"
                            : tone === "warn"
                              ? "font-semibold text-warn"
                              : "text-muted",
                        )}
                      >
                        <span className="font-semibold text-text">
                          {m.sent_24h.toLocaleString("en-US")}
                        </span>{" "}
                        / {m.cap.toLocaleString("en-US")}
                        <span className="ml-2 hidden text-xs text-muted sm:inline">{pct}%</span>
                      </p>
                    </div>
                    <p className="truncate text-xs text-muted">{m.address}</p>
                    <Meter
                      value={m.sent_24h}
                      max={m.cap}
                      tone={m.sent_24h === 0 ? "neutral" : tone === "good" ? "brand" : tone}
                      className="mt-2"
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </SettingsCard>
      ) : null}
      <MailboxSync rows={mailboxes} nowMs={requestTimeMs()} />
      <ShopSettingsForm s={settings} afterShop={<DnsCard view={dnsView(settings)} />} />
      <SuppressionList rows={suppressions} />
    </SettingsPage>
  );
}
