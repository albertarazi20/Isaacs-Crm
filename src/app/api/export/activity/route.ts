import { getSession } from "@/lib/auth/server";
import { listCards } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { activityRows, ACTIVITY_HEADER, toCsv } from "@/lib/export/csv";
import type { ActivityRow } from "@/lib/data/types";

export const dynamic = "force-dynamic";

/** Every note, call, text and stage move — the backup of what was said. */
export async function GET() {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  const { cards, activities } = await db.withUser(session.userId, async (q) => ({
    cards: await listCards(q),
    activities: (
      await q.query<{ j: ActivityRow }>(
        "select to_jsonb(a) as j from activities a order by a.occurred_at, a.id",
      )
    ).rows.map((r) => r.j),
  }));
  const names = new Map(cards.map((c) => [c.id, c.business_name]));
  const day = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(ACTIVITY_HEADER, activityRows(activities, names)), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="isaac-notes-${day}.csv"`,
      "cache-control": "no-store",
    },
  });
}
