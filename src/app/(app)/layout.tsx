import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppProvider } from "@/components/app-context";
import { LogoutButton } from "@/components/LogoutButton";
import { NavLink } from "@/components/NavLink";
import { ToastProvider } from "@/components/overlay";
import { PendingTouchPrompt } from "@/components/ContactActions";
import { HotImport } from "@/components/power/HotImport";
import { GlobalSearch } from "@/components/power/GlobalSearch";
import { MobileTabBar } from "@/components/power/MobileTabBar";
import { QuickAdd } from "@/components/QuickAdd";
import { requireSession } from "@/lib/auth/server";
import { loadShell } from "@/lib/data/shell";
import { requestTimeMs } from "@/lib/server-time";
import { gmailStatus } from "@/lib/system/gmail";
import { reminderStatus } from "@/lib/system/heartbeat";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/", label: "Today" },
  { href: "/board", label: "Board" },
  { href: "/clients", label: "Clients" },
  { href: "/renewals", label: "Renewals" },
  { href: "/winback", label: "Win-back" },
  { href: "/funders", label: "Funders" },
  { href: "/earnings", label: "Earnings" },
  { href: "/reports", label: "Reports" },
  { href: "/long-game", label: "Long game" },
  { href: "/settings", label: "Settings" },
];

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
  const [gmail, reminders] = await Promise.all([
    gmailStatus(session.userId),
    // The banner is a safety net: if the heartbeat can't be read, the page still renders.
    reminderStatus(session.userId, { now: new Date(requestTimeMs()) }).catch((e: unknown) => {
      console.error("reminder heartbeat unreadable:", e);
      return null;
    }),
  ]);

  return (
    <AppProvider
      value={{
        today: me.ctx.today,
        timezone: me.ctx.timezone,
        senderName: me.user.name || me.user.email.split("@")[0] || "Isaac",
        gmailConnected: gmail.connected,
        gmailNeedsReconnect: gmail.needsReconnect,
        hotIds: me.hotIds,
        nowMs: requestTimeMs(),
      }}
    >
      <ToastProvider>
        <header
          data-app-header
          className="sticky top-0 z-30 border-b border-border bg-surface/90 backdrop-blur"
        >
          <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-2">
            <span className="text-base font-bold tracking-tight">Isaac</span>
            <nav aria-label="Main" className="hidden flex-1 gap-1 overflow-x-auto sm:flex">
              {NAV.map((n) => (
                <NavLink key={n.href} href={n.href} badge={n.href === "/" ? me.due : undefined}>
                  {n.label}
                </NavLink>
              ))}
            </nav>
            <div className="flex-1 sm:hidden" />
            <GlobalSearch />
            <QuickAdd />
            <div className="hidden sm:block">
              <LogoutButton email={me.user.email} />
            </div>
          </div>
        </header>
        {reminders?.stale ? (
          <div
            role="status"
            className="border-b border-bad/40 bg-bad-soft px-4 py-2 text-center text-sm font-medium text-bad"
          >
            {reminders.missing.length > 0
              ? `Reminder emails can't go out — the server is missing ${reminders.missing.join(", ")}.`
              : reminders.neverRan
                ? "Reminder emails have never gone out — check the hourly scheduler."
                : `Reminder emails haven't gone out for ${reminders.hoursSince} hours — check the hourly scheduler.`}
          </div>
        ) : null}
        {gmail.needsReconnect ? (
          <div className="bg-warn-soft px-4 py-2 text-center text-sm text-warn">
            Gmail needs to be reconnected —{" "}
            <a className="font-semibold underline" href="/api/auth/google?purpose=gmail">
              reconnect now
            </a>
            . Until then, emails open in Gmail instead of sending.
          </div>
        ) : null}
        {/* pb-24 on a phone keeps the last card clear of the fixed tab bar */}
        <main className="mx-auto max-w-[1600px] px-4 py-5 pb-24 sm:pb-5">{children}</main>
        <MobileTabBar due={me.due} email={me.user.email} />
        <PendingTouchPrompt />
        <HotImport />
      </ToastProvider>
    </AppProvider>
  );
}
