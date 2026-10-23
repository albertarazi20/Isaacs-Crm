"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "@/components/app-context";
import { Dialog } from "@/components/overlay";
import { TimerPicker } from "@/components/TimerPicker";
import { Button, cn, Input, Select, Textarea } from "@/components/ui";
import type { ClientCard } from "@/lib/data/types";
import { formatDate, toLocalInput } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { ISODate } from "@/lib/mca/dates";
import type { Frequency } from "@/lib/mca/funding";
import { stageDef, type StageKey } from "@/lib/mca/stages";
import {
  centsToInput,
  checkCompetitor,
  checkDefault,
  checkFunding,
  clampToToday,
  competitorCallback,
  defaultFollowUp,
  fundingPreview,
  FREQUENCIES,
  FREQUENCY_ADJECTIVE,
  type CompetitorForm,
  type DefaultForm,
  type FundingForm,
} from "./forms";

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
      <span className="text-xs font-medium text-muted">{label}</span>
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

function Preview({ children }: { children: ReactNode }) {
  return <div className="space-y-1 rounded-lg bg-surface-2 p-3 text-sm">{children}</div>;
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

// ---- funded --------------------------------------------------------------------------------

export function FundingDialog({ card, onSubmit, onCancel }: DialogProps) {
  const { today } = useApp();
  const first = useFocusFirst();
  const { busy, send } = useBusy(onSubmit);
  const [f, setF] = useState<FundingForm>(() => ({
    fundedOn: today,
    amount: centsToInput(card.funding_amount_cents),
    factorRate: card.factor_rate === null ? "" : String(card.factor_rate),
    payment: centsToInput(card.funding_payment_cents),
    frequency: card.funding_frequency ?? "daily",
    funderName: "",
    positionNo: "1",
    termDays: "",
    commission: "",
  }));
  const [tried, setTried] = useState(false);
  const set = (k: keyof FundingForm) => (v: string) => setF((cur) => ({ ...cur, [k]: v }));
  const { errors, terms } = checkFunding(f, today);
  const preview = terms ? fundingPreview(terms, today) : null;
  const err = (k: keyof FundingForm) => (tried ? errors[k] : undefined);
  const renewing = card.funding_id !== null;

  function submit() {
    setTried(true);
    if (Object.keys(errors).length > 0 || !terms) return;
    void send({
      funding: {
        fundedOn: f.fundedOn,
        amount: f.amount,
        factorRate: f.factorRate,
        payment: f.payment,
        frequency: f.frequency,
        funderName: f.funderName.trim(),
        positionNo: f.positionNo,
        termDays: f.termDays,
        commission: f.commission,
      },
    });
  }

  return (
    <Dialog
      open
      wide
      onClose={() => !busy && onCancel()}
      title={`${card.business_name} — funded`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="funding-form" disabled={busy}>
            {busy ? "Saving…" : "Mark funded"}
          </Button>
        </>
      }
    >
      <form
        ref={first}
        id="funding-form"
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {renewing ? (
          <p className="text-sm text-muted">
            Terms are filled in from their last advance. Change whatever is different this time.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Row label="Funded on" error={err("fundedOn")}>
            <Input
              type="date"
              max={today}
              value={f.fundedOn}
              onChange={(e) => set("fundedOn")(e.target.value)}
            />
          </Row>
          <Row label="Funder" hint="Who put up the money (optional)">
            <Input
              value={f.funderName}
              onChange={(e) => set("funderName")(e.target.value)}
              placeholder="e.g. Everest Funding"
            />
          </Row>
          <Row label="Advance amount" error={err("amount")}>
            <Input
              inputMode="decimal"
              value={f.amount}
              onChange={(e) => set("amount")(e.target.value)}
              placeholder="50k"
            />
          </Row>
          <Row label="Factor rate" error={err("factorRate")}>
            <Input
              inputMode="decimal"
              value={f.factorRate}
              onChange={(e) => set("factorRate")(e.target.value)}
              placeholder="1.35"
            />
          </Row>
          <Row label="Remittance (each debit)" error={err("payment")}>
            <Input
              inputMode="decimal"
              value={f.payment}
              onChange={(e) => set("payment")(e.target.value)}
              placeholder="450"
            />
          </Row>
          <Row label="How often">
            <Select
              value={f.frequency}
              onChange={(e) => setF((cur) => ({ ...cur, frequency: e.target.value as Frequency }))}
            >
              {FREQUENCIES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Position" error={err("positionNo")} hint="1 = first advance on the business">
            <Input
              inputMode="numeric"
              value={f.positionNo}
              onChange={(e) => set("positionNo")(e.target.value)}
            />
          </Row>
          <Row label="Estimated term (days)" error={err("termDays")} hint="Optional">
            <Input
              inputMode="numeric"
              value={f.termDays}
              onChange={(e) => set("termDays")(e.target.value)}
              placeholder="120"
            />
          </Row>
          <Row
            label="Commission points ($)"
            error={err("commission")}
            hint="Your commission on this advance, optional"
          >
            <Input
              inputMode="decimal"
              value={f.commission}
              onChange={(e) => set("commission")(e.target.value)}
              placeholder="3.5k"
            />
          </Row>
        </div>
        {preview && terms ? (
          <Preview>
            <p>
              Payback <strong>{formatMoney(preview.paybackCents)}</strong>
              {" · "}
              {preview.paymentCount} {FREQUENCY_ADJECTIVE[f.frequency]} remittances
              {preview.payoffOn ? ` · paid off about ${formatDate(preview.payoffOn, today)}` : ""}
            </p>
            {preview.renewalOn ? (
              <p>
                Renewal call will be set for <strong>{formatDate(preview.renewalOn, today)}</strong>{" "}
                (50% paid down)
              </p>
            ) : null}
            <p>
              Check-in in 30 days (<strong>{formatDate(preview.checkInOn, today)}</strong>)
            </p>
          </Preview>
        ) : (
          <p className="text-sm text-muted">
            Fill in the amount, factor rate and remittance to see the payback and the renewal date.
          </p>
        )}
      </form>
    </Dialog>
  );
}

// ---- lost deal -----------------------------------------------------------------------------

export function CompetitorDialog({ card, onSubmit, onCancel }: DialogProps) {
  const { today } = useApp();
  const first = useFocusFirst();
  const { busy, send } = useBusy(onSubmit);
  const [f, setF] = useState<CompetitorForm>({
    funderName: "",
    amount: "",
    factorRate: "",
    payment: "",
    frequency: "",
    positionNo: "",
    termDays: "",
    note: "",
  });
  const [tried, setTried] = useState(false);
  const set = (k: keyof CompetitorForm) => (v: string) => setF((cur) => ({ ...cur, [k]: v }));
  const errors = checkCompetitor(f);
  const err = (k: keyof CompetitorForm) => (tried ? errors[k] : undefined);
  const callback = competitorCallback(f.termDays, today);

  function submit() {
    setTried(true);
    if (Object.keys(errors).length > 0) return;
    void send({
      competitor: {
        funderName: f.funderName.trim(),
        amount: f.amount,
        factorRate: f.factorRate,
        payment: f.payment,
        ...(f.frequency ? { frequency: f.frequency } : {}),
        positionNo: f.positionNo,
        termDays: f.termDays,
        note: f.note,
      },
    });
  }

  return (
    <Dialog
      open
      wide
      onClose={() => !busy && onCancel()}
      title={`${card.business_name} — who did they go with?`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void send({})}>
            Skip details
          </Button>
          <Button variant="primary" type="submit" form="competitor-form" disabled={busy}>
            {busy ? "Saving…" : "Save and move"}
          </Button>
        </>
      }
    >
      <form
        ref={first}
        id="competitor-form"
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="text-sm text-muted">
          Only the funder is needed. The rest helps you call back at the right time.
        </p>
        <Row label="Competing funder" error={err("funderName")}>
          <Input
            value={f.funderName}
            onChange={(e) => set("funderName")(e.target.value)}
            placeholder="e.g. Everest Funding"
          />
        </Row>
        <div className="grid gap-3 sm:grid-cols-2">
          <Row label="Their advance amount" error={err("amount")}>
            <Input
              inputMode="decimal"
              value={f.amount}
              onChange={(e) => set("amount")(e.target.value)}
              placeholder="40k"
            />
          </Row>
          <Row label="Factor rate" error={err("factorRate")}>
            <Input
              inputMode="decimal"
              value={f.factorRate}
              onChange={(e) => set("factorRate")(e.target.value)}
              placeholder="1.38"
            />
          </Row>
          <Row label="Remittance (each debit)" error={err("payment")}>
            <Input
              inputMode="decimal"
              value={f.payment}
              onChange={(e) => set("payment")(e.target.value)}
            />
          </Row>
          <Row label="How often">
            <Select
              value={f.frequency}
              onChange={(e) =>
                setF((cur) => ({ ...cur, frequency: e.target.value as Frequency | "" }))
              }
            >
              <option value="">Not sure</option>
              {FREQUENCIES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Position" error={err("positionNo")}>
            <Input
              inputMode="numeric"
              value={f.positionNo}
              onChange={(e) => set("positionNo")(e.target.value)}
            />
          </Row>
          <Row
            label="Term (days)"
            error={err("termDays")}
            hint="Sets your callback at half the term"
          >
            <Input
              inputMode="numeric"
              value={f.termDays}
              onChange={(e) => set("termDays")(e.target.value)}
              placeholder="180"
            />
          </Row>
        </div>
        <Row label="Note">
          <Textarea
            rows={2}
            className="min-h-16"
            value={f.note}
            onChange={(e) => set("note")(e.target.value)}
          />
        </Row>
        <Preview>
          {callback.basis === "term" ? (
            <p>
              Callback set for <strong>{formatDate(callback.dueOn, today)}</strong> — half of their{" "}
              {f.termDays.trim()}-day term, when they should be about 50% paid down.
            </p>
          ) : (
            <p>
              No term yet, so the callback is <strong>{formatDate(callback.dueOn, today)}</strong>{" "}
              (6 months). Add their term to call back when they&apos;re half paid down.
            </p>
          )}
        </Preview>
      </form>
    </Dialog>
  );
}

// ---- default stages ------------------------------------------------------------------------

export function DefaultDialog({
  card,
  stage,
  onSubmit,
  onCancel,
}: DialogProps & { stage: StageKey }) {
  const { today, timezone } = useApp();
  const first = useFocusFirst();
  const { busy, send } = useBusy(onSubmit);
  const [f, setF] = useState<DefaultForm>(() => ({
    defaultedOn: card.defaulted_on ?? today,
    promiseAt: card.promise_to_pay_at ? toLocalInput(card.promise_to_pay_at, timezone) : "",
    promiseAmount: centsToInput(card.promise_amount_cents),
    note: "",
  }));
  const [tried, setTried] = useState(false);
  const set = (k: keyof DefaultForm) => (v: string) => setF((cur) => ({ ...cur, [k]: v }));
  const errors = checkDefault(f, today);
  const err = (k: keyof DefaultForm) => (tried ? errors[k] : undefined);
  const followUp = defaultFollowUp(stage, f.promiseAt, today);

  const withDetails = () => ({
    followUpOn: followUp.dueOn,
    default: {
      defaultedOn: f.defaultedOn,
      ...(f.promiseAt ? { promiseToPayAt: f.promiseAt } : {}),
      promiseAmount: f.promiseAmount,
      note: f.note,
    },
  });
  // "Skip" must not wipe a promise Isaac already recorded, so an existing one rides along.
  const skipDetails = () =>
    card.promise_to_pay_at || card.promise_amount_cents !== null || card.defaulted_on
      ? {
          default: {
            ...(card.defaulted_on ? { defaultedOn: card.defaulted_on } : {}),
            ...(card.promise_to_pay_at
              ? { promiseToPayAt: toLocalInput(card.promise_to_pay_at, timezone) }
              : {}),
            promiseAmount: centsToInput(card.promise_amount_cents),
          },
        }
      : {};

  return (
    <Dialog
      open
      wide
      onClose={() => !busy && onCancel()}
      title={`${card.business_name} — ${stageDef(stage).label}`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void send(skipDetails())}>
            Skip details
          </Button>
          <Button variant="primary" type="submit" form="default-form" disabled={busy}>
            {busy ? "Saving…" : "Save and move"}
          </Button>
        </>
      }
    >
      <form
        ref={first}
        id="default-form"
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (Object.keys(errors).length === 0) void send(withDetails());
        }}
      >
        <p className="text-sm text-muted">
          Only the default date is needed. Add a promise to pay if the merchant gave one.
        </p>
        <Row label="Defaulted on" error={err("defaultedOn")}>
          <Input
            type="date"
            max={today}
            value={f.defaultedOn}
            onChange={(e) => set("defaultedOn")(e.target.value)}
          />
        </Row>
        <div className="grid gap-3 sm:grid-cols-2">
          <Row label="Promise to pay on" error={err("promiseAt")}>
            <Input
              type="datetime-local"
              value={f.promiseAt}
              onChange={(e) => set("promiseAt")(e.target.value)}
            />
          </Row>
          <Row label="Promised amount" error={err("promiseAmount")}>
            <Input
              inputMode="decimal"
              value={f.promiseAmount}
              onChange={(e) => set("promiseAmount")(e.target.value)}
              placeholder="2.5k"
            />
          </Row>
        </div>
        <Row label="Note">
          <Textarea
            rows={2}
            className="min-h-16"
            value={f.note}
            onChange={(e) => set("note")(e.target.value)}
          />
        </Row>
        <Preview>
          <p>
            Follow up <strong>{formatDate(followUp.dueOn, today)}</strong>
            {followUp.basis === "promise"
              ? " — the day they promised to pay."
              : ` — the usual timer for ${stageDef(stage).label.toLowerCase()}.`}
          </p>
        </Preview>
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
