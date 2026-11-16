import { IntakeForm } from "@/components/intake/IntakeForm";
import { LeadIntakePanel } from "@/components/LeadIntakePanel";
import { requirePage } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { listBuckets } from "@/lib/buckets/queries";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { listLeadTokens } from "@/lib/leads/queries";

export const dynamic = "force-dynamic";

export default async function LeadIntakePage() {
  const session = await requirePage("/lead-intake");
  const manager = CAN.manageTeam(session.role);
  const { buckets, tokens } = await db.withUser(session.userId, async (q) => ({
    buckets: await listBuckets(q),
    tokens: manager ? await listLeadTokens(q) : [],
  }));
  const defaultBucket = buckets.find((b) => b.key === "interested") ?? buckets[0] ?? null;
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Lead Intake</h1>
        <p className="text-sm text-muted">
          Type the phone first — if the lead is on one of the Google Sheets, the rest fills itself
          in. Pick the bucket and submit; the bucket sends its first email now and keeps following
          up until they act.
        </p>
      </div>
      <IntakeForm buckets={buckets} defaultBucketId={defaultBucket?.id ?? null} />
      {manager ? (
        <details className="rounded-xl border border-border bg-surface p-4">
          <summary className="cursor-pointer text-sm font-semibold">
            Web lead connections (your site, Zapier, a vendor)
          </summary>
          <div className="mt-4">
            <LeadIntakePanel tokens={tokens} endpoint={`${env().APP_URL}/api/leads`} />
          </div>
        </details>
      ) : null}
    </div>
  );
}
