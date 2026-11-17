import type { Metadata } from "next";
import { DialRunner, type DialItem } from "@/components/power/DialRunner";
import { requireSession } from "@/lib/auth/server";
import { followUpReasons } from "@/lib/data/overdue";
import { priorityOf, rankCards } from "@/lib/data/priority";
import { listCards, userContext } from "@/lib/data/queries";
import { buildToday } from "@/lib/data/views";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Power dial" };

/**
 * Today's call list as a queue: calls booked for today (they are appointments, earliest first), then
 * everything overdue or due today by money-first priority. Do-not-contact merchants are already left out.
 */
export default async function DialPage() {
  const session = await requireSession();
  const items = await db.withUser(session.userId, async (q): Promise<DialItem[]> => {
    const cards = await listCards(q);
    const ctx = await userContext(q);
    const view = buildToday(cards, ctx.today, ctx.timezone);
    const prio = { today: ctx.today, timezone: ctx.timezone };
    const queue = [
      ...view.scheduled.map((card) => ({ card, priority: priorityOf(card, prio) })),
      ...rankCards([...view.overdue, ...view.dueToday], prio, "biggest"),
    ];
    const reasons = await followUpReasons(
      q,
      queue.map((r) => r.card.id),
    );
    return queue.map(({ card, priority }) => ({
      card,
      priority,
      reason: reasons[card.id]?.note ?? "",
    }));
  });
  return <DialRunner items={items} />;
}
