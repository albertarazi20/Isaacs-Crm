"use client";

import { useState } from "react";
import { saveAskAction } from "@/app/actions";
import type { AskRow } from "@/lib/data/types";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { useApp } from "../app-context";
import { Button, Field, Input } from "../ui";
import { askForm, dateInTz, type AskForm } from "./logic";
import { FormDialog, Muted, Panel, useFormState, useRun } from "./parts";

export function AskCard({
  clientId,
  asks,
  className,
}: {
  clientId: string;
  asks: AskRow[];
  className?: string;
}) {
  const { today, timezone } = useApp();
  const [editing, setEditing] = useState(false);
  const [current, ...earlier] = asks;
  const hasAsk = current !== undefined;

  return (
    <Panel
      title="The ask"
      className={className}
      aside={
        <Button size="sm" onClick={() => setEditing(true)}>
          {hasAsk ? "Edit" : "Record the ask"}
        </Button>
      }
    >
      {current ? (
        <dl className="space-y-3">
          <div>
            <dt className="text-xs text-muted">How much he wants now</dt>
            <dd className="text-lg font-semibold">{formatMoney(current.wanted_amount_cents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">The offer he wants (terms)</dt>
            <dd className="text-sm whitespace-pre-wrap">
              {current.wanted_terms || <span className="text-muted">Not recorded</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">What I think funders would approve</dt>
            <dd className="text-lg font-semibold">{formatMoney(current.est_approval_cents)}</dd>
            {current.est_approval_note ? (
              <dd className="mt-0.5 text-sm whitespace-pre-wrap">{current.est_approval_note}</dd>
            ) : null}
          </div>
        </dl>
      ) : (
        <p className="text-sm text-muted">
          Nothing recorded yet. Write down how much he wants, the offer he wants, and what you think
          funders would approve, so you can compare it on the next call.
        </p>
      )}
      {earlier.length > 0 ? (
        <details className="mt-3 border-t border-border pt-3">
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-text">
            How much he wanted in the past ({earlier.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {earlier.map((a) => (
              <li key={a.id} className="rounded-lg bg-surface-2 p-2.5 text-sm">
                <p className="text-xs text-muted">
                  {formatDate(dateInTz(a.created_at, timezone), today)}
                </p>
                <p>
                  Wanted <strong>{formatMoney(a.wanted_amount_cents)}</strong>
                  {a.wanted_terms ? ` — ${a.wanted_terms}` : ""}
                </p>
                {a.est_approval_cents !== null || a.est_approval_note ? (
                  <p className="text-muted">
                    Thought approvable: {formatMoney(a.est_approval_cents)}
                    {a.est_approval_note ? ` — ${a.est_approval_note}` : ""}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {editing ? (
        <AskDialog clientId={clientId} current={current} onClose={() => setEditing(false)} />
      ) : null}
    </Panel>
  );
}

function AskDialog({
  clientId,
  current,
  onClose,
}: {
  clientId: string;
  current: AskRow | undefined;
  onClose: () => void;
}) {
  const run = useRun();
  const { v, bind } = useFormState<AskForm>(() => askForm(current));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const ok = await run(saveAskAction({ clientId, ...v }), "Ask saved");
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <FormDialog title="The ask" onClose={onClose} onSubmit={() => void save()} busy={busy}>
      <Field label="How much he wants" hint="Like 50k or $75,000">
        <Input {...bind("wantedAmount")} inputMode="decimal" autoFocus />
      </Field>
      <Field label="The offer he wants (terms)">
        <Input {...bind("wantedTerms")} placeholder="Payroll, 6 months, daily remittances" />
      </Field>
      <Field label="What I think funders would approve">
        <Input {...bind("estApproval")} inputMode="decimal" />
      </Field>
      <Field label="Why (optional)">
        <Input
          {...bind("estApprovalNote")}
          placeholder="Strong deposits, but two positions already"
        />
      </Field>
      <Muted>
        Saving adds a new entry. What he wanted before stays in the history, so you can see how his
        ask has changed.
      </Muted>
    </FormDialog>
  );
}
