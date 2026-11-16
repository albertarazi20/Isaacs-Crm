"use client";

import { useEffect, useState } from "react";
import {
  listDeclineReasonsAction,
  recordOfferAction,
  setSubmissionStatusAction,
} from "@/app/funders-actions";
import { useApp } from "@/components/app-context";
import { FormDialog, Muted, useFormState, useRun } from "@/components/client/parts";
import { useToast } from "@/components/overlay";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { FREQUENCIES } from "@/components/stage-move/forms";
import type { ClientCard } from "@/lib/data/types";
import { curableText, groupDeclineReasons } from "@/lib/funders/declines";
import { offerSchema } from "@/lib/funders/schemas";
import type { DeclineReasonRow, SubmissionRow } from "@/lib/funders/types";
import { paybackCents } from "@/lib/mca/funding";
import { parseFactor, parseMoney, formatMoney } from "@/lib/money";

/**
 * The funder said no. A reason is required so the scoreboard — and Winback's "declined, now curable" pool —
 * can say why. The reasons are the `decline_reasons` table: handed in by the page when it has them, otherwise
 * read once when the dialog opens.
 */
export function DeclineDialog({
  sub,
  reasons,
  onClose,
}: {
  sub: SubmissionRow;
  /** The `decline_reasons` rows. Leave out where the server component cannot pass them; they load on open. */
  reasons?: readonly DeclineReasonRow[];
  onClose: () => void;
}) {
  const run = useRun();
  const toast = useToast();
  const { v, bind } = useFormState(() => ({ reason: "", note: "" }));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<DeclineReasonRow[] | null>(null);
  const needsLoad = reasons === undefined;
  useEffect(() => {
    if (!needsLoad) return;
    let live = true;
    void listDeclineReasonsAction().then((r) => {
      if (!live) return;
      if (r.ok) setLoaded(r.data);
      else toast({ message: r.error, tone: "error" });
    });
    return () => {
      live = false;
    };
  }, [needsLoad, toast]);
  const rows = reasons ?? loaded ?? [];
  const groups = groupDeclineReasons(rows);
  const picked = rows.find((r) => r.key === v.reason);

  async function save() {
    if (v.reason === "") {
      setProblem("Pick why they declined");
      return;
    }
    setProblem(null);
    setBusy(true);
    const ok = await run(
      setSubmissionStatusAction({
        submissionId: sub.id,
        status: "declined",
        declineReason: v.reason,
        note: v.note,
      }),
      `${sub.funder_name} declined`,
    );
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <FormDialog
      title={`${sub.funder_name} declined`}
      onClose={onClose}
      onSubmit={() => void save()}
      busy={busy}
      submitLabel="Save decline"
    >
      {problem ? (
        <p role="alert" className="rounded-lg bg-bad-soft p-3 text-sm text-bad">
          {problem}
        </p>
      ) : null}
      <Field label="Why did they decline? *" hint={curableText(picked) || undefined}>
        <Select {...bind("reason")} autoFocus disabled={needsLoad && loaded === null}>
          <option value="">{needsLoad && loaded === null ? "Loading…" : "Pick a reason…"}</option>
          {groups.map((g) => (
            <optgroup key={g.category} label={g.label}>
              {g.reasons.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      <Field label="Note" hint="Optional — what they said">
        <Textarea {...bind("note")} rows={2} />
      </Field>
    </FormDialog>
  );
}

/** The funder wants more documents. The note says which, and a follow-up is set to go get them. */
export function StipsDialog({ sub, onClose }: { sub: SubmissionRow; onClose: () => void }) {
  const run = useRun();
  const { v, bind } = useFormState(() => ({ note: "" }));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const ok = await run(
      setSubmissionStatusAction({
        submissionId: sub.id,
        status: "stips_requested",
        note: v.note,
      }),
      `${sub.funder_name} wants more stips`,
    );
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <FormDialog
      title={`${sub.funder_name} wants stips`}
      onClose={onClose}
      onSubmit={() => void save()}
      busy={busy}
      submitLabel="Save"
    >
      <Field label="What do they need?" hint="Like: 3 months of statements, voided check">
        <Textarea {...bind("note")} rows={3} autoFocus />
      </Field>
      <Muted>
        A follow-up with the merchant is set for the next business day so you can get them.
      </Muted>
    </FormDialog>
  );
}

interface OfferForm {
  amount: string;
  factorRate: string;
  payment: string;
  frequency: string;
  termDays: string;
  positionNo: string;
  fees: string;
  receivedOn: string;
  note: string;
}

/** The funder approved. Amount and factor are the minimum; the rest can be filled in as the offer firms up. */
export function OfferDialog({
  sub,
  card,
  onClose,
}: {
  sub: SubmissionRow;
  card: ClientCard;
  onClose: () => void;
}) {
  const { today } = useApp();
  const run = useRun();
  const { v, bind } = useFormState<OfferForm>(() => ({
    amount: "",
    factorRate: "",
    payment: "",
    frequency: "daily",
    termDays: "",
    positionNo: String(card.position_count + 1),
    fees: "",
    receivedOn: today,
    note: "",
  }));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const amount = parseMoney(v.amount);
  const factor = parseFactor(v.factorRate);
  const payback = amount && factor ? paybackCents(amount, factor) : null;

  async function save() {
    const payload = {
      submissionId: sub.id,
      ...v,
      // a frequency without a remittance means nothing
      frequency: v.payment.trim() === "" ? null : v.frequency,
    };
    const parsed = offerSchema.safeParse(payload);
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? "That doesn't look right");
      return;
    }
    setProblem(null);
    setBusy(true);
    const ok = await run(recordOfferAction(payload), `Offer from ${sub.funder_name} saved`);
    setBusy(false);
    if (ok) onClose();
  }

  async function approvedNoTerms() {
    setBusy(true);
    const ok = await run(
      setSubmissionStatusAction({ submissionId: sub.id, status: "approved", note: v.note }),
      `${sub.funder_name} approved — add the terms when you have them`,
    );
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <FormDialog
      title={`${sub.funder_name} approved`}
      onClose={onClose}
      onSubmit={() => void save()}
      busy={busy}
      submitLabel="Save offer"
      wide
      leftFooter={
        <Button variant="ghost" disabled={busy} onClick={() => void approvedNoTerms()}>
          Approved — terms later
        </Button>
      }
    >
      {problem ? (
        <p role="alert" className="rounded-lg bg-bad-soft p-3 text-sm text-bad">
          {problem}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Advance amount *" hint="Like 45k or $45,000">
          <Input {...bind("amount")} inputMode="decimal" autoFocus />
        </Field>
        <Field label="Factor rate *" hint="Like 1.34">
          <Input {...bind("factorRate")} inputMode="decimal" />
        </Field>
        <Field label="Remittance (each debit)" hint="Like 450">
          <Input {...bind("payment")} inputMode="decimal" />
        </Field>
        <Field label="How often">
          <Select {...bind("frequency")}>
            {FREQUENCIES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Position" hint="1 = first advance on the business">
          <Input {...bind("positionNo")} inputMode="numeric" />
        </Field>
        <Field label="Estimated term (days)">
          <Input {...bind("termDays")} inputMode="numeric" placeholder="130" />
        </Field>
        <Field label="Fees" hint="Origination and the like, optional">
          <Input {...bind("fees")} inputMode="decimal" />
        </Field>
        <Field label="Received on">
          <Input {...bind("receivedOn")} type="date" max={today} />
        </Field>
      </div>
      {payback ? (
        <p className="rounded-lg bg-surface-2 p-3 text-sm">
          Payback <strong>{formatMoney(payback)}</strong>
        </p>
      ) : null}
      <Field label="Note">
        <Textarea {...bind("note")} rows={2} />
      </Field>
    </FormDialog>
  );
}
