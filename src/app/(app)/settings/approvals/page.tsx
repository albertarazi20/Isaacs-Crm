import type { Metadata } from "next";
import Link from "next/link";
import {
  emailName,
  hasDesign,
  listNames,
  type ApprovalEmailView,
} from "@/components/settings/approvalCadence";
import { ApprovalEmailsEditor } from "@/components/settings/ApprovalEmailsEditor";
import { StockDesignsPanel } from "@/components/approvals/StockDesignsPanel";
import { Note } from "@/components/settings/primitives";
import { SettingsPage } from "@/components/settings/SettingsNav";
import { getApprovalSettings, listApprovalEmails } from "@/lib/approvals/queries";
import { CAN } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { timeAgo } from "@/lib/format";
import { requestTimeMs } from "@/lib/server-time";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Approval emails" };

const LINK = "font-semibold underline underline-offset-2 hover:no-underline";

export default async function ApprovalEmailsSettingsPage() {
  const session = await requireRole(CAN.manageTeam);
  const { emails, settings } = await db.withUser(session.userId, async (q) => ({
    emails: await listApprovalEmails(q),
    settings: await getApprovalSettings(q),
  }));
  const now = new Date(requestTimeMs());
  const views: ApprovalEmailView[] = emails.map((e) => ({
    step: e.step,
    subject: e.subject,
    html: e.html,
    fileName: e.file_name,
    delayHours: e.delay_hours,
    updated:
      e.html.trim() === ""
        ? ""
        : `Updated ${timeAgo(e.updated_at, now)}${e.updated_by_name ? ` by ${e.updated_by_name}` : ""}`,
  }));
  const waiting = views.filter((e) => !hasDesign(e)).map((e) => emailName(e.step));

  const notices = [
    settings.postal_address.trim() === "" ? (
      <Note key="address" tone="warn" role="status">
        The shop has no postal address yet, and no automated email goes out without one. Add it on
        the{" "}
        <Link href="/settings/email" className={LINK}>
          Email page
        </Link>
        .
      </Note>
    ) : null,
    !settings.approval_emails_on ? (
      <Note key="off" tone="warn" role="status">
        Approval emails are switched off: nothing goes out until you{" "}
        <a href="#approval-when" className={LINK}>
          switch them back on
        </a>
        .
      </Note>
    ) : null,
    waiting.length > 0 ? (
      <Note key="designs" tone="warn" role="status">
        {listNames(waiting)} {waiting.length === 1 ? "has" : "have"} no design yet. Approvals wait
        at that email until it has one.
      </Note>
    ) : null,
  ].filter(Boolean);

  return (
    <SettingsPage
      role={session.role}
      current="/settings/approvals"
      title="Approval emails"
      description="When a funder approves a merchant, the rep sends the first email from their own mail and records it, then each follow-up goes on its own a set time after the previous email, only if the merchant has not replied. They stop when the merchant replies, a rep marks the approval pitched or closed, the merchant unsubscribes, or the hold date passes."
      notice={notices.length > 0 ? <div className="space-y-2">{notices}</div> : null}
    >
      <StockDesignsPanel
        slots={views.map((e) => ({
          step: e.step,
          html: e.html,
          subject: e.subject,
          delayHours: e.delayHours,
        }))}
      />
      <ApprovalEmailsEditor
        emails={views}
        sending={{
          on: settings.approval_emails_on,
          windowStart: settings.approval_window_start,
          windowEnd: settings.approval_window_end,
          weekends: settings.approval_weekends,
        }}
      />
    </SettingsPage>
  );
}
