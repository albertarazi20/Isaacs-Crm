import { cookies } from "next/headers";
import Link from "next/link";
import { SecurityPanel } from "@/components/SecurityPanel";
import { ICON, Icon, Note, SettingsCard } from "@/components/settings/primitives";
import { SettingsHeader } from "@/components/settings/SettingsNav";
import { SettingsPanels } from "@/components/SettingsPanels";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { MessagesCard } from "@/components/messaging/MessagesCard";
import { requireSession } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { env, googleConfigured } from "@/lib/env";
import { getMessageSettings, listSnippets } from "@/lib/messaging/queries";
import { timeAgo } from "@/lib/format";
import { requestTimeMs } from "@/lib/server-time";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import { gmailStatus } from "@/lib/system/gmail";
import { reminderStatus } from "@/lib/system/heartbeat";

const NOTICES: Record<string, { tone: "good" | "bad"; text: string }> = {
  connected: {
    tone: "good",
    text: "Gmail connected. Emails you send from the CRM now come from your own Gmail.",
  },
  gmail_not_granted: {
    tone: "bad",
    text: "Google didn't give permission to send email. Try again and tick the box that lets this app send email for you.",
  },
  session_expired: {
    tone: "bad",
    text: "Your session ended while connecting. Sign in and try again.",
  },
  google_error: { tone: "bad", text: "Google connection failed. Try again." },
  access_denied: { tone: "bad", text: "Gmail connection was cancelled." },
  bad_state: { tone: "bad", text: "That connect link expired. Try again." },
};

const LINK =
  "inline-flex min-h-8 items-center gap-1 text-sm font-medium text-accent hover:underline";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ gmail?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const session = await requireSession();
  const user = await db.withUser(session.userId, async (q) => {
    const { rows } = await q.query<{
      email: string;
      timezone: string;
      digest_enabled: boolean;
      digest_hour: number;
    }>(
      "select email, timezone, digest_enabled, digest_hour from app_users where id = app.current_user_id()",
    );
    return rows[0];
  });
  const gmail = await gmailStatus(session.userId);
  const messages = await db.withUser(session.userId, async (q) => ({
    settings: await getMessageSettings(q),
    snippets: await listSnippets(q),
  }));
  const reminders = await reminderStatus(session.userId, { now: new Date(requestTimeMs()) }).catch(
    () => null,
  );
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const e = env();
  const key = sp.gmail ?? sp.error ?? "";
  const notice = Object.hasOwn(NOTICES, key) ? NOTICES[key] : undefined;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <SettingsHeader role={session.role} current="/settings" />
      {notice ? (
        <Note role="status" tone={notice.tone}>
          {notice.text}
        </Note>
      ) : null}
      <SettingsPanels
        loginEmail={user?.email ?? session.email}
        settings={{
          timezone: user?.timezone ?? "America/New_York",
          digestEnabled: user?.digest_enabled ?? true,
          digestHour: user?.digest_hour ?? 8,
        }}
        gmail={{
          connected: gmail.connected,
          needsReconnect: gmail.needsReconnect,
          googleEmail: gmail.googleEmail,
          configured: googleConfigured(e),
        }}
        resendReady={Boolean(e.RESEND_API_KEY && e.RESEND_FROM)}
      />
      <SettingsCard
        title="Appearance"
        description="Light, dark, or follow this device. It is the same switch as in the account menu, and it sticks on every page."
      >
        <ThemeSwitch initial={theme} />
      </SettingsCard>
      <MessagesCard initial={messages.settings} initialSnippets={messages.snippets} />
      <SettingsCard
        title="Hourly reminder scheduler"
        description={
          !reminders?.configured
            ? `Not set up yet. Reminder emails need ${
                reminders && reminders.missing.length > 0
                  ? reminders.missing.join(", ")
                  : "the email key, the sender address and the scheduler secret"
              } on the server.`
            : reminders.lastRunAt
              ? `Last ran ${timeAgo(reminders.lastRunAt, new Date(requestTimeMs()))}.${reminders.stale ? " That is too long ago — check the scheduler." : ""}`
              : "Has not run yet."
        }
      />
      <SettingsCard
        title="Lead intake"
        description="Send new merchants in from a website form, Zapier or a lead vendor. They land on Today as call-now."
      >
        <Link href="/lead-intake" className={LINK}>
          Set up lead intake
          <Icon d={ICON.arrowRight} className="size-3.5" />
        </Link>
      </SettingsCard>
      <SettingsCard
        title="Your data"
        description="Everything you have put in — merchants, advances, offers, notes, timers — as one file you can keep. It holds no passwords, Gmail access or tokens."
      >
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <a href="/api/export/backup" className={LINK} download>
            <Icon d={ICON.download} className="size-3.5" />
            Download a full backup (.json)
          </a>
          <a href="/api/export/clients" className={LINK} download>
            <Icon d={ICON.download} className="size-3.5" />
            Merchants (.csv)
          </a>
          <a href="/api/export/activity" className={LINK} download>
            <Icon d={ICON.download} className="size-3.5" />
            All notes (.csv)
          </a>
        </div>
      </SettingsCard>
      <SecurityPanel />
    </div>
  );
}
