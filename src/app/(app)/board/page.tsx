import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Board } from "@/components/board/Board";
import { resolveView, VIEW_COOKIE } from "@/components/board/logic";
import { requireSession } from "@/lib/auth/server";
import { listCards } from "@/lib/data/queries";
import { loadShell } from "@/lib/data/shell";
import { db } from "@/lib/db";

/** "(12) Board — Isaac": the due count rides in the tab title like every other page. */
export async function generateMetadata(): Promise<Metadata> {
  const session = await requireSession();
  const { due } = await loadShell(session.userId);
  return { title: due > 0 ? `(${due}) Board — Isaac` : "Board — Isaac" };
}

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const session = await requireSession();
  const [{ view }, cards, store] = await Promise.all([
    searchParams,
    db.withUser(session.userId, (q) => listCards(q)),
    cookies(),
  ]);
  // ?view= wins; a bare /board (the nav link) opens the view he used last.
  return <Board initialCards={cards} view={resolveView(view, store.get(VIEW_COOKIE)?.value)} />;
}
