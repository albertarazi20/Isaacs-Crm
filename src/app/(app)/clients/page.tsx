import Link from "next/link";
import { ClientsTable } from "@/components/ClientsTable";
import { OverflowMenu } from "@/components/OverflowMenu";
import { buttonClass } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { listCards } from "@/lib/data/queries";
import { db } from "@/lib/db";

const TOOLS = [
  { href: "/api/export/clients", label: "Download clients (CSV)" },
  { href: "/api/export/activity", label: "Download notes (CSV)" },
  { href: "/import", label: "Import from spreadsheet" },
  { href: "/lead-intake", label: "Lead intake" },
  { href: "/trash", label: "Trash" },
];

/** Downloads are plain links (the browser saves the file); pages go through the router. */
function ToolLink({ tool, className }: { tool: (typeof TOOLS)[number]; className?: string }) {
  return tool.href.startsWith("/api/") ? (
    <a href={tool.href} className={className}>
      {tool.label}
    </a>
  ) : (
    <Link href={tool.href} className={className}>
      {tool.label}
    </Link>
  );
}

export default async function ClientsPage() {
  const session = await requireSession();
  const cards = await db.withUser(session.userId, (q) => listCards(q));
  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Merchants</h1>
        {/* Wide screens: every action is a button. A phone folds them into one "…" menu so the list starts near the top. */}
        <div className="hidden flex-wrap justify-end gap-2 sm:flex">
          {TOOLS.map((t) => (
            <ToolLink key={t.href} tool={t} className={buttonClass("secondary", "sm")} />
          ))}
        </div>
        <OverflowMenu label="More actions">
          {TOOLS.map((t) => (
            <ToolLink key={t.href} tool={t} />
          ))}
        </OverflowMenu>
      </div>
      <ClientsTable cards={cards} />
    </div>
  );
}
