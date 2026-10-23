"use client";

import { useState } from "react";
import { updateFundingAction } from "@/app/actions";
import type { FundingRow, TimerRow } from "@/lib/data/types";
import { formatDate, formatDateTime, relativeDay } from "@/lib/format";
import { RENEWAL_PAYDOWN_PCT } from "@/lib/mca/funding";
import { formatMoney } from "@/lib/money";
import { useApp } from "../app-context";
import { Badge, Button, Field, Input, Textarea } from "../ui";
import {
  commissionPoints,
  formatFactor,
  FUNDING_STATUS_LABELS,
  fundingForm,
  fundingPayload,
  fundingSnapshot,
  ordinal,
  remittanceLabel,
  type FundingForm,
} from "./logic";
import { FormDialog, Muted, Panel, Stat, useFormState, useNowMs, useRun } from "./parts";

const STATUS_TONE = {
  active: "good",
  paid_off: "accent",
  defaulted: "bad",
  renewed: "neutral",
} as const;

export function FundingCard({
  fundings,
  timers,
  className,
}: {
  fundings: FundingRow[];
  timers: TimerRow[];
  className?: string;
}) {
  const { today, timezone } = useApp();
  const nowMs = useNowMs();
  const [editing, setEditing] = useState(false);
  const [latest, ...past] = fundings;
  if (!latest) return null;
  const snap = fundingSnapshot(latest, today);
  const nextCheckIn = timers.find((t) => t.kind === "check_in");
  const points = commissionPoints(latest.commission_cents, latest.amount_cents);
  const promiseMissed =
    latest.promise_to_pay_at !== null && new Date(latest.promise_to_pay_at).getTime() < nowMs;

  return (
    <Panel
      title="Funding"
      className={className}
      aside={
        <div className="flex items-center gap-2">
          <Badge tone={STATUS_TONE[latest.status]}>{FUNDING_STATUS_LABELS[latest.status]}</Badge>
          <Button size="sm" onClick={() => setEditing(true)}>
            Update
          </Button>
        </div>
      }
    >
      {latest.status === "defaulted" ? (
        <div className="mb-4 rounded-lg border border-bad bg-bad-soft p-3 text-bad">
          <p className="font-semibold">
            Defaulted{latest.defaulted_on ? ` on ${formatDate(latest.defaulted_on, today)}` : ""}
          </p>
          {latest.promise_to_pay_at ? (
            <p className="mt-1 text-sm">
              Promise to pay
              {latest.promise_amount_cents !== null
                ? ` ${formatMoney(latest.promise_amount_cents)}`
                : ""}{" "}
              by <strong>{formatDateTime(latest.promise_to_pay_at, timezone)}</strong>
              {promiseMissed ? " — that time has passed. Did the remittance come in?" : ""}
            </p>
          ) : (
            <p className="mt-1 text-sm">No promise to pay on file. Get a date and amount.</p>
          )}
        </div>
      ) : latest.promise_to_pay_at ? (
        <p className="mb-4 rounded-lg bg-warn-soft p-3 text-sm text-warn">
          Promise to pay
          {latest.promise_amount_cents !== null
            ? ` ${formatMoney(latest.promise_amount_cents)}`
            : ""}{" "}
          by <strong>{formatDateTime(latest.promise_to_pay_at, timezone)}</strong>
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-muted">Paid to date</p>
          <p className="text-xl font-bold">{formatMoney(snap.paidCents)}</p>
          <p className="text-xs text-muted">
            {snap.overridden ? "(entered by you)" : "(estimated from remittances elapsed)"}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted">Balance</p>
          <p className="text-xl font-bold">{formatMoney(snap.balanceCents)}</p>
        </div>
      </div>

      <div className="mt-3">
        <div
          role="progressbar"
          aria-label="Paid down"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(snap.pct)}
          className="relative h-3 rounded-full bg-surface-2"
        >
          <div
            className="h-full rounded-full bg-good"
            style={{ width: `${Math.min(100, snap.pct)}%` }}
          />
          <div
            aria-hidden
            title={`${RENEWAL_PAYDOWN_PCT}% — renewal window`}
            className="absolute -top-1 -bottom-1 left-1/2 w-0.5 -translate-x-1/2 rounded bg-text"
          />
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-muted">
          <span>{snap.pct}% paid down</span>
          <span>{RENEWAL_PAYDOWN_PCT}%</span>
          <span>{formatMoney(snap.paybackCents)} payback</span>
        </div>
        <p className="mt-2 text-sm font-medium">
          {latest.status === "defaulted"
            ? "No renewal while the advance is in default"
            : snap.renewalOn === null
              ? "Renewal call: add the remittance amount to calculate"
              : snap.pastHalfway
                ? "Renewal call: now — already past 50% paid down"
                : `Renewal call: ${formatDate(snap.renewalOn, today)}`}
        </p>
        {nextCheckIn ? (
          <p className="text-sm">
            Next check-in: <strong>{formatDate(nextCheckIn.due_on, today)}</strong>{" "}
            <span className="text-muted">· {relativeDay(nextCheckIn.due_on, today)}</span>
          </p>
        ) : null}
        {snap.payoffOn ? (
          <Muted>Estimated term ends {formatDate(snap.payoffOn, today)}</Muted>
        ) : null}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3">
        <Stat label="Funded">{formatDate(latest.funded_on, today)}</Stat>
        <Stat label="Advance">{formatMoney(latest.amount_cents)}</Stat>
        <Stat label="Factor rate">{formatFactor(latest.factor_rate)}</Stat>
        <Stat label="Payback">{formatMoney(latest.payback_cents)}</Stat>
        <Stat label="Remittance">
          {remittanceLabel(latest.payment_cents, latest.frequency, formatMoney)}
        </Stat>
        <Stat label="Position">{ordinal(latest.position_no)}</Stat>
        <Stat label="Funder">{latest.funder_name || "—"}</Stat>
        {latest.term_days !== null ? <Stat label="Term">{latest.term_days} days</Stat> : null}
        {latest.commission_cents !== null ? (
          <Stat label="Commission points">
            {formatMoney(latest.commission_cents)}
            {points !== null ? ` (${points} pts)` : ""}
          </Stat>
        ) : null}
        <Stat label="Last remittance">
          {latest.last_payment_on ? formatDate(latest.last_payment_on, today) : "—"}
        </Stat>
      </dl>
      {latest.note ? <p className="mt-3 text-sm whitespace-pre-wrap">{latest.note}</p> : null}

      {past.length > 0 ? (
        <details className="mt-3 border-t border-border pt-3">
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-text">
            Past advances ({past.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {past.map((f) => (
              <li key={f.id} className="rounded-lg bg-surface-2 p-2.5 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <strong>{formatMoney(f.amount_cents)}</strong> at {formatFactor(f.factor_rate)}
                  <Badge tone={STATUS_TONE[f.status]}>{FUNDING_STATUS_LABELS[f.status]}</Badge>
                </p>
                <p className="text-muted">
                  {formatDate(f.funded_on, today)}
                  {f.funder_name ? ` · ${f.funder_name}` : ""} ·{" "}
                  {remittanceLabel(f.payment_cents, f.frequency, formatMoney)} ·{" "}
                  {ordinal(f.position_no)} position
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {editing ? (
        <FundingDialog funding={latest} timezone={timezone} onClose={() => setEditing(false)} />
      ) : null}
    </Panel>
  );
}

function FundingDialog({
  funding,
  timezone,
  onClose,
}: {
  funding: FundingRow;
  timezone: string;
  onClose: () => void;
}) {
  const run = useRun();
  const { v, bind } = useFormState<FundingForm>(() => fundingForm(funding, timezone));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const ok = await run(updateFundingAction(fundingPayload(funding.id, v)), "Funding updated");
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <FormDialog title="Update funding" onClose={onClose} onSubmit={() => void save()} busy={busy}>
      <Field
        label="Collected so far"
        hint="From a statement or the funder's portal. Leave blank to estimate from remittances elapsed."
      >
        <Input {...bind("paidBackOverride")} inputMode="decimal" autoFocus />
      </Field>
      <Field label="Last remittance received">
        <Input {...bind("lastPaymentOn")} type="date" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Promise to pay — when">
          <Input {...bind("promiseToPayAt")} type="datetime-local" />
        </Field>
        <Field label="Promise to pay — how much">
          <Input {...bind("promiseAmount")} inputMode="decimal" />
        </Field>
      </div>
      <Field label="Note">
        <Textarea {...bind("note")} rows={3} />
      </Field>
    </FormDialog>
  );
}
