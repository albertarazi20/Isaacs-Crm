import type { Metadata } from "next";
import Link from "next/link";
import { ClientsTable } from "@/components/ClientsTable";
import { OverflowMenu } from "@/components/OverflowMenu";
import { Glyph } from "@/components/shell/icons";
import { NewLeadButton } from "@/components/shell/NewLead";
import { PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { listCardMeta } from "@/lib/data/cardMeta";
import { listCards, userContext } from "@/lib/data/queries";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Merchants" };

export default async function ClientsPage() {
  const session = await requireSession();
  const { cards, meta, today } = await db.withUser(session.userId, async (q) => {
    // One at a time: a pooled connection runs a single query at once.
    const cards = await listCards(q);
    const meta = await listCardMeta(q);
    const ctx = await userContext(q);
    return { cards, meta, today: ctx.today };
  });
  const overdue = cards.filter((c) => c.next_due_on !== null && c.next_due_on < today).length;
  const brought = cards.filter((c) => meta[c.id]?.brought_in_at).length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Merchants"
        title={
          <>
            All merchants{" "}
            <span className="text-muted tabular-nums">{cards.length.toLocaleString("en-US")}</span>
          </>
        }
        description={
          cards.length === 0
            ? "Your book is empty. Add a lead and it shows up here with its first follow-up."
            : `Your whole book: ${overdue} overdue, ${brought} brought in.`
        }
        actions={
          <>
            {/* Downloads are plain links (the browser saves the file); pages go through the router. */}
            <OverflowMenu label="Export and tools" text="Export">
              <a href="/api/export/clients">
                <Glyph name="sheet" className="size-4 text-muted" />
                Download merchants (CSV)
              </a>
              <a href="/api/export/activity">
                <Glyph name="file" className="size-4 text-muted" />
                Download notes (CSV)
              </a>
              <Link href="/import">
                <Glyph name="upload" className="size-4 text-muted" />
                Import a file
              </Link>
            </OverflowMenu>
            <NewLeadButton />
          </>
        }
      />
      <ClientsTable cards={cards} meta={meta} />
    </div>
  );
}
