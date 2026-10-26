import { getSession } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { activityRows, ACTIVITY_HEADER, toCsv } from "@/lib/export/csv";
import type { ActivityRow } from "@/lib/data/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Every note, call, text and stage move — the backup of what was said. */
export async function GET() {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  const { merchants, activities } = await db.withUser(session.userId, async (q) => ({
    // Every merchant, trashed ones too: this is the record of what was said, and a note with no name is useless.
    merchants: (
      await q.query<{ id: string; business_name: string; trashed: boolean }>(
        `select c.id, c.business_name,
                exists (select 1 from trashed_clients t where t.client_id = c.id) as trashed
           from clients c`,
      )
    ).rows,
    activities: (
      await q.query<{ j: ActivityRow }>(
        "select to_jsonb(a) as j from activities a order by a.occurred_at, a.id",
      )
    ).rows.map((r) => r.j),
  }));
  const names = new Map(
    merchants.map((m) => [m.id, { name: m.business_name, trashed: m.trashed }] as const),
  );
  const day = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(ACTIVITY_HEADER, activityRows(activities, names)), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="isaac-notes-${day}.csv"`,
      "cache-control": "no-store",
    },
  });
}
