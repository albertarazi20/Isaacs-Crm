import { SettingsHeader } from "@/components/settings/SettingsNav";
import { TeamPanel } from "@/components/settings/TeamPanel";
import { BackdoorScoresCard, TrustAlertsCard } from "@/components/settings/TrustCards";
import { requireRole } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { requestTimeMs } from "@/lib/server-time";
import { policyAcceptance, recentTrustAlerts } from "@/lib/settings/trust";
import { backdoorScores, listTeam, trustPanel } from "@/lib/trust/queries";

export const dynamic = "force-dynamic";

export default async function TeamSettingsPage() {
  const session = await requireRole(CAN.manageTeam);
  const { members, trust, backdoor, policy, alerts } = await db.withUser(
    session.userId,
    async (q) => ({
      members: await listTeam(q),
      trust: await trustPanel(q, 30),
      backdoor: await backdoorScores(q),
      policy: await policyAcceptance(q),
      alerts: await recentTrustAlerts(q, 30),
    }),
  );
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <SettingsHeader role={session.role} current="/settings/team" />
      <p className="text-sm text-muted">
        Reps are all the same; ops run the Submission Board; managers do everything and can add
        another manager. The trust score watches copies, exports, contact changes on live files,
        after-hours opens and canaries.
      </p>
      <TeamPanel members={members} trust={trust} meId={session.userId} policy={policy} />
      <TrustAlertsCard recent={alerts} nowMs={requestTimeMs()} />
      <BackdoorScoresCard rows={backdoor} />
    </div>
  );
}
