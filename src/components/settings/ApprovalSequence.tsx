"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import {
  addApprovalStepAction,
  removeApprovalStepAction,
  setApprovalDelayAction,
} from "@/app/approval-actions";
import { Dialog, useCall, useToast } from "../overlay";
import { Button, cn, Input, Select } from "../ui";
import {
  cadence,
  cadenceSummary,
  emailName,
  emailTitle,
  formatHours,
  gapToHours,
  hasDesign,
  lastEmailSentence,
  MAX_APPROVAL_EMAILS,
  sinceApproval,
  splitHours,
  type ApprovalEmailView,
  type GapUnit,
} from "./approvalCadence";
import { ICON, Icon, SettingsCard, StatusChip } from "./primitives";

/** The wait before one follow-up: a number and hours/days, saved on its own. */
function GapEditor({ step, hours }: { step: number; hours: number }) {
  const call = useCall();
  const toast = useToast();
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(() => String(splitHours(hours).value));
  const [unit, setUnit] = useState<GapUnit>(() => splitHours(hours).unit);
  const [saved, setSaved] = useState(hours);
  const [busy, setBusy] = useState(false);
  const parsed = gapToHours(value, unit);
  const error = "error" in parsed ? parsed.error : null;
  const changed = "hours" in parsed ? parsed.hours !== saved : value.trim() !== "";
  const name = emailName(step);

  async function save() {
    if (!("hours" in parsed) || !changed) return;
    const next = parsed.hours;
    setBusy(true);
    const ok = await call(
      setApprovalDelayAction({ step, hours: next }).then((r) =>
        r.ok ? { ok: true as const, data: true } : r,
      ),
    );
    setBusy(false);
    if (!ok) return;
    setSaved(next);
    toast({
      message: `${name} now goes ${formatHours(next)} after ${emailName(step - 1)}`,
      tone: "success",
    });
    router.refresh();
  }

  return (
    <form
      noValidate
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor={`${id}-n`} className="sr-only">
        Wait before {name}
      </label>
      <span className="block w-16">
        <Input
          id={`${id}-n`}
          inputMode="numeric"
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => setValue(e.target.value)}
          className="px-2 text-center font-semibold tabular-nums sm:h-8 sm:text-[13px]"
        />
      </span>
      <label htmlFor={`${id}-u`} className="sr-only">
        Unit for the wait before {name}
      </label>
      <span className="block w-24">
        <Select
          id={`${id}-u`}
          value={unit}
          onChange={(e) => {
            const next = e.target.value as GapUnit;
            // switching units keeps the same wait when it can: 2 days becomes 48 hours, 48 hours becomes 2 days
            const n = Number(value.trim());
            if (/^\d+$/.test(value.trim())) {
              if (unit === "days" && next === "hours") setValue(String(n * 24));
              if (unit === "hours" && next === "days" && n % 24 === 0) setValue(String(n / 24));
            }
            setUnit(next);
          }}
          className="sm:h-8 sm:text-[13px]"
        >
          <option value="hours">{value.trim() === "1" ? "hour" : "hours"}</option>
          <option value="days">{value.trim() === "1" ? "day" : "days"}</option>
        </Select>
      </span>
      <span className="text-[13px] text-muted">later</span>
      {changed && !error ? (
        <Button type="submit" size="sm" variant="primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      ) : null}
      {error ? (
        <span id={`${id}-err`} role="alert" className="text-xs font-medium text-bad">
          {error}
        </span>
      ) : null}
    </form>
  );
}

/**
 * The sequence as a line: Email 1 right away, then each follow-up after its wait, with the total at the bottom.
 * Each wait saves on its own; a follow-up is added to or taken off the end.
 */
export function ApprovalSequence({
  emails,
  onAdded,
}: {
  emails: ApprovalEmailView[];
  /** A follow-up was added (its step), so the page can bring its card into view once it is drawn. */
  onAdded: (step: number) => void;
}) {
  const call = useCall();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<"add" | "remove" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const steps = emails.map((e) => ({ step: e.step, delay_hours: e.delayHours }));
  const points = cadence(steps);
  const byStep = new Map(emails.map((e) => [e.step, e]));
  const last = emails[emails.length - 1];
  const full = emails.length >= MAX_APPROVAL_EMAILS;

  async function add() {
    setBusy("add");
    const res = await call(addApprovalStepAction());
    setBusy(null);
    if (!res) return;
    toast({
      message: `${emailName(res.step)} added. Give it a design below.`,
      tone: "success",
    });
    onAdded(res.step);
    router.refresh();
  }

  async function remove() {
    if (!last) return;
    setBusy("remove");
    const ok = await call(
      removeApprovalStepAction().then((r) => (r.ok ? { ok: true as const, data: true } : r)),
    );
    setBusy(null);
    setConfirmRemove(false);
    if (!ok) return;
    toast({ message: `${emailName(last.step)} removed`, tone: "success" });
    router.refresh();
  }

  return (
    <SettingsCard
      title="The sequence"
      description="Email 1 goes when an approval is marked. Each follow-up waits the time you set after the one before it actually went out, so a late send never bunches them up."
      aside={<StatusChip tone="accent">{cadenceSummary(steps)}</StatusChip>}
      footer={
        <>
          <span className="mr-auto text-xs text-muted">
            {full
              ? "Six emails is the most an approval gets."
              : `Up to ${MAX_APPROVAL_EMAILS} emails.`}
          </span>
          {emails.length > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirmRemove(true)}
            >
              Remove the last follow-up
            </Button>
          ) : null}
          <Button size="sm" disabled={full || busy !== null} onClick={() => void add()}>
            <Icon d={ICON.plus} className="size-3.5" />
            {busy === "add" ? "Adding…" : "Add a follow-up"}
          </Button>
        </>
      }
    >
      <ol aria-label="When each email goes">
        {points.map((p, i) => {
          const e = byStep.get(p.step);
          const ready = e ? hasDesign(e) : false;
          const isLast = i === points.length - 1;
          return (
            <li key={p.step} className="relative">
              {i > 0 ? (
                <div className="relative flex min-h-12 items-center py-1.5 pl-12">
                  <span
                    aria-hidden
                    className="absolute top-0 bottom-0 left-[17.5px] w-px bg-border-strong/70"
                  />
                  <span
                    aria-hidden
                    className="absolute top-1/2 left-[13.5px] size-2 -translate-y-1/2 rounded-full border border-border-strong bg-surface"
                  />
                  <GapEditor step={p.step} hours={p.gapHours} />
                </div>
              ) : null}
              <div className="relative flex items-center gap-3 py-1">
                {!isLast ? (
                  <span
                    aria-hidden
                    className="absolute top-1/2 bottom-0 left-[17.5px] w-px bg-border-strong/70"
                  />
                ) : null}
                {i > 0 ? (
                  <span
                    aria-hidden
                    className="absolute top-0 bottom-1/2 left-[17.5px] w-px bg-border-strong/70"
                  />
                ) : null}
                <span
                  aria-hidden
                  className={cn(
                    "relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold tabular-nums",
                    ready
                      ? "bg-brand-ink text-white shadow-glow"
                      : "border border-dashed border-warn/60 bg-warn-soft text-warn",
                  )}
                >
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <div className="min-w-0">
                    <a
                      href={`#approval-email-${p.step}`}
                      className="block min-h-10 truncate rounded-sm py-2.5 text-sm font-semibold text-text underline-offset-2 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none sm:min-h-0 sm:py-0"
                    >
                      {emailTitle(p.step)}
                    </a>
                    <p className="text-xs text-muted">{sinceApproval(p.atHours)}</p>
                  </div>
                  {ready ? (
                    <StatusChip tone="good">Design ready</StatusChip>
                  ) : (
                    <StatusChip tone="warn">No design</StatusChip>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 border-t border-border pt-3 text-[13px] text-text-2">
        {lastEmailSentence(steps)}{" "}
        <span className="text-muted">
          Nights and, unless you allow them, weekends push an email to the next morning.
        </span>
      </p>

      <Dialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={last ? `Remove ${emailName(last.step)}?` : "Remove the last follow-up?"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              Keep it
            </Button>
            <Button variant="danger" disabled={busy === "remove"} onClick={() => void remove()}>
              {busy === "remove" ? "Removing…" : "Remove it"}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-text-2">
          {last ? emailName(last.step) : "The last follow-up"} comes off the end of the sequence
          {last && hasDesign(last) ? ", and its design and subject line go with it" : ""}. Approvals
          that already had every email before it are done.
        </p>
      </Dialog>
    </SettingsCard>
  );
}
