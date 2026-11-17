import { LeadIntakePanel } from "@/components/LeadIntakePanel";
import { SettingsPage } from "@/components/settings/SettingsNav";
import { SheetsPanel } from "@/components/settings/SheetsPanel";
import { buttonClass } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { listBuckets } from "@/lib/buckets/queries";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { listLeadTokens } from "@/lib/leads/queries";
import { listSheetSources } from "@/lib/settings/queries";
import { gmailStatus } from "@/lib/system/gmail";

export const dynamic = "force-dynamic";

export default async function SheetsSettingsPage() {
  const session = await requireSession();
  const manager = CAN.manageTeam(session.role);
  const { sources, buckets, tokens } = await db.withUser(session.userId, async (q) => ({
    sources: await listSheetSources(q),
    buckets: await listBuckets(q),
    // web lead connections are the shop's: only a manager makes or sees them
    tokens: manager ? await listLeadTokens(q) : [],
  }));
  const connected = await gmailStatus(session.userId)
    .then((g) => g.canReadSheets)
    .catch(() => false);
  return (
    <SettingsPage
      role={session.role}
      current="/settings/sheets"
      title="Lead sources"
      description={
        manager
          ? "Where new merchants come from: the Google Sheets that sync in every day, and the web connections that push leads in the moment they arrive."
          : "Where new merchants come from: the Google Sheets that sync in every day. Auto-file puts new rows straight into a bucket with its welcome email."
      }
      actions={
        manager ? (
          <a href="#web-leads" className={buttonClass("secondary", "sm")}>
            Web lead connections
          </a>
        ) : null
      }
    >
      <SheetsPanel
        sources={sources}
        buckets={buckets}
        canShare={manager}
        sheetsConnected={connected}
      />
      {manager ? <LeadIntakePanel tokens={tokens} endpoint={`${env().APP_URL}/api/leads`} /> : null}
    </SettingsPage>
  );
}
