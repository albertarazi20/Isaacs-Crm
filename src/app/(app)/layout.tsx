import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cache } from "react";
import { AppProvider } from "@/components/app-context";
import { LogoutButton } from "@/components/LogoutButton";
import { NavLink } from "@/components/NavLink";
import { ToastProvider } from "@/components/overlay";
import { PendingTouchPrompt } from "@/components/ContactActions";
import { QuickAdd } from "@/components/QuickAdd";
import { requireSession } from "@/lib/auth/server";
import { dueCount, userContext } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { requestTimeMs } from "@/lib/server-time";
import { gmailStatus } from "@/lib/system/gmail";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/", label: "Today" },
  { href: "/board", label: "Board" },
  { href: "/clients", label: "Clients" },
  { href: "/renewals", label: "Renewals" },
  { href: "/long-game", label: "Long game" },
  { href: "/settings", label: "Settings" },
];

const loadShell = cache(async (userId: string) =>
  db.withUser(userId, async (q) => {
    const ctx = await userContext(q);
    const { rows } = await q.query<{ name: string; email: string }>(
      "select name, email from app_users where id = app.current_user_id()",
    );
    return { ctx, user: rows[0], due: await dueCount(q, ctx.today) };
  }),
);

/** "(12) Isaac" in the tab. Set here, on the server, because Next re-applies page metadata after hydration. */
export async function generateMetadata(): Promise<Metadata> {
  const session = await requireSession();
  const { due } = await loadShell(session.userId);
  return { title: due > 0 ? `(${due}) Isaac — follow-up CRM` : "Isaac — follow-up CRM" };
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const me = await loadShell(session.userId);
  if (!me.user) redirect("/login?error=session_expired");
  const gmail = await gmailStatus(session.userId);

  return (
    <AppProvider
      value={{
        today: me.ctx.today,
        timezone: me.ctx.timezone,
        senderName: me.user.name || me.user.email.split("@")[0] || "Isaac",
        gmailConnected: gmail.connected,
        gmailNeedsReconnect: gmail.needsReconnect,
        nowMs: requestTimeMs(),
      }}
    >
      <ToastProvider>
        <header className="sticky top-0 z-30 border-b border-border bg-surface/90 backdrop-blur">
          <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-2">
            <span className="text-base font-bold tracking-tight">Isaac</span>
            <nav aria-label="Main" className="flex flex-1 gap-1 overflow-x-auto">
              {NAV.map((n) => (
                <NavLink key={n.href} href={n.href} badge={n.href === "/" ? me.due : undefined}>
                  {n.label}
                </NavLink>
              ))}
            </nav>
            <QuickAdd />
            <LogoutButton email={me.user.email} />
          </div>
        </header>
        {gmail.needsReconnect ? (
          <div className="bg-warn-soft px-4 py-2 text-center text-sm text-warn">
            Gmail needs to be reconnected —{" "}
            <a className="font-semibold underline" href="/api/auth/google?purpose=gmail">
              reconnect now
            </a>
            . Until then, emails open in Gmail instead of sending.
          </div>
        ) : null}
        <main className="mx-auto max-w-[1600px] px-4 py-5">{children}</main>
        <PendingTouchPrompt />
      </ToastProvider>
    </AppProvider>
  );
}
