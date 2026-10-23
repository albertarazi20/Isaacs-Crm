import { FundersManager } from "@/components/funders/FundersManager";
import { requireSession } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { funderScoreboard, listFunders } from "@/lib/funders/queries";

export default async function FundersPage() {
  const session = await requireSession();
  const { funders, scores } = await db.withUser(session.userId, async (q) => {
    const funders = await listFunders(q);
    return {
      funders,
      scores: await funderScoreboard(
        q,
        funders.map((f) => f.id),
      ),
    };
  });
  return <FundersManager funders={funders} scores={scores} />;
}
