import { TrashList } from "@/components/TrashList";
import { requireSession } from "@/lib/auth/server";
import { listTrashed } from "@/lib/data/queries";
import { db } from "@/lib/db";

export default async function TrashPage() {
  const session = await requireSession();
  const trashed = await db.withUser(session.userId, (q) => listTrashed(q));
  return (
    <div className="space-y-5">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Trash</h1>
        <p className="mt-0.5 max-w-2xl text-sm text-muted">
          Hidden everywhere, no reminders. Restore brings a client back with the follow-ups it had;
          anything already past due becomes one follow-up in a week.
        </p>
      </div>
      <TrashList items={trashed} />
    </div>
  );
}
