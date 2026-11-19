"use client";

import { useState } from "react";
import { recordFirstEmailAction } from "@/app/approval-actions";
import type { ApprovalRow } from "@/lib/approvals/queries";
import { advanceWords, delayWords, type CadenceStep } from "@/lib/approvals/words";
import { Dialog, useCall, useToast } from "../overlay";
import { Button, Field, Input } from "../ui";

/** A date-time input's value for a moment, in the browser's own zone ("2026-11-18T14:30"). */
export const localInputValue = (d: Date): string =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** "Follow-up 1 goes 1 day after it" from the shop's cadence, or "" when there is no follow-up. */
export function followUpHint(cadence: readonly CadenceStep[]): string {
  const next = cadence.find((s) => s.step === 2);
  return next
    ? `Follow-up 1 goes ${delayWords(next.delay_hours)} after that, then the rest carry on by themselves.`
    : "There are no follow-ups set up.";
}

/** An approval created with the emails held, where the rep has since sent the first email themselves. */
export const canRecordFirst = (row: Pick<ApprovalRow, "status" | "emails" | "emails_note">) =>
  row.status === "open" && row.emails === "paused" && row.emails_note === "held";

/**
 * "I sent the first email": the rep tells the CRM when they sent it from their own mail. Nothing is sent; the
 * first email is recorded as gone at that time and the follow-ups start on their own.
 */
export function RecordFirstEmailDialog({
  approval,
  cadence,
  fmt,
  onClose,
}: {
  approval: { id: string; name: string };
  cadence: readonly CadenceStep[];
  fmt: (iso: string) => string;
  onClose: () => void;
}) {
  const call = useCall();
  const toast = useToast();
  const [now] = useState(() => new Date());
  const [when, setWhen] = useState(() => localInputValue(now));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const at = new Date(when);
    const res = await call(
      recordFirstEmailAction({
        approvalId: approval.id,
        sentAt: Number.isNaN(at.getTime()) ? null : at.toISOString(),
      }),
    );
    setBusy(false);
    if (!res) return;
    toast({
      message: `First email recorded. ${advanceWords(res.next, fmt)}`,
      tone: "success",
    });
    onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`I sent the first email: ${approval.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !when} onClick={() => void save()}>
            {busy ? "Saving…" : "Record it"}
          </Button>
        </>
      }
    >
      <p className="text-sm text-text-2">
        Nothing is sent now. The first email counts as gone at the time you say, and the follow-ups
        start from there. {followUpHint(cadence)}
      </p>
      <div className="mt-4">
        <Field label="When did you send it?">
          <Input
            type="datetime-local"
            value={when}
            max={localInputValue(now)}
            onChange={(e) => setWhen(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}
