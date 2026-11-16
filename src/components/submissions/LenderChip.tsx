"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { setSubmissionStatusAction } from "@/app/funders-actions";
import { chaseLenderAction } from "@/app/inbox-actions";
import { useApp } from "@/components/app-context";
import { Icon, SUB_TONE, TONE_CLASS } from "@/components/deals/primitives";
import { DeclineDialog, StipsDialog } from "@/components/funders/SubmissionDialogs";
import { useRun } from "@/components/client/parts";
import { Badge, cn } from "@/components/ui";
import type { BoardSubmission } from "@/lib/deals/queries";
import { formatDate } from "@/lib/format";
import { DECLINE_REASON_LABELS, type DeclineReason, type SubmissionRow } from "@/lib/funders/types";
import { diffDays } from "@/lib/mca/dates";

const CHOICES: { value: string; label: string }[] = [
  { value: "sent", label: "Sent" },
  { value: "stips_requested", label: "Stips requested…" },
  { value: "approved", label: "Approved" },
  { value: "declined", label: "Declined…" },
  { value: "no_response", label: "No response" },
  { value: "withdrawn", label: "Withdrawn" },
];

const asRow = (s: BoardSubmission): SubmissionRow =>
  ({
    id: s.id,
    client_id: s.client_id,
    funder_id: s.funder_id,
    funder_name: s.funder_name,
    sent_on: s.sent_on,
    status: s.status,
    decline_reason: s.decline_reason,
    decline_note: s.decline_note,
    note: s.note,
    status_changed_at: s.status_changed_at,
    responded_on: s.responded_on,
    chase_due_on: null,
    offers: [],
  }) as unknown as SubmissionRow;

/** "3d" since the lender got the file; "today" on the day it went out. */
function age(sentOn: string, today: string): string {
  const d = diffDays(sentOn, today);
  return d <= 0 ? "today" : `${d}d`;
}

/** The decline reason in words, with the note the lender gave. */
function reasonText(s: BoardSubmission): string {
  if (s.status === "declined") {
    const label = s.decline_reason
      ? (DECLINE_REASON_LABELS[s.decline_reason as DeclineReason] ??
        s.decline_reason.replace(/_/g, " "))
      : "";
    return [label, s.decline_note].filter(Boolean).join(" — ");
  }
  return s.note;
}

/**
 * One lender on one deal, as a row on the Submission Board: the status as a badge (a dropdown behind it for
 * ops, the plan's per-lender dropdown), when it went out and how long ago, when they answered, and the
 * decline reason or the note in words.
 */
export function LenderChip({ s, canEdit }: { s: BoardSubmission; canEdit: boolean }) {
  const { today } = useApp();
  const run = useRun();
  const router = useRouter();
  const [dialog, setDialog] = useState<"decline" | "stips" | null>(null);
  const [busy, setBusy] = useState(false);
  const label = s.status.replace(/_/g, " ");
  const title = `${s.funder_name}: ${label} · sent ${s.sent_on}${s.responded_on ? ` · answered ${s.responded_on}` : ""}${s.chase_count ? ` · chased ${s.chase_count}×` : ""}${s.source === "email" ? " · read from email" : ""}`;
  const tone = SUB_TONE[s.status] ?? "neutral";
  const words = reasonText(s);
  const meta = [
    `sent ${formatDate(s.sent_on, today)} · ${age(s.sent_on, today)}`,
    s.responded_on ? `answered ${formatDate(s.responded_on, today)}` : null,
    s.chase_count ? `chased ${s.chase_count}×` : null,
    s.source === "email" ? "read from email" : null,
  ].filter(Boolean);

  async function change(value: string) {
    if (value === s.status) return;
    if (value === "declined") return setDialog("decline");
    if (value === "stips_requested") return setDialog("stips");
    setBusy(true);
    const ok = await run(
      setSubmissionStatusAction({ submissionId: s.id, status: value, note: "" }),
      `${s.funder_name}: ${value.replace(/_/g, " ")}`,
    );
    setBusy(false);
    if (ok) router.refresh();
  }

  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px] sm:px-4 sm:py-1.5"
      title={title}
    >
      <span className="min-w-0 flex-1 basis-40 truncate font-medium">{s.funder_name}</span>
      {canEdit ? (
        <span className={cn("relative inline-flex items-center rounded-md", TONE_CLASS[tone])}>
          <select
            aria-label={`${s.funder_name} status`}
            value={CHOICES.some((c) => c.value === s.status) ? s.status : "sent"}
            disabled={busy}
            onChange={(e) => void change(e.target.value)}
            className="h-9 cursor-pointer appearance-none bg-transparent pr-6 pl-2 text-[11px] font-semibold text-current outline-none disabled:cursor-wait disabled:opacity-60 sm:h-6"
          >
            {!CHOICES.some((c) => c.value === s.status) ? (
              <option value="sent">{label}</option>
            ) : null}
            {CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" className="pointer-events-none absolute right-1.5 size-3" />
        </span>
      ) : (
        <Badge tone={tone}>{label}</Badge>
      )}
      <span className="text-xs text-muted tabular-nums">{meta.join(" · ")}</span>
      {canEdit && s.status === "sent" ? (
        <button
          type="button"
          disabled={busy}
          title="Nudge the lender on the same thread"
          onClick={async () => {
            setBusy(true);
            const ok = await run(
              chaseLenderAction({ submissionId: s.id }),
              `Chased ${s.funder_name}`,
            );
            setBusy(false);
            if (ok) router.refresh();
          }}
          className="inline-flex h-9 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted transition hover:bg-surface-2 hover:text-text disabled:opacity-50 sm:h-7"
        >
          <Icon name="send" className="size-3.5" />
          chase
        </button>
      ) : null}
      {words ? (
        <span
          className={cn("basis-full text-xs", s.status === "declined" ? "text-bad" : "text-text-2")}
        >
          {words}
        </span>
      ) : null}
      {dialog === "decline" ? (
        <DeclineDialog
          sub={asRow(s)}
          onClose={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      ) : null}
      {dialog === "stips" ? (
        <StipsDialog
          sub={asRow(s)}
          onClose={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      ) : null}
    </li>
  );
}
