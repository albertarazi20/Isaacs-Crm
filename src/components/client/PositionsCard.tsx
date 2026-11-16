"use client";

import { useState } from "react";
import { deletePositionAction, savePositionAction } from "@/app/actions";
import type { PositionRow } from "@/lib/data/types";
import { formatDate } from "@/lib/format";
import type { Frequency } from "@/lib/mca/funding";
import { formatMoney } from "@/lib/money";
import { useApp } from "../app-context";
import { Badge, Button, EmptyState, Field, Input, Select } from "../ui";
import {
  FREQUENCY_LABELS,
  nextPositionNo,
  ordinal,
  remittanceLabel,
  positionError,
  positionForm,
  positionPaidDownPct,
  positionPayload,
  positionRollup,
  type PositionForm,
} from "./logic";
import { ConfirmButton, FormDialog, Muted, Panel, useFormState, useRun } from "./parts";
import { useToast } from "../overlay";

export function PositionsCard({
  clientId,
  positions,
  className,
}: {
  clientId: string;
  positions: PositionRow[];
  className?: string;
}) {
  const { today } = useApp();
  // `null` closed, `"new"` adding, otherwise the row being edited.
  const [editing, setEditing] = useState<PositionRow | "new" | null>(null);
  const roll = positionRollup(positions);

  return (
    <Panel
      title="Other advances"
      className={className}
      aside={
        <Button size="sm" onClick={() => setEditing("new")}>
          + Add
        </Button>
      }
    >
      {positions.length === 0 ? (
        <EmptyState title="No other advances recorded">
          Ask what he already owes other funders. A new advance would be{" "}
          <strong>{ordinal(roll.nextPosition)} position</strong>.
        </EmptyState>
      ) : (
        <>
          <p className="rounded-lg border border-border bg-surface-2 p-3 text-sm">
            <strong>
              {roll.count} {roll.count === 1 ? "position" : "positions"}
            </strong>{" "}
            · {formatMoney(roll.totalBalanceCents)} still owed ·{" "}
            {roll.paidDownPct !== null ? (
              <>{roll.paidDownPct}% paid down</>
            ) : (
              <span className="text-muted">add payback amounts to see % paid down</span>
            )}
            <br />A new advance would be <strong>{ordinal(roll.nextPosition)} position</strong>.
          </p>
          <ul className="mt-3 space-y-2">
            {positions.map((p) => {
              const pct = positionPaidDownPct(p);
              return (
                <li key={p.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                      <Badge tone="accent">{ordinal(p.position_no)}</Badge>
                      <span className="truncate">{p.funder_name || "Funder not named"}</span>
                    </p>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                      Edit
                    </Button>
                  </div>
                  <p className="mt-1 text-sm">
                    Took {formatMoney(p.funded_amount_cents)}
                    {p.funded_on ? ` on ${formatDate(p.funded_on, today)}` : ""} · owes{" "}
                    <strong>{formatMoney(p.balance_cents)}</strong>
                    {pct !== null ? ` (${pct}% paid down)` : ""}
                  </p>
                  {p.payment_cents !== null ? (
                    <p className="text-sm text-muted">
                      Remittance {remittanceLabel(p.payment_cents, p.frequency, formatMoney)}
                    </p>
                  ) : null}
                  {p.note ? <p className="mt-1 text-sm whitespace-pre-wrap">{p.note}</p> : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {editing ? (
        <PositionDialog
          clientId={clientId}
          existing={editing === "new" ? undefined : editing}
          nextNo={nextPositionNo(positions)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Panel>
  );
}

function PositionDialog({
  clientId,
  existing,
  nextNo,
  onClose,
}: {
  clientId: string;
  existing: PositionRow | undefined;
  nextNo: number;
  onClose: () => void;
}) {
  const run = useRun();
  const toast = useToast();
  const { v, bind } = useFormState<PositionForm>(() => positionForm(existing, nextNo));
  const [busy, setBusy] = useState(false);

  async function save() {
    const problem = positionError(v);
    if (problem) return toast({ message: problem, tone: "error" });
    setBusy(true);
    const ok = await run(
      savePositionAction(positionPayload(clientId, v, existing?.id)),
      existing ? "Position updated" : "Position added",
    );
    setBusy(false);
    if (ok) onClose();
  }

  async function remove() {
    if (!existing) return;
    setBusy(true);
    const ok = await run(deletePositionAction({ id: existing.id }), "Position removed");
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <FormDialog
      title={existing ? "Edit other advance" : "Add other advance"}
      onClose={onClose}
      onSubmit={() => void save()}
      busy={busy}
      wide
      leftFooter={
        existing ? (
          <ConfirmButton
            label="Delete"
            confirmLabel="Click again to delete"
            busy={busy}
            onConfirm={() => void remove()}
          />
        ) : null
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Position (1 = first)">
          <Input
            {...bind("positionNo")}
            type="number"
            min={1}
            max={20}
            inputMode="numeric"
            required
          />
        </Field>
        <Field label="Funder">
          <Input {...bind("funderName")} autoFocus placeholder="Who funded it" />
        </Field>
        <Field label="Advance amount taken" hint="Like 50k or $75,000">
          <Input {...bind("fundedAmount")} inputMode="decimal" />
        </Field>
        <Field label="Total payback (amount × factor)" hint="Needed to show % paid down">
          <Input {...bind("payback")} inputMode="decimal" />
        </Field>
        <Field label="Balance still owed" hint="Blank counts as $0">
          <Input {...bind("balance")} inputMode="decimal" />
        </Field>
        <Field label="Date funded">
          <Input {...bind("fundedOn")} type="date" />
        </Field>
        <Field label="Remittance">
          <Input {...bind("payment")} inputMode="decimal" />
        </Field>
        <Field label="How often">
          <Select {...bind("frequency")}>
            <option value="">—</option>
            {(Object.keys(FREQUENCY_LABELS) as Frequency[]).map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_LABELS[f]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Note">
        <Input {...bind("note")} placeholder="Paying on time? Behind? Wants to renew?" />
      </Field>
      <Muted>Balance is what he owes today — update it when you hear a new number.</Muted>
    </FormDialog>
  );
}
