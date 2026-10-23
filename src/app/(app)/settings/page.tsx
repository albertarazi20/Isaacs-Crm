import { SettingsPanels } from "@/components/SettingsPanels";
import { requireSession } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { env, googleConfigured } from "@/lib/env";
import { gmailStatus } from "@/lib/system/gmail";

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
  const e = env();
  const key = sp.gmail ?? sp.error ?? "";
  const notice = Object.hasOwn(NOTICES, key) ? NOTICES[key] : undefined;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      {notice ? (
        <p
          role="status"
          className={`rounded-lg p-3 text-sm ${notice.tone === "good" ? "bg-good-soft text-good" : "bg-bad-soft text-bad"}`}
        >
          {notice.text}
        </p>
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
    </div>
  );
}
