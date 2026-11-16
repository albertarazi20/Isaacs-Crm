"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { confirmFundingAction, recordCommissionPaidAction } from "@/app/money-actions";
import { FormDialog, useFormState, useRun } from "@/components/client/parts";
import { Button, Card, EmptyState, Field, Input, cn } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { formatMoney, formatMoneyCompact } from "@/lib/money";
import type { FundedRow } from "@/lib/money/fund";

const STATE_TONE: Record<string, string> = {
  expected: "bg-surface-2 text-muted",
  at_risk: "bg-warn-soft text-warn",
  paid: "bg-good-soft text-good",
  clear: "bg-good-soft text-good",
  clawed_back: "bg-bad-soft text-bad",
};

function PaidDialog({ row, onClose }: { row: FundedRow; onClose: () => void }) {
  const run = useRun();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { v, bind } = useFormState(() => ({
    amount: row.commission_cents ? String(row.commission_cents / 100) : "",
    on: "",
    note: "",
  }));
  return (
    <FormDialog
      title={`Commission paid — ${row.business_name}`}
      onClose={onClose}
      busy={busy}
      submitLabel="Record payment"
      onSubmit={async () => {
        setBusy(true);
        const ok = await run(
          recordCommissionPaidAction({
            fundingId: row.id,
            amount: v.amount,
            on: v.on || undefined,
            note: v.note,
          }),
          "Payment recorded",
        );
        setBusy(false);
        if (ok) {
          onClose();
          router.refresh();
        }
      }}
    >
      <Field label="Amount the lender paid">
        <Input {...bind("amount")} inputMode="decimal" />
      </Field>
      <Field label="Paid on (blank = today)">
        <Input type="date" {...bind("on")} />
      </Field>
      <Field label="Note">
        <Input {...bind("note")} placeholder="Short pay? Say why." />
      </Field>
    </FormDialog>
  );
}

export function FundedSheet({
  rows,
  manager,
  today,
}: {
  rows: FundedRow[];
  manager: boolean;
  today: string;
}) {
  const run = useRun();
  const router = useRouter();
  const [paying, setPaying] = useState<FundedRow | null>(null);
  const [busy, setBusy] = useState(false);
  if (rows.length === 0)
    return (
      <EmptyState title="Nothing funded this month">
        Press FUND on a deal and it lands here with its commission.
      </EmptyState>
    );
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Merchant</th>
            <th className="px-2 py-2 font-medium">Lender</th>
            <th className="px-2 py-2 text-right font-medium">Funded</th>
            <th className="px-2 py-2 text-right font-medium">Factor</th>
            <th className="px-2 py-2 text-right font-medium">Points</th>
            <th className="px-2 py-2 text-right font-medium">PSF</th>
            <th className="px-2 py-2 text-right font-medium">Commission</th>
            <th className="px-2 py-2 text-right font-medium">{manager ? "Rep cut" : "My cut"}</th>
            <th className="px-2 py-2 text-right font-medium">Paid in</th>
            <th className="px-2 py-2 font-medium">Ledger</th>
            <th className="px-4 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.id} className={cn(!r.confirmed_at && "bg-warn-soft/40")}>
              <td className="px-4 py-2">
                <Link
                  href={r.deal_id ? `/deals/${r.deal_id}` : `/clients/${r.client_id}`}
                  className="font-semibold hover:underline"
                >
                  {r.business_name}
                </Link>
                <span className="block text-xs text-muted">
                  {formatDate(r.funded_on, today)}
                  {manager ? ` · ${r.rep_name}` : ""}
                  {r.renewal_eligible_on
                    ? ` · renews ${formatDate(r.renewal_eligible_on, today)}`
                    : ""}
                </span>
              </td>
              <td className="px-2 py-2">{r.funder_name || "—"}</td>
              <td className="px-2 py-2 text-right tabular-nums">
                {formatMoneyCompact(r.amount_cents)}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {Number(r.factor_rate).toFixed(2)}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{r.points ?? "—"}</td>
              <td className="px-2 py-2 text-right tabular-nums">
                {r.psf_cents ? formatMoneyCompact(r.psf_cents) : "—"}
              </td>
              <td className="px-2 py-2 text-right tabular-nums font-semibold">
                {r.commission_cents === null ? "—" : formatMoney(r.commission_cents)}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {r.rep_cut_cents === null ? "—" : formatMoney(r.rep_cut_cents)}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{r.paid_pct}%</td>
              <td className="px-2 py-2">
                {r.confirmed_at ? (
                  <span
                    className={cn(
                      "rounded-md px-2 py-0.5 text-[11px] font-semibold",
                      STATE_TONE[r.ledger_state] ?? "",
                    )}
                  >
                    {r.ledger_state.replace("_", " ")}
                    {r.commission_received_cents &&
                    r.commission_cents &&
                    r.commission_received_cents < r.commission_cents
                      ? " (short)"
                      : ""}
                  </span>
                ) : (
                  <span className="rounded-md bg-warn-soft px-2 py-0.5 text-[11px] font-semibold text-warn">
                    needs confirm
                  </span>
                )}
              </td>
              <td className="px-4 py-2 text-right whitespace-nowrap">
                {manager && !r.confirmed_at ? (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      const ok = await run(confirmFundingAction({ fundingId: r.id }), "Confirmed");
                      setBusy(false);
                      if (ok) router.refresh();
                    }}
                  >
                    Confirm
                  </Button>
                ) : null}
                {manager &&
                r.confirmed_at &&
                r.ledger_state !== "paid" &&
                r.ledger_state !== "clawed_back" ? (
                  <Button size="sm" onClick={() => setPaying(r)}>
                    Paid
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {paying ? <PaidDialog row={paying} onClose={() => setPaying(null)} /> : null}
    </Card>
  );
}
