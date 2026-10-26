"use client";

import { useState, type FormEvent } from "react";
import { setFollowUpAction } from "@/app/actions";
import { snoozeWithReasonAction } from "@/app/power-actions";
import { snoozeNeedsReason } from "@/lib/data/priority";
import type { ClientCard } from "@/lib/data/types";
import { formatDate, relativeDay } from "@/lib/format";
import { addDays, addMonths, type ISODate } from "@/lib/mca/dates";
import { stageDef } from "@/lib/mca/stages";
import { useApp } from "../app-context";
import { useCall } from "../overlay";
import { Button, cn, Input } from "../ui";

export const SNOOZES: { label: string; to: (today: ISODate) => ISODate }[] = [
  { label: "Tomorrow", to: (t) => addDays(t, 1) },
  { label: "3 days", to: (t) => addDays(t, 3) },
  { label: "1 week", to: (t) => addDays(t, 7) },
  { label: "2 weeks", to: (t) => addDays(t, 14) },
  { label: "1 month", to: (t) => addMonths(t, 1) },
  { label: "3 months", to: (t) => addMonths(t, 3) },
  { label: "6 months", to: (t) => addMonths(t, 6) },
  { label: "12 months", to: (t) => addMonths(t, 12) },
];

type Target = Pick<ClientCard, "id" | "business_name" | "stage">;
interface Pending {
  label: string;
  dueOn: ISODate;
}

/**
 * Snooze presets with a guard: pushing a live underwriting deal (Application in ... Contract out) out past a
 * week asks for a one-line reason, saved as a note with the new date. It never blocks: a blank reason still snoozes.
 */
function useSnooze(card: Target, onDone: () => void) {
  const { today } = useApp();
  const call = useCall();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  async function apply(dueOn: ISODate, reason: string) {
    setBusy(true);
    const input = { clientId: card.id, dueOn, reason };
    await call(
      reason ? snoozeWithReasonAction(input) : setFollowUpAction({ clientId: card.id, dueOn }),
      `${card.business_name} — snoozed until ${formatDate(dueOn, today)}`,
    );
    setBusy(false);
    setPending(null);
    onDone();
  }

  function choose(p: { label: string; to: (t: ISODate) => ISODate }) {
    const dueOn = p.to(today);
    if (snoozeNeedsReason(card.stage, today, dueOn)) {
      setPending({ label: p.label, dueOn });
      return;
    }
    void apply(dueOn, "");
  }

  return { pending, setPending, busy, apply, choose };
}

function ReasonForm({
  card,
  pending,
  busy,
  onSubmit,
  onBack,
}: {
  card: Target;
  pending: Pending;
  busy: boolean;
  onSubmit: (reason: string) => void;
  onBack: () => void;
}) {
  const { today } = useApp();
  const [reason, setReason] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(reason.trim());
  };
  return (
    <form onSubmit={submit} aria-label="Why snooze this deal" className="space-y-2 p-2">
      <p className="text-sm">
        <span className="font-semibold">{stageDef(card.stage).label}</span> is a live deal, and{" "}
        {pending.label} puts it off until {formatDate(pending.dueOn, today)} (
        {relativeDay(pending.dueOn, today)}). Why?
      </p>
      <Input
        aria-label="Reason for snoozing (one line)"
        placeholder="One line, e.g. waiting on tax returns until the 3rd"
        maxLength={300}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        autoFocus
      />
      <p className="text-xs text-muted">Saved as a note on the timeline. You can leave it blank.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Saving…" : `Snooze until ${formatDate(pending.dueOn, today)}`}
        </Button>
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
      </div>
    </form>
  );
}

/** The dropdown on a row. */
export function SnoozeMenu({ card }: { card: Target }) {
  const [open, setOpen] = useState(false);
  const { pending, setPending, busy, apply, choose } = useSnooze(card, () => setOpen(false));
  return (
    <details
      open={open}
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
        if (!e.currentTarget.open) setPending(null);
      }}
      className="relative"
    >
      <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-lg px-2.5 text-sm font-medium text-muted hover:bg-surface-2 hover:text-text">
        Snooze ▾
      </summary>
      <div
        className={cn(
          "absolute right-0 z-20 mt-1 rounded-xl border border-border bg-surface p-1 shadow-xl",
          pending ? "w-72" : "grid w-44 gap-0.5",
        )}
      >
        {pending ? (
          <ReasonForm
            card={card}
            pending={pending}
            busy={busy}
            onSubmit={(reason) => void apply(pending.dueOn, reason)}
            onBack={() => setPending(null)}
          />
        ) : (
          SNOOZES.map((s) => (
            <button
              key={s.label}
              type="button"
              className="rounded-lg px-3 py-1.5 text-left text-sm hover:bg-surface-2"
              onClick={() => choose(s)}
            >
              {s.label}
            </button>
          ))
        )}
      </div>
    </details>
  );
}

/** Big touch-friendly presets for power-dial mode. */
export function SnoozeButtons({ card, count = 5 }: { card: Target; count?: number }) {
  const { pending, setPending, busy, apply, choose } = useSnooze(card, () => undefined);
  if (pending) {
    return (
      <div className="rounded-xl border border-border bg-surface-2">
        <ReasonForm
          card={card}
          pending={pending}
          busy={busy}
          onSubmit={(reason) => void apply(pending.dueOn, reason)}
          onBack={() => setPending(null)}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Snooze">
      {SNOOZES.slice(0, count).map((s) => (
        <button
          key={s.label}
          type="button"
          disabled={busy}
          onClick={() => choose(s)}
          className="h-12 min-w-24 flex-1 rounded-xl border border-border bg-surface px-3 text-sm font-medium transition hover:bg-surface-2 disabled:opacity-50"
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
