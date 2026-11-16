import type { Metadata } from "next";
import { AlertsList } from "@/components/alerts/AlertsList";
import { requireSession } from "@/lib/auth/server";
import { listAlerts } from "@/lib/alerts/feed";
import { db } from "@/lib/db";
import { loadShell } from "@/lib/data/shell";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const session = await requireSession();
  const { unreadAlerts } = await loadShell(session.userId);
  return {
    title: unreadAlerts > 0 ? `(${unreadAlerts}) Alerts — Selective CRM` : "Alerts — Selective CRM",
  };
}

/** The person's alert feed: approvals that landed, files sitting too long, kickbacks, what the trust checks saw. */
export default async function AlertsPage() {
  const session = await requireSession();
  const [{ ctx }, rows] = await Promise.all([
    loadShell(session.userId),
    db.withUser(session.userId, (q) => listAlerts(q)),
  ]);
  const unread = rows.filter((r) => r.read_at === null).length;
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Alerts</h1>
          <p className="text-sm text-muted">
            {unread === 0
              ? "Nothing unread. The hourly email carries these too."
              : `${unread} unread · the hourly email carries these too.`}
          </p>
        </div>
      </div>
      <AlertsList rows={rows} timezone={ctx.timezone} />
    </div>
  );
}
