"use client";

import { useState } from "react";
import { stopEmailsAction, turnEmailsBackOnAction } from "@/app/approval-actions";
import type { EmailsStopped } from "@/lib/approvals/hardStop";
import { formatDate } from "@/lib/format";
import { useApp } from "../app-context";
import { dateInTz } from "../client/logic";
import { Dialog, useCall, useToast } from "../overlay";
import { Badge, Button } from "../ui";

/**
 * An open approval whose emails a person stopped for good (the database sets the note 'manual_stop'). It cannot be
 * resumed from the row: a manager turns the emails back on first, which changes the note.
 */
export const isHandStopped = (row: { emails: string; emails_note: string }): boolean =>
  row.emails === "stopped" && row.emails_note === "manual_stop";

/** What the merchant's page knows about a hard stop: the state, and whether this person can undo it. */
export interface EmailsStopView {
  stopped: EmailsStopped | null;
  /** Managers turn the emails back on; a rep sees the state only. */
  canTurnOn: boolean;
}

/**
 * "Stop all automated emails to X?" The confirm for the hard stop, from an Open approvals row and from the merchant's
 * page. The words are the owner's: they say exactly what stops and who can undo it.
 */
export function StopEmailsDialog({
  merchant,
  onClose,
  onDone,
}: {
  merchant: { id: string; name: string };
  onClose: () => void;
  onDone?: () => void;
}) {
  const call = useCall();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function stop() {
    setBusy(true);
    const res = await call(stopEmailsAction({ clientId: merchant.id }));
    setBusy(false);
    if (!res) return;
    toast({
      message: res.already
        ? `${merchant.name}: the emails were already stopped.`
        : res.wasOptedOut
          ? `${merchant.name} had already unsubscribed: no emails go to them.`
          : `${merchant.name}: emails stopped for good.${
              res.cancelled > 0
                ? ` ${res.cancelled} queued email${res.cancelled === 1 ? "" : "s"} taken back.`
                : ""
            }`,
      tone: "success",
    });
    onDone?.();
    onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Stop emails for good"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void stop()}>
            {busy ? "Stopping…" : "Stop emails for good"}
          </Button>
        </>
      }
    >
      <p className="text-sm text-text">
        Stop all automated emails to {merchant.name}? They will get no more follow-ups, sequences or
        nudges. A manager can turn them back on in Settings.
      </p>
      <p className="mt-3 text-xs text-muted">
        Emails already sent stay as they are. You can still write to them yourself from your own
        mail.
      </p>
    </Dialog>
  );
}

/** The small badge on the merchant's page when the emails are stopped. */
export function EmailsStoppedBadge({ stopped }: { stopped: EmailsStopped }) {
  const { timezone, today } = useApp();
  const day = formatDate(dateInTz(stopped.at, timezone), today);
  return (
    <Badge tone="bad" className="cursor-help">
      <span
        title={`Stopped${stopped.by ? ` by ${stopped.by}` : ""} on ${day}. No automated emails go to this merchant: no approval emails, follow-ups, sequences or nudges. Emails you write yourself from your own mail are not affected.`}
      >
        Emails stopped
      </span>
    </Badge>
  );
}

/**
 * The control that goes with the badge: "Stop emails for good" while they are going, and for a manager "Turn emails
 * back on" once stopped. A rep sees nothing to press on a stopped merchant (the badge says why).
 */
export function EmailsStopControl({
  merchant,
  view,
}: {
  merchant: { id: string; name: string };
  view: EmailsStopView;
}) {
  const call = useCall();
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);

  if (view.stopped) {
    if (!view.canTurnOn) return null;
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await call(
            turnEmailsBackOnAction({ clientId: merchant.id }),
            `Emails to ${merchant.name} are back on. Nothing restarts until you start it`,
          );
          setBusy(false);
        }}
      >
        Turn emails back on
      </Button>
    );
  }
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="hover:bg-bad-soft hover:text-bad"
        onClick={() => setDialog(true)}
      >
        Stop emails for good
      </Button>
      {dialog ? <StopEmailsDialog merchant={merchant} onClose={() => setDialog(false)} /> : null}
    </>
  );
}
