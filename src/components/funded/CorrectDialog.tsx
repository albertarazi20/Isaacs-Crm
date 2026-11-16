"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { correctFundingAction } from "@/app/money-actions";
import { FormDialog, useFormState, useRun } from "@/components/client/parts";
import { Field, Input, Select } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import type { FundedRow } from "@/lib/money/fund";

const MONEY_FIELDS = [
  { key: "amount", label: "Amount", current: (r: FundedRow) => formatMoney(r.amount_cents) },
  {
    key: "commission",
    label: "Commission",
    current: (r: FundedRow) => formatMoney(r.commission_cents ?? 0),
  },
  { key: "psf", label: "PSF", current: (r: FundedRow) => formatMoney(r.psf_cents) },
  { key: "payment", label: "Payment", current: (r: FundedRow) => formatMoney(r.payment_cents) },
] as const;

const KEYS = [
  "amount",
  "sellRate",
  "buyRate",
  "points",
  "psf",
  "commission",
  "payment",
  "frequency",
  "termDays",
  "funderName",
] as const;

/**
 * A manager corrects a confirmed funding: why, then only the terms that change. The original values are kept and
 * the difference posts as a dated correction line in the current month, never as an edit of a closed one.
 */
export function CorrectDialog({ row, onClose }: { row: FundedRow; onClose: () => void }) {
  const run = useRun();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: "reason" | "changes"; message: string } | null>(null);
  const { v, bind } = useFormState(() => ({
    reason: "",
    amount: "",
    sellRate: "",
    buyRate: "",
    points: "",
    psf: "",
    commission: "",
    payment: "",
    frequency: "",
    termDays: "",
    funderName: "",
  }));
  return (
    <FormDialog
      title={`Correct this funding — ${row.business_name}`}
      onClose={onClose}
      busy={busy}
      wide
      submitLabel="Post correction"
      onSubmit={async () => {
        if (v.reason.trim() === "") {
          setError({ field: "reason", message: "Say why the funding is being corrected" });
          return;
        }
        // only what was typed travels: a blank box keeps the term as it is
        const changes: Record<string, string> = {};
        for (const k of KEYS) if (v[k].trim() !== "") changes[k] = v[k].trim();
        if (Object.keys(changes).length === 0) {
          setError({ field: "changes", message: "Change at least one term" });
          return;
        }
        setError(null);
        setBusy(true);
        const ok = await run(
          correctFundingAction({ fundingId: row.id, reason: v.reason, changes }),
          "Funding corrected",
        );
        setBusy(false);
        if (ok) {
          onClose();
          router.refresh();
        }
      }}
    >
      <Field label="Why is it being corrected?">
        <Input
          {...bind("reason")}
          maxLength={300}
          placeholder="The lender's statement shows 6 points"
          aria-invalid={error?.field === "reason" ? true : undefined}
        />
        {error?.field === "reason" ? (
          <span className="block text-xs text-bad">{error.message}</span>
        ) : null}
      </Field>
      <p className="text-xs text-muted">
        Fill in only the terms that change; a blank box keeps what is on file.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {MONEY_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <Input {...bind(f.key)} inputMode="decimal" placeholder={f.current(row)} />
          </Field>
        ))}
        <Field label="Factor rate">
          <Input
            {...bind("sellRate")}
            inputMode="decimal"
            placeholder={Number(row.factor_rate).toFixed(2)}
          />
        </Field>
        <Field label="Buy rate">
          <Input {...bind("buyRate")} inputMode="decimal" placeholder="Keep" />
        </Field>
        <Field label="Points">
          <Input {...bind("points")} inputMode="decimal" placeholder={String(row.points ?? "")} />
        </Field>
        <Field label="Frequency">
          <Select {...bind("frequency")}>
            <option value="">Keep ({row.frequency})</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every two weeks</option>
            <option value="monthly">Monthly</option>
          </Select>
        </Field>
        <Field label="Term (days)">
          <Input
            {...bind("termDays")}
            inputMode="numeric"
            placeholder={String(row.term_days ?? "")}
          />
        </Field>
        <Field label="Lender">
          <Input {...bind("funderName")} maxLength={200} placeholder={row.funder_name} />
        </Field>
      </div>
      {error?.field === "changes" ? <p className="text-xs text-bad">{error.message}</p> : null}
    </FormDialog>
  );
}
