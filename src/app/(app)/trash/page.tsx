import type { Metadata } from "next";
import { TrashList } from "@/components/TrashList";
import { PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { listTrashed } from "@/lib/data/queries";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Trash" };

export default async function TrashPage() {
  const session = await requireSession();
  const trashed = await db.withUser(session.userId, (q) => listTrashed(q));
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        eyebrow="Merchants"
        title={
          <>
            Trash{" "}
            {trashed.length > 0 ? (
              <span className="text-muted tabular-nums">{trashed.length}</span>
            ) : null}
          </>
        }
        description="Hidden everywhere, no reminders. Restore brings a merchant back with the follow-ups it had; anything already past due becomes one follow-up in a week."
      />
      <TrashList items={trashed} />
    </div>
  );
}
