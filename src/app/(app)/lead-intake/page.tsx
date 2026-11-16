import { IntakeForm } from "@/components/intake/IntakeForm";
import { LeadIntakePanel } from "@/components/LeadIntakePanel";
import { Icon } from "@/components/client/icons";
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
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Lead Intake</h1>
        <p className="mt-0.5 max-w-2xl text-sm text-muted">
          Type the phone first — if the lead is on one of the Google Sheets, the rest fills itself
          in. Pick the bucket and submit; the bucket sends its first email now and keeps following
          up until they act.
        </p>
      </div>
      <IntakeForm buckets={buckets} defaultBucketId={defaultBucket?.id ?? null} />
      {manager ? (
        <details className="group rounded-xl border border-border bg-surface">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-[13px] font-semibold select-none [&::-webkit-details-marker]:hidden">
            <Icon name="plug" className="text-muted" />
            <span className="flex-1">Web lead connections (your site, Zapier, a vendor)</span>
            <Icon name="chevronDown" className="text-muted transition group-open:rotate-180" />
          </summary>
          <div className="border-t border-border p-4">
            <LeadIntakePanel tokens={tokens} endpoint={`${env().APP_URL}/api/leads`} />
          </div>
        </details>
      ) : null}
    </div>
  );
}
