"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "@/components/app-context";
import { Dialog } from "@/components/overlay";
import { TimerPicker } from "@/components/TimerPicker";
import { Button, cn, Input } from "@/components/ui";
import type { ClientCard } from "@/lib/data/types";
import { addDays, type ISODate } from "@/lib/mca/dates";
import { callTimeProblem, clampToToday } from "./forms";

/** Resolves true when the move went through, so the dialog can close; false keeps it open. */
export type Submit = (extra: Record<string, unknown>) => Promise<boolean>;

interface DialogProps {
  card: ClientCard;
  onSubmit: Submit;
  onCancel: () => void;
}

function Row({
  label,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  error?: string | undefined;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block space-y-1", className)}>
      <span className="text-[12px] font-medium text-text-2">{label}</span>
      {children}
      {error ? (
        <span className="block text-xs text-bad">{error}</span>
      ) : hint ? (
        <span className="block text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

/** The dialog is mounted closed, so focus has to wait until showModal() has run. */
function useFocusFirst() {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => ref.current?.querySelector("input")?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  return ref;
}

function useBusy(onSubmit: Submit) {
  const [busy, setBusy] = useState(false);
  async function send(extra: Record<string, unknown>) {
    setBusy(true);
    const ok = await onSubmit(extra);
    // On success the parent unmounts this dialog, so only a failure needs the form back.
    if (!ok) setBusy(false);
  }
  return { busy, send };
}

// ---- phone call scheduled ------------------------------------------------------------------

/** Dragging a card onto "Phone call scheduled" asks when the call is; otherwise nothing would ever remind him. */
export function CallDialog({ card, onSubmit, onCancel }: DialogProps) {
  const { today, timezone } = useApp();
  const first = useFocusFirst();
  const { busy, send } = useBusy(onSubmit);
  const [at, setAt] = useState(() => `${addDays(today, 1)}T10:00`);
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const problem = callTimeProblem(at, today);

  function submit() {
    setTried(true);
    if (problem) return;
    void send({ callAt: at, reason: note.trim() });
  }

  return (
    <Dialog
      open
      onClose={() => !busy && onCancel()}
      title={`${card.business_name}: when is the call?`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void send({})}>
            Move without a time
          </Button>
          <Button variant="primary" type="submit" form="call-form" disabled={busy}>
            {busy ? "Booking…" : "Book the call"}
          </Button>
        </>
      }
    >
      <form
        ref={first}
        id="call-form"
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="text-sm text-muted">
          With a time booked you get the reminder, and the call shows on Today at that time.
        </p>
        <Row label={`When (${timezone.replace("_", " ")})`} error={tried ? problem : undefined}>
          <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </Row>
        <Row label="What it's about" hint="Optional">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Get statements, go over the application…"
          />
        </Row>
      </form>
    </Dialog>
  );
}

// ---- change the follow-up date --------------------------------------------------------------

export function ChangeFollowUpDialog({
  card,
  onSave,
  onCancel,
}: {
  card: ClientCard;
  onSave: (dueOn: ISODate) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { today } = useApp();
  const [due, setDue] = useState<ISODate>(() => clampToToday(card.next_due_on ?? today, today));
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={() => !busy && onCancel()}
      title={`Follow up with ${card.business_name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onSave(due).then((ok) => !ok && setBusy(false));
            }}
          >
            {busy ? "Saving…" : "Set follow-up"}
          </Button>
        </>
      }
    >
      <TimerPicker value={due} onChange={setDue} today={today} />
    </Dialog>
  );
}
