import { CAN, getSession } from "@/lib/auth/server";
import { listAllMembers, listBucketMembers } from "@/lib/buckets/queries";
import { db } from "@/lib/db";
import { fileSlug, followupCsv } from "@/lib/export/followup";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID = /^[0-9a-f-]{36}$/;

/**
 * One bucket (?bucket=<id>) or every bucket (?bucket=all) as a spreadsheet for a sheet and a text blast. Runs as the
 * signed-in manager, so row-level security applies; do-not-contact merchants are left out (their number is in the
 * x-left-out header).
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  if (!CAN.exportData(session.role))
    return new Response("Exports are for managers", { status: 403 });
  const which = new URL(req.url).searchParams.get("bucket") ?? "all";
  if (which !== "all" && !UUID.test(which)) return new Response("Unknown bucket", { status: 400 });

  const found = await db.withUser(session.userId, async (q) => {
    if (which === "all") return { name: "all-buckets", members: await listAllMembers(q) };
    const named = await q.query<{ name: string }>("select name from buckets where id = $1", [
      which,
    ]);
    if (!named.rows[0]) return null;
    return { name: fileSlug(named.rows[0].name), members: await listBucketMembers(q, which) };
  });
  if (!found) return new Response("Unknown bucket", { status: 404 });

  const { csv, left } = followupCsv(found.members);
  const day = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="selective-${found.name}-${day}.csv"`,
      "cache-control": "no-store",
      "x-left-out": String(left),
    },
  });
}
