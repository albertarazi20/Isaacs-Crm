import type { Metadata } from "next";
import { Board } from "@/components/board/Board";
import { parseView } from "@/components/board/logic";
import { requireSession } from "@/lib/auth/server";
import { listCards } from "@/lib/data/queries";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Board — Isaac" };

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const session = await requireSession();
  const [{ view }, cards] = await Promise.all([
    searchParams,
    db.withUser(session.userId, (q) => listCards(q)),
  ]);
  return <Board initialCards={cards} view={parseView(view)} />;
}
