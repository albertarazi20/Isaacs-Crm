import { SettingsHeader } from "@/components/settings/SettingsNav";
import { StatesEditor } from "@/components/settings/StatesEditor";
import { CAN } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { listStateLines } from "@/lib/settings/states";

export const dynamic = "force-dynamic";

export default async function StatesSettingsPage() {
  const session = await requireRole(CAN.manageTeam);
  const lines = await db.withUser(session.userId, (q) => listStateLines(q));
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <SettingsHeader role={session.role} current="/settings/states" />
      <p className="text-sm text-muted">
        Some states want a broker to be registered before a file goes to a lender, and some have
        rules about fees, rate wording and disclosures. A deal for a state the shop is not
        registered in is flagged when it goes to ops.
      </p>
      <StatesEditor lines={lines} />
    </div>
  );
}
