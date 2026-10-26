import { LeadIntakePanel } from "@/components/LeadIntakePanel";
import { requireSession } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { listLeadTokens } from "@/lib/leads/queries";

export default async function LeadIntakePage() {
  const session = await requireSession();
  const tokens = await db.withUser(session.userId, (q) => listLeadTokens(q));
  return <LeadIntakePanel tokens={tokens} endpoint={`${env().APP_URL}/api/leads`} />;
}
