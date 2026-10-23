"use client";

import { useState, type ReactNode } from "react";
import { updateFundingTermsAction } from "@/app/earnings-actions";
import type { FundingRow, TimerRow } from "@/lib/data/types";
import { formatPoints, pointsOf } from "@/lib/earnings/commission";
import {
  checkTerms,
  renewalMove,
  switchCommissionMode,
  termsForm,
  changedTermsPayload,
  termsPreview,
  type CommissionMode,
  type EditableFunding,
  type TermsForm,
} from "@/lib/earnings/terms";
import { formatDate, formatDateTime, relativeDay } from "@/lib/format";
import { dateAtPaydown, RENEWAL_PAYDOWN_PCT } from "@/lib/mca/funding";
import { formatMoney } from "@/lib/money";
import { useApp } from "../app-context";
import { Badge, Button, cn, Input, Select, Textarea } from "../ui";
import {
  commissionPoints,
  formatFactor,
  FREQUENCY_LABELS,
  FUNDING_STATUS_LABELS,
  fundingSnapshot,
  fundingTerms,
  ordinal,
  remittanceLabel,
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
  // The advance whose dialog is open: the latest (Update) or a past one (Edit). Null = closed.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [latest, ...past] = fundings;
  if (!latest) return null;
  const received: EditableFunding = latest;
  const editing = fundings.find((f) => f.id === editingId) ?? null;
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
          <Button size="sm" onClick={() => setEditingId(latest.id)}>
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
        <Stat label="Commission received">
          {received.commission_received_cents != null && received.commission_received_on ? (
            <>
              {formatMoney(received.commission_received_cents)}{" "}
              <span className="font-normal text-muted">
                · {formatDate(received.commission_received_on, today)}
              </span>
            </>
          ) : latest.commission_cents !== null ? (
            <span className="font-normal text-muted">Not received yet</span>
          ) : (
            "—"
          )}
        </Stat>
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
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    aria-label={`Edit the ${formatMoney(f.amount_cents)} advance funded ${formatDate(f.funded_on, today)}`}
                    onClick={() => setEditingId(f.id)}
                  >
                    Edit
                  </Button>
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
        <FundingDialog
          key={editing.id}
          funding={editing}
          isLatest={editing.id === latest.id}
          timezone={timezone}
          onClose={() => setEditingId(null)}
        />
      ) : null}
    </Panel>
  );
}
function Row({
  label,
  hint,
  error,
  group,
  className,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  /** True when the row holds more than one control, so a <label> would claim the wrong one. */
  group?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className={cn("block space-y-1", className)}>
      <span className="block text-xs font-medium text-muted">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="block text-xs text-bad">
          {error}
        </span>
      ) : hint ? (
        <span className="block text-xs text-muted">{hint}</span>
      ) : null}
    </Tag>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 className="border-t border-border pt-3 text-xs font-semibold tracking-wide text-muted uppercase">
      {children}
    </h3>
  );
}

/**
 * Edits every term of an advance. The latest active advance also moves its renewal call (in the database, in one
 * transaction); an older one changes its record only. A failed save keeps this dialog open with everything typed.
 */
function FundingDialog({
  funding,
  isLatest,
  timezone,
  onClose,
}: {
  funding: FundingRow;
  isLatest: boolean;
  timezone: string;
  onClose: () => void;
}) {
  const { today } = useApp();
  const run = useRun();
  const { v, bind, set } = useFormState<TermsForm>(() => termsForm(funding, timezone));
  const [initial] = useState(() => termsForm(funding, timezone));
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);

  const { errors, terms, commissionCents } = checkTerms(v, today);
  // A field's problem shows once it was touched, or after the first Save attempt.
  const err = (k: keyof TermsForm) => (tried || v[k] !== initial[k] ? errors[k] : undefined);
  const preview = terms ? termsPreview(terms, commissionCents, today) : null;
  const live = isLatest && funding.status === "active";
  const move = live && terms ? renewalMove(fundingTerms(funding), terms) : null;
  const rawRenewal = terms ? dateAtPaydown(terms, RENEWAL_PAYDOWN_PCT) : null;
  const when = (d: string | null) => (d === null ? "—" : d <= today ? "now" : formatDate(d, today));

  function pickMode(mode: CommissionMode) {
    const next = switchCommissionMode(v, mode);
    set("commissionMode", next.commissionMode);
    set("commission", next.commission);
  }

  const commissionHint =
    commissionCents === null
      ? v.commissionMode === "points"
        ? "Points of the advance, like 5 or 6.5"
        : "What you expect to earn on this advance"
      : v.commissionMode === "points"
        ? `= ${formatMoney(commissionCents)}`
        : terms
          ? `= ${formatPoints(pointsOf(commissionCents, terms.amountCents) ?? 0)} points`
          : undefined;

  async function save() {
    if (Object.keys(errors).length > 0) {
      setTried(true);
      return;
    }
    // Only what he changed goes up: a stale dialog can't write old values over what another device recorded.
    const changes = changedTermsPayload(
      funding.id,
      { form: v, commissionCents },
      { form: initial, commissionCents: checkTerms(initial, today).commissionCents },
    );
    if (!changes) {
      onClose();
      return;
    }
    setBusy(true);
    const ok = await run(updateFundingTermsAction(changes), "Funding updated");
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <FormDialog
      title={isLatest ? "Update funding" : "Edit past advance"}
      onClose={onClose}
      onSubmit={() => void save()}
      busy={busy}
      wide
    >
      {isLatest ? (
        <>
          <Row
            label="Collected so far"
            hint="From a statement or the funder's portal. Leave blank to estimate from remittances elapsed."
            error={err("paidBackOverride")}
          >
            <Input {...bind("paidBackOverride")} inputMode="decimal" autoFocus />
          </Row>
          <Row label="Last remittance received" error={err("lastPaymentOn")}>
            <Input {...bind("lastPaymentOn")} type="date" max={today} />
          </Row>
          <div className="grid gap-3 sm:grid-cols-2">
            <Row label="Promise to pay — when" error={err("promiseToPayAt")}>
              <Input {...bind("promiseToPayAt")} type="datetime-local" />
            </Row>
            <Row label="Promise to pay — how much" error={err("promiseAmount")}>
              <Input {...bind("promiseAmount")} inputMode="decimal" />
            </Row>
          </div>
        </>
      ) : (
        <p className="rounded-lg bg-surface-2 p-3 text-sm text-muted">
          An older advance. Saving changes this record only — no reminders move.
        </p>
      )}

      <Heading>Advance terms</Heading>
      <p className="text-xs text-muted">
        Fix a typo here and the renewal call moves with it. No need to fund the merchant again.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Row label="Funded on" error={err("fundedOn")}>
          <Input {...bind("fundedOn")} type="date" max={today} />
        </Row>
        <Row label="Funder" error={err("funderName")}>
          <Input {...bind("funderName")} maxLength={200} />
        </Row>
        <Row label="Advance amount" error={err("amount")}>
          <Input {...bind("amount")} inputMode="decimal" placeholder="50k" />
        </Row>
        <Row label="Factor rate" error={err("factorRate")}>
          <Input {...bind("factorRate")} inputMode="decimal" placeholder="1.35" />
        </Row>
        <Row label="Remittance" error={err("payment")}>
          <Input {...bind("payment")} inputMode="decimal" placeholder="450" />
        </Row>
        <Row label="How often">
          <Select {...bind("frequency")}>
            {Object.entries(FREQUENCY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Position" error={err("positionNo")}>
          <Input {...bind("positionNo")} inputMode="numeric" />
        </Row>
        <Row label="Term (days)" error={err("termDays")}>
          <Input {...bind("termDays")} inputMode="numeric" placeholder="optional" />
        </Row>
      </div>

      <div
        className="z-10 rounded-lg border border-border bg-surface-2 p-3 text-sm sm:sticky sm:bottom-0 sm:shadow-md"
        aria-live="polite"
      >
        {preview ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Payback</dt>
              <dd className="font-medium">{formatMoney(preview.paybackCents)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Remittances to pay off</dt>
              <dd className="font-medium">{preview.remittances}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Estimated payoff</dt>
              <dd className="font-medium">
                {preview.payoffOn ? formatDate(preview.payoffOn, today) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Renewal call</dt>
              <dd className="font-medium">
                {rawRenewal !== null && rawRenewal <= today
                  ? "now — already past 50%"
                  : when(rawRenewal)}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-muted">
            Fill in the funded date, amount, factor rate and remittance to see the payback and
            dates.
          </p>
        )}
        {move ? (
          <p className="mt-2 font-medium text-warn">
            Saving moves the renewal call from {when(move.from)} to {when(move.to)}.
          </p>
        ) : null}
        {!live && isLatest ? (
          <p className="mt-2 text-muted">
            This advance is {FUNDING_STATUS_LABELS[funding.status].toLowerCase()}: saving changes
            this record only — no reminders move.
          </p>
        ) : null}
      </div>

      <Heading>Commission</Heading>
      <div className="grid gap-3 sm:grid-cols-2">
        <Row label="Commission you expect" hint={commissionHint} error={err("commission")} group>
          <div className="flex gap-2">
            <div
              role="group"
              aria-label="Enter commission as"
              className="inline-flex shrink-0 overflow-hidden rounded-lg border border-border"
            >
              {(["dollars", "points"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={v.commissionMode === m}
                  onClick={() => pickMode(m)}
                  className={cn(
                    "px-2.5 text-sm font-medium",
                    v.commissionMode === m
                      ? "bg-accent text-accent-fg"
                      : "bg-surface text-muted hover:bg-surface-2",
                  )}
                >
                  {m === "dollars" ? "$" : "Points"}
                </button>
              ))}
            </div>
            <Input
              {...bind("commission")}
              inputMode="decimal"
              aria-label="Commission you expect"
              placeholder={v.commissionMode === "points" ? "5" : "2500"}
            />
          </div>
        </Row>
        <span aria-hidden className="hidden sm:block" />
        <Row
          label="Commission received"
          hint="What the funder actually paid you"
          error={err("commissionReceived")}
        >
          <Input {...bind("commissionReceived")} inputMode="decimal" />
        </Row>
        <Row label="Day it arrived" error={err("commissionReceivedOn")}>
          <Input {...bind("commissionReceivedOn")} type="date" max={today} />
        </Row>
      </div>

      <Row label="Note">
        <Textarea {...bind("note")} rows={3} />
      </Row>
      {tried && Object.keys(errors).length > 0 ? (
        <p role="alert" className="text-sm text-bad">
          Fix the highlighted fields first — nothing has been saved.
        </p>
      ) : null}
    </FormDialog>
  );
}
