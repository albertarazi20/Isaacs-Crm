"use client";

import { useState } from "react";
import { saveFunderAction } from "@/app/funders-actions";
import { Field, Input, Select, Textarea } from "@/components/ui";
import { FormDialog, useFormState, useRun } from "@/components/client/parts";
import { funderSchema } from "@/lib/funders/schemas";
import {
  MONEY_TERM_DEFAULTS,
  RENEWAL_COMMISSION_BASES,
  RENEWAL_COMMISSION_BASIS_LABELS,
  type FunderRow,
} from "@/lib/funders/types";

interface FunderForm {
  name: string;
  submissionEmail: string;
  contactName: string;
  phone: string;
  notes: string;
  minMonthlyRevenue: string;
  minTimeInBusinessMonths: string;
  maxPosition: string;
  minAmount: string;
  maxAmount: string;
  excludedStates: string;
  excludedIndustries: string;
  commissionPoints: string;
  renewalPaydownPct: string;
  // money terms (0350): what FUND checks this lender's deals against
  maxUpsellPoints: string;
  psfCapPct: string;
  clawbackDays: string;
  approvalValidDays: string;
  statementFreshDay: string;
  commissionPaidAfterDays: string;
  renewalCommissionBasis: string;
}

/** 5_000_000 cents → "50k", so the form shows money the way Isaac types it. */
function moneyText(cents: number | null): string {
  if (cents === null) return "";
  if (cents % 100_000 === 0) return `${cents / 100_000}k`;
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

const num = (n: number | null) => (n === null ? "" : String(n));

function toForm(f: FunderRow | undefined): FunderForm {
  return {
    name: f?.name ?? "",
    submissionEmail: f?.submission_email ?? "",
    contactName: f?.contact_name ?? "",
    phone: f?.phone ?? "",
    notes: f?.notes ?? "",
    minMonthlyRevenue: moneyText(f?.min_monthly_revenue_cents ?? null),
    minTimeInBusinessMonths: num(f?.min_time_in_business_months ?? null),
    maxPosition: num(f?.max_position ?? null),
    minAmount: moneyText(f?.min_amount_cents ?? null),
    maxAmount: moneyText(f?.max_amount_cents ?? null),
    excludedStates: (f?.excluded_states ?? []).join(", "),
    excludedIndustries: (f?.excluded_industries ?? []).join(", "),
    commissionPoints: num(f?.commission_points ?? null),
    renewalPaydownPct: num(f?.renewal_paydown_pct ?? null),
    maxUpsellPoints: num(f?.max_upsell_points ?? null),
    psfCapPct: num(f?.psf_cap_pct ?? null),
    clawbackDays: num(f?.clawback_days ?? null),
    approvalValidDays: num(f?.approval_valid_days ?? null),
    statementFreshDay: num(f?.statement_fresh_day ?? null),
    commissionPaidAfterDays: num(f?.commission_paid_after_days ?? null),
    renewalCommissionBasis:
      f?.renewal_commission_basis ?? MONEY_TERM_DEFAULTS.renewal_commission_basis,
  };
}

/** Add or edit a funder. A failed save keeps the dialog open with everything still typed. */
export function FunderDialog({
  existing,
  onClose,
}: {
  existing: FunderRow | undefined;
  onClose: () => void;
}) {
  const run = useRun();
  const { v, bind } = useFormState<FunderForm>(() => toForm(existing));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    const payload = { ...v, ...(existing ? { id: existing.id } : {}) };
    // The same rules the server applies, so a typo is explained here, next to the form.
    const parsed = funderSchema.safeParse(payload);
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? "That doesn't look right");
      return;
    }
    setProblem(null);
    setBusy(true);
    const ok = await run(
      saveFunderAction(payload),
      existing ? `Saved ${v.name.trim()}` : `Added ${v.name.trim()}`,
    );
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <FormDialog
      title={existing ? `Edit ${existing.name}` : "Add a funder"}
      onClose={onClose}
      onSubmit={() => void save()}
      busy={busy}
      wide
    >
      {problem ? (
        <p role="alert" className="rounded-lg bg-bad-soft p-3 text-sm text-bad">
          {problem}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Funder name *" className="sm:col-span-2">
          <Input {...bind("name")} autoFocus placeholder="e.g. Pearl Capital" />
        </Field>
        <Field label="Contact name">
          <Input {...bind("contactName")} placeholder="Who you deal with there" />
        </Field>
        <Field label="Phone">
          <Input {...bind("phone")} inputMode="tel" />
        </Field>
        <Field label="Where you send applications" className="sm:col-span-2">
          <Input
            {...bind("submissionEmail")}
            type="email"
            inputMode="email"
            placeholder="subs@funder.com"
          />
        </Field>
      </div>

      <div>
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
          What they write
        </h3>
        <p className="mt-1 text-xs text-muted">
          Leave a box empty when they have no limit or you don&apos;t know. The fit check warns you
          before you send — it never stops you.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Minimum monthly revenue" hint="Like 50k or $75,000">
          <Input {...bind("minMonthlyRevenue")} inputMode="decimal" />
        </Field>
        <Field label="Minimum time in business (months)" hint="Like 12">
          <Input {...bind("minTimeInBusinessMonths")} inputMode="numeric" />
        </Field>
        <Field label="Highest position they'll take" hint="1 = first position only. Empty = any">
          <Input {...bind("maxPosition")} inputMode="numeric" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Smallest advance">
            <Input {...bind("minAmount")} inputMode="decimal" placeholder="10k" />
          </Field>
          <Field label="Largest advance">
            <Input {...bind("maxAmount")} inputMode="decimal" placeholder="250k" />
          </Field>
        </div>
        <Field label="States they won't write" hint="Two-letter codes, like FL, NY">
          <Input {...bind("excludedStates")} />
        </Field>
        <Field label="Industries they skip" hint="Separate with commas: restaurants, trucking">
          <Input {...bind("excludedIndustries")} />
        </Field>
        <Field label="Your commission points" hint="Points on the funded amount, like 10">
          <Input {...bind("commissionPoints")} inputMode="decimal" />
        </Field>
        <Field label="Renews merchants at (% paid down)" hint="Empty = 50">
          <Input {...bind("renewalPaydownPct")} inputMode="numeric" />
        </Field>
      </div>

      <div>
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Money terms</h3>
        <p className="mt-1 text-xs text-muted">
          What FUND checks a deal with this lender against. Points or a PSF above the cap are
          refused before anything is recorded; the clocks drive the ledger, Renewals and the
          stale-approval chase. Empty means the shop default shown in the box.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Max upsell points" hint="Points above this are refused. Empty = no cap">
          <Input {...bind("maxUpsellPoints")} inputMode="decimal" placeholder="no cap" />
        </Field>
        <Field
          label="PSF cap (% of the advance)"
          hint="A PSF above this is refused. Empty = no cap"
        >
          <Input {...bind("psfCapPct")} inputMode="decimal" placeholder="no cap" />
        </Field>
        <Field label="Clawback window (days)" hint="A default inside it claws the commission back">
          <Input
            {...bind("clawbackDays")}
            inputMode="numeric"
            placeholder={String(MONEY_TERM_DEFAULTS.clawback_days)}
          />
        </Field>
        <Field label="Approval good for (days)" hint="The approval-expiry clock on the board">
          <Input
            {...bind("approvalValidDays")}
            inputMode="numeric"
            placeholder={String(MONEY_TERM_DEFAULTS.approval_valid_days)}
          />
        </Field>
        <Field
          label="Statements fresh from the (day of month)"
          hint="After this day they want last month's statement"
        >
          <Input
            {...bind("statementFreshDay")}
            inputMode="numeric"
            placeholder={String(MONEY_TERM_DEFAULTS.statement_fresh_day)}
          />
        </Field>
        <Field
          label="Commission paid after (days)"
          hint="Days after funding the wire usually lands"
        >
          <Input
            {...bind("commissionPaidAfterDays")}
            inputMode="numeric"
            placeholder={String(MONEY_TERM_DEFAULTS.commission_paid_after_days)}
          />
        </Field>
        <Field label="Renewal commission is paid on" className="sm:col-span-2">
          <Select {...bind("renewalCommissionBasis")}>
            {RENEWAL_COMMISSION_BASES.map((b) => (
              <option key={b} value={b}>
                {RENEWAL_COMMISSION_BASIS_LABELS[b]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Notes">
        <Textarea
          {...bind("notes")}
          rows={2}
          placeholder="Quirks, who to ask for, how fast they are"
        />
      </Field>
    </FormDialog>
  );
}
