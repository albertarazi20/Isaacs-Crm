import { TrashList } from "@/components/TrashList";
import { requireSession } from "@/lib/auth/server";
import { listTrashed } from "@/lib/data/queries";
import { db } from "@/lib/db";

export default async function TrashPage() {
  const session = await requireSession();
  const trashed = await db.withUser(session.userId, (q) => listTrashed(q));
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Trash</h1>
        <p className="mt-1 text-sm text-muted">
          Hidden everywhere, no reminders. Restore brings a client back with a follow-up in a week.
        </p>
      </div>
      <TrashList items={trashed} />
    </div>
  );
}
