"use client";

import { useState } from "react";
import { recordCommissionReceivedAction } from "@/app/earnings-actions";
import { parseMoney } from "@/lib/money";
import { moneyInput } from "@/lib/earnings/terms";
import { useApp } from "../app-context";
import { FormDialog, useFormState, useRun } from "../client/parts";
import { Button, Field, Input } from "../ui";

/** "Record received": the amount the funder paid and the day it arrived, without opening the whole advance. */
export function RecordCommission({
  fundingId,
  businessName,
  suggestedCents,
}: {
  fundingId: string;
  businessName: string;
  suggestedCents: number | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Record received
      </Button>
      {open ? (
        <RecordDialog
          fundingId={fundingId}
          businessName={businessName}
          suggestedCents={suggestedCents}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function RecordDialog({
  fundingId,
  businessName,
  suggestedCents,
  onClose,
}: {
  fundingId: string;
  businessName: string;
  suggestedCents: number | null;
  onClose: () => void;
}) {
  const { today } = useApp();
  const run = useRun();
  const { v, bind } = useFormState(() => ({
    amount: moneyInput(suggestedCents),
    receivedOn: today,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const cents = parseMoney(v.amount);
    if (v.amount.trim() === "" || cents === null)
      return setError("Enter the amount received, like 2500");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.receivedOn)) return setError("Pick the day it arrived");
    if (v.receivedOn > today) return setError("The day it arrived can't be in the future");
    setError(null);
    setBusy(true);
    const ok = await run(
      recordCommissionReceivedAction({ fundingId, amount: v.amount, receivedOn: v.receivedOn }),
      `Commission recorded for ${businessName}`,
    );
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <FormDialog
      title={`Commission received — ${businessName}`}
      onClose={onClose}
      onSubmit={() => void save()}
      busy={busy}
    >
      <Field
        label="Amount received"
        hint={
          suggestedCents === null
            ? "What the funder actually paid you."
            : "Filled in with what you expected. Change it to what actually arrived."
        }
      >
        <Input {...bind("amount")} inputMode="decimal" autoFocus />
      </Field>
      <Field label="Day it arrived">
        <Input {...bind("receivedOn")} type="date" max={today} />
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      ) : null}
    </FormDialog>
  );
}
