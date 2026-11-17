import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppProvider } from "@/components/app-context";
import { ToastProvider } from "@/components/overlay";
import { PendingTouchPrompt } from "@/components/ContactActions";
import { HotImport } from "@/components/power/HotImport";
import { GlobalSearch } from "@/components/power/GlobalSearch";
import { ReminderWatcher } from "@/components/ReminderWatcher";
import { AssistantProvider } from "@/components/assistant/Assistant";
import { NewLeadProvider } from "@/components/shell/NewLead";
import { Sidebar } from "@/components/shell/Sidebar";
import { CAN, ROLE_LABEL } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/server";
import { listBuckets } from "@/lib/buckets/queries";
import { loadShell } from "@/lib/data/shell";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { assistantState } from "@/lib/leads/assistant";
import { requestTimeMs } from "@/lib/server-time";
import { gmailStatus } from "@/lib/system/gmail";
import { reminderStatus } from "@/lib/system/heartbeat";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import { appTitle } from "@/lib/title";

export const dynamic = "force-dynamic";

/**
 * "(12) Follow Up · Selective CRM" in the tab: each page names itself and this template adds the due count. Set
 * here, on the server, because Next re-applies page metadata after hydration. The Overview sits in this same
 * segment, where a template does not reach, so it builds its whole title (src/app/(app)/page.tsx).
 */
export async function generateMetadata(): Promise<Metadata> {
  const session = await requireSession();
  const { due } = await loadShell(session.userId);
  return { title: { template: appTitle(due, "%s"), default: appTitle(due) } };
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const me = await loadShell(session.userId);
  if (!me.user) redirect("/login?error=session_expired");
  const [gmail, reminders, store, shell] = await Promise.all([
    gmailStatus(session.userId),
    // The banner is a safety net: if the heartbeat can't be read, the page still renders.
    reminderStatus(session.userId, { now: new Date(requestTimeMs()) }).catch((e: unknown) => {
      console.error("reminder heartbeat unreadable:", e);
      return null;
    }),
    cookies(),
    // the sidebar's Follow Up dropdown and the New lead sheet both need the buckets
    db.withUser(session.userId, async (q) => ({
      buckets: await listBuckets(q),
      assistant: await assistantState(q, Boolean(env().ANTHROPIC_API_KEY)),
    })),
  ]);
  const theme = parseTheme(store.get(THEME_COOKIE)?.value);
  const live = shell.buckets.filter((b) => b.active);

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
      }}
    >
      <ToastProvider>
        <NewLeadProvider buckets={live} assistant={shell.assistant}>
          <AssistantProvider state={shell.assistant}>
            <ReminderWatcher />
            <a
              href="#content"
              className="sr-only z-50 rounded-full bg-surface px-4 py-2 text-sm font-semibold shadow-pop focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
            >
              Skip to content
            </a>
            <Sidebar
              user={{
                name: me.user.name,
                email: me.user.email,
                roleLabel: ROLE_LABEL[session.role],
              }}
              theme={theme}
              manager={CAN.manageTeam(session.role)}
              buckets={live.map((b) => ({
                id: b.id,
                name: b.name,
                count: b.members,
                mine: b.owner_id !== null,
              }))}
              due={me.due}
              unreadAlerts={me.unreadAlerts}
            />
            <GlobalSearch />
            <div className="lg:pl-[272px]">
              {reminders?.stale ? (
                <div
                  role="status"
                  className="border-b border-bad/30 bg-bad-soft px-4 py-2 text-center text-sm font-medium text-bad"
                >
                  {reminders.missing.length > 0
                    ? `Reminder emails can't go out: the server is missing ${reminders.missing.join(", ")}.`
                    : reminders.neverRan
                      ? "Reminder emails have never gone out. Check the hourly scheduler."
                      : `Reminder emails haven't gone out for ${reminders.hoursSince} hours. Check the hourly scheduler.`}
                </div>
              ) : null}
              {gmail.needsReconnect ? (
                <div className="border-b border-warn/30 bg-warn-soft px-4 py-2 text-center text-sm text-warn">
                  Gmail needs to be reconnected:{" "}
                  <a className="font-semibold underline" href="/api/auth/google?purpose=gmail">
                    reconnect now
                  </a>
                  . Until then, emails open in Gmail instead of sending.
                </div>
              ) : null}
              <main
                id="content"
                tabIndex={-1}
                className="mx-auto max-w-[1480px] outline-none px-4 py-5 pb-16 sm:px-6 sm:py-7 lg:px-9 lg:py-8"
              >
                {children}
              </main>
            </div>
            <PendingTouchPrompt />
            <HotImport />
          </AssistantProvider>
        </NewLeadProvider>
      </ToastProvider>
    </AppProvider>
  );
}
