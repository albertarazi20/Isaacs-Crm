"use client";

import { useState } from "react";
import { deleteOfferAction, saveOfferAction } from "@/app/actions";
import type { OfferRow } from "@/lib/data/types";
import { formatDate } from "@/lib/format";
import type { Frequency } from "@/lib/mca/funding";
import { formatMoney } from "@/lib/money";
import { useApp } from "../app-context";
import { Badge, Button, EmptyState, Field, Input, Select, Textarea } from "../ui";
import {
  formatFactor,
  FREQUENCY_LABELS,
  offerForm,
  offerInsight,
  offerPayload,
  ordinal,
  remittanceLabel,
  type OfferForm,
} from "./logic";
import { ConfirmButton, FormDialog, Panel, useFormState, useRun } from "./parts";

export function OffersCard({
  clientId,
  offers,
  className,
}: {
  clientId: string;
  offers: OfferRow[];
  className?: string;
}) {
  const { today } = useApp();
  const [editing, setEditing] = useState<OfferRow | "new" | null>(null);
  const insight = offerInsight(offers);

  return (
    <Panel
      title="Competing offers"
      className={className}
      aside={
        <Button size="sm" onClick={() => setEditing("new")}>
          + Add
        </Button>
      }
    >
      {offers.length === 0 ? (
        <EmptyState title="No competing offers">
          Log what other funders offered him — it shows what to beat on the next call.
        </EmptyState>
      ) : (
        <>
          {insight ? (
            <p className="rounded-lg bg-surface-2 p-3 text-sm">
              Average factor across {insight.counted} {insight.counted === 1 ? "offer" : "offers"}:{" "}
              <strong>{formatFactor(insight.average)}</strong>
              {insight.low !== insight.high
                ? ` (${formatFactor(insight.low)} to ${formatFactor(insight.high)})`
                : ""}
              {insight.counted < insight.total
                ? ` · ${insight.total - insight.counted} with no factor listed`
                : ""}
            </p>
          ) : null}
          <ul className={insight ? "mt-3 space-y-2" : "space-y-2"}>
            {offers.map((o) => (
              <li key={o.id} className="rounded-lg border border-border p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 font-medium">
                    {o.funder_name}
                    {o.won ? (
                      <Badge tone="warn" className="ml-2">
                        Won the deal
                      </Badge>
                    ) : null}
                  </p>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(o)}>
                    Edit
                  </Button>
                </div>
                <p className="mt-1 text-sm">
                  <strong>{formatMoney(o.amount_cents)}</strong>
                  {o.factor_rate !== null ? ` at ${formatFactor(o.factor_rate)} factor` : ""}
                  {o.payment_cents !== null
                    ? ` · ${remittanceLabel(o.payment_cents, o.frequency, formatMoney)}`
                    : ""}
                </p>
                <p className="text-sm text-muted">
                  {[
                    o.position_no !== null ? `${ordinal(o.position_no)} position` : "",
                    o.term_days !== null ? `${o.term_days}-day term` : "",
                    formatDate(o.offered_on, today),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {o.note ? <p className="mt-1 text-sm whitespace-pre-wrap">{o.note}</p> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {editing ? (
        <OfferDialog
          clientId={clientId}
          existing={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Panel>
  );
}

function OfferDialog({
  clientId,
  existing,
  onClose,
}: {
  clientId: string;
  existing: OfferRow | undefined;
  onClose: () => void;
}) {
  const { today } = useApp();
  const run = useRun();
  const { v, bind, set } = useFormState<OfferForm>(() => offerForm(existing, today));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const ok = await run(
      saveOfferAction(offerPayload(clientId, v, existing?.id)),
      existing ? "Offer updated" : "Offer added",
    );
    setBusy(false);
    if (ok) onClose();
  }

  async function remove() {
    if (!existing) return;
    setBusy(true);
    const ok = await run(deleteOfferAction({ id: existing.id }), "Offer removed");
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <FormDialog
      title={existing ? "Edit competing offer" : "Add competing offer"}
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
        <Field label="Funder" className="sm:col-span-2">
          <Input {...bind("funderName")} required autoFocus placeholder="Who made the offer" />
        </Field>
        <Field label="Advance amount" hint="Like 50k or $75,000">
          <Input {...bind("amount")} inputMode="decimal" />
        </Field>
        <Field label="Factor rate" hint="Like 1.34">
          <Input {...bind("factorRate")} inputMode="decimal" />
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
        <Field label="Position (1 = first)">
          <Input {...bind("positionNo")} type="number" min={1} inputMode="numeric" />
        </Field>
        <Field label="Term (days)">
          <Input {...bind("termDays")} type="number" min={1} inputMode="numeric" />
        </Field>
        <Field label="Offered on">
          <Input {...bind("offeredOn")} type="date" />
        </Field>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="size-5 accent-accent"
          checked={v.won}
          onChange={(e) => set("won", e.target.checked)}
        />
        They won this deal (the merchant took this offer)
      </label>
      <Field label="Note">
        <Textarea {...bind("note")} rows={2} />
      </Field>
    </FormDialog>
  );
}
