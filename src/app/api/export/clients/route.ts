import { getSession } from "@/lib/auth/server";
import { listCards } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { clientRows, CLIENT_HEADER, toCsv } from "@/lib/export/csv";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Every client the signed-in user owns, as a spreadsheet. Runs as the user, so row-level security applies. */
export async function GET() {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  const cards = await db.withUser(session.userId, (q) => listCards(q));
  const day = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(CLIENT_HEADER, clientRows(cards)), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="isaac-clients-${day}.csv"`,
      "cache-control": "no-store",
    },
  });
}
