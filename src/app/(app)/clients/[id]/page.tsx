import { notFound } from "next/navigation";
import { ClientView } from "@/components/client/ClientView";
import { requireSession } from "@/lib/auth/server";
import { getClientDetail } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getClientFundersData } from "@/lib/funders/queries";
import { merchantApplication } from "@/lib/leads/application";
import { logAccess } from "@/lib/trust/queries";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The clock at request time. The page is dynamic (cookies), so this is never a cached value. */
const requestTimeMs = () => Date.now();

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A malformed id would make Postgres throw (500); it is just "no such client".
  if (!UUID.test(id)) notFound();
  const session = await requireSession();
  // RLS scopes this to the signed-in user, so another user's id comes back null like a missing one.
  const { detail, funders, application } = await db.withUser(session.userId, async (q) => {
    const detail = await getClientDetail(q, id);
    if (detail) {
      // a manager or ops opening a rep's merchant is a contact view the trust panel counts (P2-51)
      const owner = await q.query<{ user_id: string }>(
        "select user_id from clients where id = $1",
        [id],
      );
      if (owner.rows[0] && owner.rows[0].user_id !== session.userId)
        await logAccess(q, {
          userId: session.userId,
          action: "view_contact",
          clientId: id,
          detail: "merchant page",
        });
    }
    return {
      detail,
      funders: await getClientFundersData(q, id),
      application: detail ? await merchantApplication(q, id) : null,
    };
  });
  if (!detail) notFound();
  return (
    <ClientView
      detail={detail}
      serverNow={requestTimeMs()}
      funders={funders}
      role={session.role}
      application={application}
      appUrl={env().APP_URL}
    />
  );
}
