import { notFound } from "next/navigation";
import { ClientView } from "@/components/client/ClientView";
import { requireSession } from "@/lib/auth/server";
import { getClientDetail } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { getClientFundersData } from "@/lib/funders/queries";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The clock at request time. The page is dynamic (cookies), so this is never a cached value. */
const requestTimeMs = () => Date.now();

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A malformed id would make Postgres throw (500); it is just "no such client".
  if (!UUID.test(id)) notFound();
  const session = await requireSession();
  // RLS scopes this to the signed-in user, so another user's id comes back null like a missing one.
  const { detail, funders } = await db.withUser(session.userId, async (q) => ({
    detail: await getClientDetail(q, id),
    funders: await getClientFundersData(q, id),
  }));
  if (!detail) notFound();
  return <ClientView detail={detail} serverNow={requestTimeMs()} funders={funders} />;
}
