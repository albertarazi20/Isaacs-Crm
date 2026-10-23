import { redirect } from "next/navigation";
import { AppProvider } from "@/components/app-context";
import { logoutAction } from "@/app/actions";
import { NavLink } from "@/components/NavLink";
import { ToastProvider } from "@/components/overlay";
import { PendingTouchPrompt } from "@/components/ContactActions";
import { QuickAdd } from "@/components/QuickAdd";
import { TitleBadge } from "@/components/TitleBadge";
import { Button } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { dueCount, userContext } from "@/lib/data/queries";
import { db } from "@/lib/db";
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

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const me = await db.withUser(session.userId, async (q) => {
    const ctx = await userContext(q);
    const { rows } = await q.query<{ name: string; email: string }>(
      "select name, email from app_users where id = app.current_user_id()",
    );
    return { ctx, user: rows[0], due: await dueCount(q, ctx.today) };
  });
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
            <form action={logoutAction}>
              <Button variant="ghost" size="sm" type="submit" title={me.user.email}>
                Log out
              </Button>
            </form>
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
        <TitleBadge count={me.due} />
      </ToastProvider>
    </AppProvider>
  );
}
