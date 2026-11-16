import { CAN, getSession } from "@/lib/auth/server";
import { listCards } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { recordExport } from "@/lib/system/notify";
import { clientRows, CLIENT_HEADER, toCsv } from "@/lib/export/csv";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Every client the signed-in user owns, as a spreadsheet. Runs as the user, so row-level security applies. */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  // plan §14: exports are manager-only, logged, and the managers are told
  if (!CAN.exportData(session.role))
    return new Response("Exports are for managers", { status: 403 });
  await recordExport(db, {
    userId: session.userId,
    email: session.email,
    kind: "export",
    detail: "the merchant list (CSV)",
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "",
    userAgent: req.headers.get("user-agent") ?? "",
  });
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
