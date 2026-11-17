import { SettingsHeader } from "@/components/settings/SettingsNav";
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
    <div className="mx-auto max-w-6xl space-y-5">
      <SettingsHeader role={session.role} current="/settings/team" />
      <p className="text-sm text-muted">
        Reps are all the same; managers do everything and can add another manager.
      </p>
      <TeamPanel members={members} meId={session.userId} />
    </div>
  );
}
