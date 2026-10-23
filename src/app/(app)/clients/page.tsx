import { ClientsTable } from "@/components/ClientsTable";
import { requireSession } from "@/lib/auth/server";
import { listCards } from "@/lib/data/queries";
import { db } from "@/lib/db";

export default async function ClientsPage() {
  const session = await requireSession();
  const cards = await db.withUser(session.userId, (q) => listCards(q));
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">Clients</h1>
      <ClientsTable cards={cards} />
    </div>
  );
}
