"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { setSubmissionStatusAction } from "@/app/funders-actions";
import { chaseLenderAction } from "@/app/inbox-actions";
import { DeclineDialog, StipsDialog } from "@/components/funders/SubmissionDialogs";
import { useRun } from "@/components/client/parts";
import { cn } from "@/components/ui";
import type { BoardSubmission } from "@/lib/deals/queries";
import type { SubmissionRow } from "@/lib/funders/types";

const TONE: Record<string, string> = {
  sent: "border-border text-muted",
  stips_requested: "border-warn/40 bg-warn-soft text-warn",
  approved: "border-good/40 bg-good-soft text-good",
  revised: "border-good/40 bg-good-soft text-good",
  contracts_out: "border-accent/40 bg-accent-soft text-accent",
  contracts_in: "border-accent/40 bg-accent-soft text-accent",
  funding_call: "border-accent/40 bg-accent-soft text-accent",
  funded: "border-good/40 bg-good-soft text-good",
  declined: "border-bad/40 bg-bad-soft text-bad",
  no_response: "border-border text-muted",
  withdrawn: "border-border text-muted",
  expired: "border-border text-muted",
};

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

/** One lender on one deal: the status as a chip with a dropdown behind it (the plan's per-lender dropdown). */
export function LenderChip({ s, canEdit }: { s: BoardSubmission; canEdit: boolean }) {
  const run = useRun();
  const router = useRouter();
  const [dialog, setDialog] = useState<"decline" | "stips" | null>(null);
  const [busy, setBusy] = useState(false);
  const label = s.status.replace(/_/g, " ");
  const title = `${s.funder_name}: ${label} · sent ${s.sent_on}${s.responded_on ? ` · answered ${s.responded_on}` : ""}${s.chase_count ? ` · chased ${s.chase_count}×` : ""}${s.source === "email" ? " · read from email" : ""}`;

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
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
        TONE[s.status] ?? "border-border",
      )}
      title={title}
    >
      <span className="font-semibold">{s.funder_name}</span>
      {canEdit ? (
        <select
          aria-label={`${s.funder_name} status`}
          value={CHOICES.some((c) => c.value === s.status) ? s.status : "sent"}
          disabled={busy}
          onChange={(e) => void change(e.target.value)}
          className="cursor-pointer bg-transparent text-xs text-current outline-none"
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
      ) : (
        <span>{label}</span>
      )}
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
          className="rounded px-1 text-[11px] text-muted hover:text-text"
        >
          chase
        </button>
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
    </span>
  );
}
