import Link from "next/link";
import { ClientsTable } from "@/components/ClientsTable";
import { buttonClass } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { listCards } from "@/lib/data/queries";
import { db } from "@/lib/db";

export default async function ClientsPage() {
  const session = await requireSession();
  const cards = await db.withUser(session.userId, (q) => listCards(q));
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Clients</h1>
        <Link href="/import" className={buttonClass("secondary", "md")}>
          Import from spreadsheet
        </Link>
      </div>
      <ClientsTable cards={cards} />
    </div>
  );
}
