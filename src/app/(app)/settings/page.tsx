import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SecurityPanel } from "@/components/SecurityPanel";
import { ApprovalPhoneField } from "@/components/settings/ApprovalPhoneField";
import {
  ICON,
  Icon,
  Note,
  SettingRow,
  SettingsCard,
  StatusChip,
} from "@/components/settings/primitives";
import { BackupRow } from "@/components/settings/BackupPanel";
import { SettingsPage } from "@/components/settings/SettingsNav";
import { SettingsPanels } from "@/components/SettingsPanels";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { MessagesCard } from "@/components/messaging/MessagesCard";
import { Avatar, Badge, buttonClass, LinkButton } from "@/components/ui";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { CAN, requireSession } from "@/lib/auth/server";
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

const ZONE_LABEL: Record<string, string> = {
  "America/New_York": "Eastern time",
  "America/Chicago": "Central time",
  "America/Denver": "Mountain time",
  "America/Phoenix": "Arizona time",
  "America/Los_Angeles": "Pacific time",
  "America/Anchorage": "Alaska time",
  "Pacific/Honolulu": "Hawaii time",
};

const EXPORTS = [
  {
    href: "/api/export/clients",
    label: "Merchants (.csv)",
    title: "Merchants (.csv)",
    hint: "One row per merchant, ready for a spreadsheet.",
  },
  {
    href: "/api/export/activity",
    label: "All notes (.csv)",
    title: "All notes (.csv)",
    hint: "Every note and call you logged, oldest first.",
  },
] as const;

export const metadata: Metadata = { title: "Settings" };

export default async function AccountSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ gmail?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const session = await requireSession();
  const user = await db.withUser(session.userId, async (q) => {
    const { rows } = await q.query<{
      email: string;
      name: string;
      timezone: string;
      digest_enabled: boolean;
      digest_hour: number;
      phone: string;
    }>("select email, name, timezone, digest_enabled, digest_hour, phone from app.my_user");
    return rows[0];
  });
  const gmail = await gmailStatus(session.userId);
  const messages = await db.withUser(session.userId, async (q) => ({
    settings: await getMessageSettings(q),
    snippets: await listSnippets(q),
  }));
  const now = new Date(requestTimeMs());
  const reminders = await reminderStatus(session.userId, { now }).catch(() => null);
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const e = env();
  const key = sp.gmail ?? sp.error ?? "";
  const notice = Object.hasOwn(NOTICES, key) ? NOTICES[key] : undefined;
  const email = user?.email ?? session.email;
  const name = user?.name || email.split("@")[0] || email;
  const timezone = user?.timezone ?? "America/New_York";

  const scheduler: {
    tone: "good" | "warn" | "bad" | "neutral";
    label: string;
    detail: string;
  } = !reminders?.configured
    ? {
        tone: "warn",
        label: "Not set up",
        detail: `Reminder emails need ${
          reminders && reminders.missing.length > 0
            ? reminders.missing.join(", ")
            : "the email key, the sender address and the scheduler secret"
        } on the server.`,
      }
    : reminders.lastRunAt
      ? reminders.stale
        ? {
            tone: "bad",
            label: "Stalled",
            detail: `Last ran ${timeAgo(reminders.lastRunAt, now)}. That is too long ago: check the scheduler.`,
          }
        : {
            tone: "good",
            label: "Running",
            detail: `Last ran ${timeAgo(reminders.lastRunAt, now)}.`,
          }
      : { tone: "neutral", label: "Waiting", detail: "Has not run yet." };

  return (
    <SettingsPage
      role={session.role}
      current="/settings"
      title="My account"
      description="Your profile, your morning reminders, your Gmail and how the app looks on this device."
      notice={
        notice ? (
          <Note role="status" tone={notice.tone}>
            {notice.text}
          </Note>
        ) : null
      }
    >
      <SettingsCard
        title="Profile"
        description="Who you are here. Your name and sign-in come from your Google account."
      >
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={name} size={52} />
          <div className="min-w-0 flex-1 basis-48">
            <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold tracking-tight">
              <span className="truncate">{name}</span>
              <Badge tone="accent">{ROLE_LABEL[session.role]}</Badge>
            </p>
            <p className="truncate text-[13px] text-muted">{email}</p>
          </div>
          <dl className="flex shrink-0 gap-6 text-[13px]">
            <div>
              <dt className="eyebrow">Sign-in</dt>
              <dd className="mt-0.5 font-medium">Google</dd>
            </div>
            <div>
              <dt className="eyebrow">Time zone</dt>
              <dd className="mt-0.5 font-medium">{ZONE_LABEL[timezone] ?? timezone}</dd>
            </div>
          </dl>
        </div>
        <ApprovalPhoneField initial={user?.phone ?? ""} />
      </SettingsCard>

      <SettingsPanels
        loginEmail={email}
        settings={{
          timezone,
          digestEnabled: user?.digest_enabled ?? true,
          digestHour: user?.digest_hour ?? 8,
        }}
        gmail={{
          connected: gmail.connected,
          needsReconnect: gmail.needsReconnect,
          googleEmail: gmail.googleEmail,
          canReadMail: gmail.canReadMail,
          configured: googleConfigured(e),
        }}
        resendReady={Boolean(e.RESEND_API_KEY && e.RESEND_FROM)}
        scheduler={scheduler}
      />

      <SettingsCard
        title="Appearance"
        description="Light, dark, or follow this device. It is the same switch as in the account menu, and it sticks on every page."
      >
        <ThemeSwitch initial={theme} />
      </SettingsCard>

      <MessagesCard initial={messages.settings} initialSnippets={messages.snippets} />

      <SettingsCard
        title="Lead sources"
        description="Where new merchants come from: the Google Sheets that sync in, and your website, Zapier or a lead vendor."
        flush
      >
        <SettingRow
          label="Sheets and web lead connections"
          hint="New leads land in the bucket you pick, and the bucket follows up."
        >
          <LinkButton href="/settings/sheets" size="sm">
            Open lead sources
            <Icon d={ICON.arrowRight} className="size-3.5" />
          </LinkButton>
        </SettingRow>
      </SettingsCard>

      {/* exports are manager-only on the server: a rep is not shown buttons that can only fail */}
      {CAN.exportData(session.role) ? (
        <SettingsCard
          title="Your data"
          description="Everything you have put in, as files you can keep."
          aside={<StatusChip tone="info">Yours to keep</StatusChip>}
          flush
        >
          <BackupRow />
          {EXPORTS.map((x) => (
            <SettingRow key={x.href} label={x.title} hint={x.hint}>
              <a
                href={x.href}
                download
                aria-label={x.label}
                className={buttonClass("secondary", "sm")}
              >
                <Icon d={ICON.download} className="size-3.5" />
                Download
              </a>
            </SettingRow>
          ))}
        </SettingsCard>
      ) : null}

      <SecurityPanel />
    </SettingsPage>
  );
}
