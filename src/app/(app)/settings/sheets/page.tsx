import { SettingsHeader } from "@/components/settings/SettingsNav";
import { SheetsPanel } from "@/components/settings/SheetsPanel";
import { requireSession } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { listBuckets } from "@/lib/buckets/queries";
import { db } from "@/lib/db";
import { listSheetSources } from "@/lib/settings/queries";
import { gmailStatus } from "@/lib/system/gmail";

export const dynamic = "force-dynamic";

export default async function SheetsSettingsPage() {
  const session = await requireSession();
  const { sources, buckets } = await db.withUser(session.userId, async (q) => ({
    sources: await listSheetSources(q),
    buckets: await listBuckets(q),
  }));
  const connected = await gmailStatus(session.userId)
    .then((g) => g.canReadSheets)
    .catch(() => false);
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <SettingsHeader role={session.role} current="/settings/sheets" />
      <p className="text-sm text-muted">
        Each rep&apos;s lead sheet syncs into the CRM every day (and on demand). The intake form
        looks leads up by phone from these rows; auto-file puts new rows straight into a bucket with
        the welcome email.
      </p>
      <SheetsPanel
        sources={sources}
        buckets={buckets}
        canShare={CAN.manageTeam(session.role)}
        sheetsConnected={connected}
      />
    </div>
  );
}
