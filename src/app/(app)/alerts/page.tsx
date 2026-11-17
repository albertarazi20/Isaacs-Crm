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
  return { title: unreadAlerts > 0 ? `Alerts (${unreadAlerts} unread)` : "Alerts" };
}

/** The person's alert feed: signed applications, paused templates, bounce spikes. */
export default async function AlertsPage() {
  const session = await requireSession();
  const [{ ctx }, rows] = await Promise.all([
    loadShell(session.userId),
    db.withUser(session.userId, (q) => listAlerts(q)),
  ]);
  return <AlertsList rows={rows} timezone={ctx.timezone} today={ctx.today} />;
}
