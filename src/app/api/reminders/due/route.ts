import { getSessionPassive } from "@/lib/auth/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

interface DueReminder {
  id: string;
  business_name: string;
  phone: string;
  at: string;
  channel: "call" | "text" | "email";
  note: string;
}

/**
 * The reminders whose time has come (or passed within the last 12 hours), for the signed-in user. The open page asks
 * every half minute and pops up a banner. Runs as the user, so row-level security applies.
 */
export async function GET() {
  // a timer, not a person: checks the session without renewing its idle window
  const session = await getSessionPassive();
  if (!session) return new Response("Sign in first", { status: 401 });
  const rows = await db.withUser(session.userId, async (q) => {
    const res = await q.query<DueReminder>(
      `select c.id, c.business_name, c.phone, c.scheduled_call_at as at,
              coalesce(t.channel, 'call') as channel, coalesce(t.note, '') as note
         from client_cards c
         left join lateral (
           select x.channel, x.note from timers x
            where x.client_id = c.id and x.kind = 'scheduled_call' and x.done_at is null
            order by x.created_at desc limit 1
         ) t on true
        where c.scheduled_call_at <= now() and c.scheduled_call_at > now() - interval '12 hours'
          and c.contact_status <> 'dnc'
        order by c.scheduled_call_at`,
    );
    return res.rows;
  });
  return Response.json({ due: rows }, { headers: { "cache-control": "no-store" } });
}
