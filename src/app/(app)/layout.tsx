import type { Metadata } from "next";
import { cookies } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppProvider } from "@/components/app-context";
import { NavLink } from "@/components/NavLink";
import { ToastProvider } from "@/components/overlay";
import { PendingTouchPrompt } from "@/components/ContactActions";
import { HotImport } from "@/components/power/HotImport";
import { GlobalSearch } from "@/components/power/GlobalSearch";
import { MobileTabBar } from "@/components/power/MobileTabBar";
import { QuickAdd } from "@/components/QuickAdd";
import { ReminderWatcher } from "@/components/ReminderWatcher";
import { UserMenu } from "@/components/UserMenu";
import { requireSession } from "@/lib/auth/server";
import { navFor } from "@/lib/nav";
import { loadShell } from "@/lib/data/shell";
import { requestTimeMs } from "@/lib/server-time";
import { gmailStatus } from "@/lib/system/gmail";
import { reminderStatus } from "@/lib/system/heartbeat";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";

export const dynamic = "force-dynamic";

// the main nav depends on the role: ops see the Submission Board, reps their deals and buckets, managers everything

/** "(12) Selective CRM" in the tab. Set here, on the server, because Next re-applies page metadata after hydration. */
export async function generateMetadata(): Promise<Metadata> {
  const session = await requireSession();
  const { due } = await loadShell(session.userId);
  return { title: due > 0 ? `(${due}) Selective CRM` : "Selective CRM" };
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const me = await loadShell(session.userId);
  if (!me.user) redirect("/login?error=session_expired");
  // the first-login gate (plan §14.7): nothing opens until the policy is accepted once
  if (!me.user.policy_accepted_at) redirect("/policy");
  const [gmail, reminders, store] = await Promise.all([
    gmailStatus(session.userId),
    // The banner is a safety net: if the heartbeat can't be read, the page still renders.
    reminderStatus(session.userId, { now: new Date(requestTimeMs()) }).catch((e: unknown) => {
      console.error("reminder heartbeat unreadable:", e);
      return null;
    }),
    cookies(),
  ]);
  const theme = parseTheme(store.get(THEME_COOKIE)?.value);

  return (
    <AppProvider
      value={{
        today: me.ctx.today,
        timezone: me.ctx.timezone,
        senderName: me.user.name || me.user.email.split("@")[0] || "Selective Capital",
        gmailConnected: gmail.connected,
        gmailNeedsReconnect: gmail.needsReconnect,
        hotIds: me.hotIds,
        nowMs: requestTimeMs(),
        maxLendersPerDeal: me.maxLendersPerDeal,
      }}
    >
      <ToastProvider>
        <ReminderWatcher />
        <header
          data-app-header
          className="sticky top-0 z-30 border-b border-border bg-surface/80 backdrop-blur-md"
        >
          <div className="mx-auto flex h-13 max-w-[1600px] items-center gap-2 px-4 sm:gap-3 sm:px-6">
            <Link
              href="/"
              aria-label="Selective CRM home"
              className="flex shrink-0 items-center pr-1 sm:pr-2"
            >
              <Image
                src="/brand/SC-logomark-light-web.png"
                alt=""
                width={24}
                height={28}
                priority
                className="only-light sm:hidden"
              />
              <Image
                src="/brand/SC-logomark-dark-web.png"
                alt=""
                width={24}
                height={28}
                priority
                className="only-dark sm:hidden"
              />
              <Image
                src="/brand/SC-horizontal-light-web.png"
                alt="Selective Capital"
                width={136}
                height={22}
                priority
                className="only-light hidden sm:block"
              />
              <Image
                src="/brand/SC-horizontal-dark-web.png"
                alt="Selective Capital"
                width={136}
                height={22}
                priority
                className="only-dark hidden sm:block"
              />
            </Link>
            <nav
              aria-label="Main"
              className="hidden min-w-0 flex-1 gap-0.5 overflow-x-auto sm:flex"
            >
              {navFor(session.role).map((n) => (
                <NavLink key={n.href} href={n.href} badge={n.href === "/" ? me.due : undefined}>
                  {n.label}
                </NavLink>
              ))}
            </nav>
            <div className="flex-1 sm:hidden" />
            <GlobalSearch />
            <Link
              href="/alerts"
              aria-label={me.unreadAlerts > 0 ? `Alerts, ${me.unreadAlerts} unread` : "Alerts"}
              className="relative hidden size-9 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-text sm:inline-flex"
            >
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                className="size-[18px]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0" />
              </svg>
              {me.unreadAlerts > 0 ? (
                <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-bad px-1 text-center text-[10px] leading-4 font-semibold text-white tabular-nums">
                  {me.unreadAlerts > 99 ? "99+" : me.unreadAlerts}
                </span>
              ) : null}
            </Link>
            <QuickAdd />
            <div className="hidden sm:block">
              <UserMenu
                name={me.user.name}
                email={me.user.email}
                role={session.role}
                theme={theme}
              />
            </div>
          </div>
        </header>
        {reminders?.stale ? (
          <div
            role="status"
            className="border-b border-bad/30 bg-bad-soft px-4 py-2 text-center text-sm font-medium text-bad"
          >
            {reminders.missing.length > 0
              ? `Reminder emails can't go out — the server is missing ${reminders.missing.join(", ")}.`
              : reminders.neverRan
                ? "Reminder emails have never gone out — check the hourly scheduler."
                : `Reminder emails haven't gone out for ${reminders.hoursSince} hours — check the hourly scheduler.`}
          </div>
        ) : null}
        {gmail.needsReconnect ? (
          <div className="border-b border-warn/30 bg-warn-soft px-4 py-2 text-center text-sm text-warn">
            Gmail needs to be reconnected —{" "}
            <a className="font-semibold underline" href="/api/auth/google?purpose=gmail">
              reconnect now
            </a>
            . Until then, emails open in Gmail instead of sending.
          </div>
        ) : null}
        {/* pb-24 on a phone keeps the last card clear of the fixed tab bar */}
        <main className="mx-auto max-w-[1600px] px-4 py-5 pb-24 sm:px-6 sm:py-6 sm:pb-8">
          {children}
        </main>
        <MobileTabBar due={me.due} email={me.user.email} role={session.role} />
        <PendingTouchPrompt />
        <HotImport />
      </ToastProvider>
    </AppProvider>
  );
}
