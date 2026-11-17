import { SettingsPage } from "@/components/settings/SettingsNav";
import { TeamPanel } from "@/components/settings/TeamPanel";
import { requireRole } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { listTeam } from "@/lib/settings/team";

export const dynamic = "force-dynamic";

export default async function TeamSettingsPage() {
  const session = await requireRole(CAN.manageTeam);
  const members = await db.withUser(session.userId, (q) => listTeam(q));
  return (
    <SettingsPage
      role={session.role}
      current="/settings/team"
      title="Team"
      description="Reps are all the same; managers do everything and can add another manager."
    >
      <TeamPanel members={members} meId={session.userId} />
    </SettingsPage>
  );
}
