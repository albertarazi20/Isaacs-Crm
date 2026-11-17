"use client";

import { useState, type FormEvent } from "react";
import { scheduleCallAction, setFollowUpAction } from "@/app/actions";
import { snoozeWithReasonAction } from "@/app/power-actions";
import { snoozeNeedsReason } from "@/lib/data/priority";
import type { ClientCard } from "@/lib/data/types";
import { formatDate, relativeDay } from "@/lib/format";
import { callbackAt, callbackLabel, CALLBACK_HOURS, slotAt } from "@/lib/mca/callback";
import { CHANNEL_LABEL, REMINDER_CHANNELS, type ReminderChannel } from "@/lib/mca/reminder";
import { addDays, addMonths, type ISODate } from "@/lib/mca/dates";
import { stageDef } from "@/lib/mca/stages";
import { useApp } from "../app-context";
import { TimeSelect } from "../TimeSelect";
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

/** One line of the snooze menu: a 40px row on a phone, 32px on a desktop. */
const MENU_ITEM =
  "flex min-h-10 items-center rounded-lg px-2 text-left text-sm transition hover:bg-surface-2 disabled:opacity-50 sm:min-h-8 sm:text-[13px]";
interface Pending {
  label: string;
  dueOn: ISODate;
}

/**
 * Snooze presets with a guard: pushing a merchant whose application is in out past a
 * week asks for a one-line reason, saved as a note with the new date. It never blocks: a blank reason still snoozes.
 */
function useSnooze(card: Target, onDone: () => void) {
  const { today, timezone } = useApp();
  const call = useCall();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState<ReminderChannel>("call");

  /** "Text him in 3 hours": sets a reminder for that time, so the card flags it and the system nudges him. */
  async function callBack(hours: number) {
    setBusy(true);
    await call(
      scheduleCallAction({
        clientId: card.id,
        at: callbackAt(timezone, hours, Date.now()),
        note: `${CHANNEL_LABEL[channel]} back`,
        channel,
      }),
      `${card.business_name} — ${CHANNEL_LABEL[channel].toLowerCase()} reminder in ${callbackLabel(hours)}`,
    );
    setBusy(false);
    onDone();
  }

  /** "Text him at 5:30 PM": the same reminder, at an exact half hour of a chosen day. */
  async function callAt(date: ISODate, time: string) {
    setBusy(true);
    await call(
      scheduleCallAction({
        clientId: card.id,
        at: slotAt(date, time),
        note: `${CHANNEL_LABEL[channel]} back`,
        channel,
      }),
      `${card.business_name} — ${CHANNEL_LABEL[channel].toLowerCase()} reminder set`,
    );
    setBusy(false);
    onDone();
  }

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

  return { pending, setPending, busy, apply, choose, callBack, callAt, channel, setChannel };
}

/** Call, text or email: what the reminder is for. */
export function ChannelPick({
  channel,
  onChange,
}: {
  channel: ReminderChannel;
  onChange: (c: ReminderChannel) => void;
}) {
  return (
    <div
      className="flex gap-0.5 rounded-lg border border-border bg-surface p-0.5"
      role="group"
      aria-label="Remind me to"
    >
      {REMINDER_CHANNELS.map((c) => (
        <button
          key={c}
          type="button"
          aria-pressed={c === channel}
          onClick={() => onChange(c)}
          className={cn(
            "h-9 flex-1 rounded-md px-2 text-xs font-semibold transition sm:h-7",
            c === channel ? "bg-text text-bg" : "text-muted hover:bg-surface-2 hover:text-text",
          )}
        >
          {CHANNEL_LABEL[c]}
        </button>
      ))}
    </div>
  );
}

/** A day and a half-hour time of day (New York time), for when "in 2 hours" is not the time he wants. */
export function PickTime({
  busy,
  onPick,
}: {
  busy: boolean;
  onPick: (date: ISODate, time: string) => void;
}) {
  const { today } = useApp();
  const [date, setDate] = useState<ISODate>(today);
  const [time, setTime] = useState("");
  return (
    <div className="space-y-1.5 px-1 pb-1">
      <Input
        type="date"
        aria-label="Reminder day"
        value={date}
        min={today}
        onChange={(e) => {
          if (!e.target.value) return;
          setDate(e.target.value);
          setTime("");
        }}
      />
      <TimeSelect value={time} onChange={setTime} date={date} />
      <Button
        variant="primary"
        size="sm"
        className="w-full"
        disabled={busy || !time}
        onClick={() => onPick(date, time)}
      >
        Set reminder
      </Button>
    </div>
  );
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
    <form onSubmit={submit} aria-label="Why snooze this merchant" className="space-y-2 p-3">
      <p className="text-sm">
        <span className="font-semibold">{stageDef(card.stage).label}</span> has the application in,
        and {pending.label} puts it off until {formatDate(pending.dueOn, today)} (
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
  const { pending, setPending, busy, apply, choose, callBack, callAt, channel, setChannel } =
    useSnooze(card, () => setOpen(false));
  return (
    <details
      open={open}
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
        if (!e.currentTarget.open) setPending(null);
      }}
      className="relative"
    >
      <summary className="inline-flex h-10 cursor-pointer list-none items-center rounded-lg px-2.5 text-[13px] font-medium whitespace-nowrap text-muted transition select-none hover:bg-surface-2 hover:text-text sm:h-8 [&::-webkit-details-marker]:hidden">
        Snooze ▾
      </summary>
      <div
        className={cn(
          "absolute right-0 z-20 mt-1 rounded-xl border border-border bg-surface p-1 shadow-pop",
          pending ? "w-72" : "grid max-h-[70vh] w-48 gap-0.5 overflow-y-auto",
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
          <>
            <p className="px-2 pt-1.5 pb-1 text-[11px] font-semibold text-muted">Remind me in</p>
            <ChannelPick channel={channel} onChange={setChannel} />
            {CALLBACK_HOURS.map((h) => (
              <button
                key={h}
                type="button"
                disabled={busy}
                className={MENU_ITEM}
                onClick={() => void callBack(h)}
              >
                {callbackLabel(h)}
              </button>
            ))}
            <p className="px-2 pt-2 pb-1 text-[11px] font-semibold text-muted">Or at a time</p>
            <PickTime busy={busy} onPick={(d, t) => void callAt(d, t)} />
            <p className="px-2 pt-2 pb-1 text-[11px] font-semibold text-muted">Snooze until</p>
            {SNOOZES.map((s) => (
              <button key={s.label} type="button" className={MENU_ITEM} onClick={() => choose(s)}>
                {s.label}
              </button>
            ))}
          </>
        )}
      </div>
    </details>
  );
}

/** Big touch-friendly presets for power-dial mode. */
export function SnoozeButtons({ card, count = 5 }: { card: Target; count?: number }) {
  const { pending, setPending, busy, apply, choose, callBack, callAt, channel, setChannel } =
    useSnooze(card, () => undefined);
  if (pending) {
    return (
      <div className="rounded-xl border border-border bg-surface">
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
      <div className="w-full">
        <ChannelPick channel={channel} onChange={setChannel} />
      </div>
      {CALLBACK_HOURS.slice(2, 4).map((h) => (
        <button
          key={`cb${h}`}
          type="button"
          disabled={busy}
          onClick={() => void callBack(h)}
          className="h-12 min-w-24 flex-1 rounded-lg border border-accent/30 bg-accent-soft px-3 text-sm font-semibold text-accent transition hover:brightness-95 disabled:opacity-50"
        >
          In {callbackLabel(h)}
        </button>
      ))}
      <div className="w-full rounded-lg border border-border bg-surface p-2">
        <PickTime busy={busy} onPick={(d, t) => void callAt(d, t)} />
      </div>
      {SNOOZES.slice(0, count).map((s) => (
        <button
          key={s.label}
          type="button"
          disabled={busy}
          onClick={() => choose(s)}
          className="h-12 min-w-24 flex-1 rounded-lg border border-border bg-surface px-3 text-sm font-medium transition hover:border-border-strong hover:bg-surface-3 disabled:opacity-50"
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
