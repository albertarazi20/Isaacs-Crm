"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import {
  confirmFundingAction,
  recordCommissionPaidAction,
  startRenewalAction,
} from "@/app/money-actions";
import { FormDialog, useFormState, useRun } from "@/components/client/parts";
import { useCall } from "@/components/overlay";
import { SHEET } from "@/components/settings/primitives";
import { Badge, Button, Card, EmptyState, Field, Input, cn } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { formatMoney, formatMoneyCompact } from "@/lib/money";
import type { FundedRow } from "@/lib/money/fund";
import type { FundingExtra } from "@/lib/money/fundedExtras";
import { CorrectDialog } from "./CorrectDialog";
import { FundingDetail } from "./FundingDetail";

const STATE_TONE: Record<string, "neutral" | "warn" | "good" | "bad"> = {
  expected: "neutral",
  at_risk: "warn",
  paid: "good",
  clear: "good",
  clawed_back: "bad",
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

/** "42%" with a thin, quiet bar beside it. */
function PaidIn({ pct }: { pct: number }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span
        aria-hidden
        className="hidden h-1 w-12 overflow-hidden rounded-full bg-surface-2 sm:inline-block"
      >
        <span
          className="block h-full rounded-full bg-accent/70"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </span>
      <span className="tabular-nums">{pct}%</span>
    </span>
  );
}

/** The month's advances as one dense sheet: money right-aligned, the ledger state as a word, actions last. */
export function FundedSheet({
  rows,
  manager,
  today,
  extras = {},
}: {
  rows: FundedRow[];
  manager: boolean;
  today: string;
  extras?: Record<string, FundingExtra>;
}) {
  const run = useRun();
  const call = useCall();
  const router = useRouter();
  const [paying, setPaying] = useState<FundedRow | null>(null);
  const [correcting, setCorrecting] = useState<FundedRow | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const renew = async (r: FundedRow) => {
    setBusy(true);
    const d = await call(startRenewalAction({ fundingId: r.id }), "Renewal started");
    setBusy(false);
    if (d) router.push(`/deals/${d.dealId}`);
  };
  if (rows.length === 0)
    return (
      <EmptyState title="Nothing funded this month">
        Press FUND on a deal and it lands here with its commission.
      </EmptyState>
    );
  return (
    <Card className="min-w-0 overflow-x-auto p-0">
      <table className={SHEET.table}>
        <thead className={SHEET.thead}>
          <tr>
            <th className={cn(SHEET.th, "sticky left-0 z-10 bg-surface-3")}>Merchant</th>
            <th className={SHEET.th}>Lender</th>
            <th className={SHEET.thNum}>Funded</th>
            <th className={SHEET.thNum}>Factor</th>
            <th className={SHEET.thNum}>Points</th>
            <th className={SHEET.thNum}>PSF</th>
            <th className={SHEET.thNum}>Commission</th>
            <th className={SHEET.thNum}>{manager ? "Rep cut" : "My cut"}</th>
            <th className={SHEET.thNum}>Paid in</th>
            <th className={SHEET.th}>Ledger</th>
            <th className={SHEET.th}></th>
          </tr>
        </thead>
        <tbody className={SHEET.tbody}>
          {rows.map((r) => {
            const x = extras[r.id];
            const late = x?.late_days !== null && x?.late_days !== undefined && x.late_days > 0;
            const expanded = open === r.id;
            return (
              <Fragment key={r.id}>
                <tr className="group transition hover:bg-surface-3">
                  <td
                    className={cn(
                      SHEET.td,
                      "sticky left-0 z-10 max-w-56 bg-surface transition group-hover:bg-surface-3",
                    )}
                  >
                    <Link
                      href={r.deal_id ? `/deals/${r.deal_id}` : `/clients/${r.client_id}`}
                      className="block truncate font-semibold hover:underline"
                    >
                      {r.business_name}
                    </Link>
                    <span className="block truncate text-xs text-muted">
                      {formatDate(r.funded_on, today)}
                      {manager ? ` · ${r.rep_name}` : ""}
                      {r.renewal_eligible_on
                        ? ` · renews ${formatDate(r.renewal_eligible_on, today)}`
                        : ""}
                    </span>
                    {x?.eligible_more || (x?.corrections.length ?? 0) > 0 ? (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {x?.eligible_more ? (
                          <Badge tone="accent">Eligible for more funds</Badge>
                        ) : null}
                        {(x?.corrections.length ?? 0) > 0 ? (
                          <Badge tone="neutral">Corrected</Badge>
                        ) : null}
                      </span>
                    ) : null}
                  </td>
                  <td className={cn(SHEET.td, "whitespace-nowrap")}>{r.funder_name || "—"}</td>
                  <td className={SHEET.tdNum}>{formatMoneyCompact(r.amount_cents)}</td>
                  <td className={SHEET.tdNum}>{Number(r.factor_rate).toFixed(2)}</td>
                  <td className={SHEET.tdNum}>{r.points ?? "—"}</td>
                  <td className={SHEET.tdNum}>
                    {r.psf_cents ? formatMoneyCompact(r.psf_cents) : "—"}
                  </td>
                  <td className={cn(SHEET.tdNum, "font-semibold")}>
                    {r.commission_cents === null ? "—" : formatMoney(r.commission_cents)}
                  </td>
                  <td className={SHEET.tdNum}>
                    {r.rep_cut_cents === null ? "—" : formatMoney(r.rep_cut_cents)}
                  </td>
                  <td className={SHEET.tdNum}>
                    <PaidIn pct={r.paid_pct} />
                  </td>
                  <td className={SHEET.td}>
                    <span className="flex flex-col items-start gap-1">
                      {r.confirmed_at ? (
                        <Badge tone={STATE_TONE[r.ledger_state] ?? "neutral"}>
                          {r.ledger_state.replace("_", " ")}
                          {r.commission_received_cents &&
                          r.commission_cents &&
                          r.commission_received_cents < r.commission_cents
                            ? " (short)"
                            : ""}
                        </Badge>
                      ) : (
                        <Badge tone="warn">needs confirm</Badge>
                      )}
                      {late ? <Badge tone="bad">Lender late · {x?.late_days}d</Badge> : null}
                    </span>
                  </td>
                  <td className={cn(SHEET.td, "text-right whitespace-nowrap")}>
                    {manager && !r.confirmed_at ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          const ok = await run(
                            confirmFundingAction({ fundingId: r.id }),
                            "Confirmed",
                          );
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
                    {x?.eligible_more && !x.open_deal_id ? (
                      <Button size="sm" className="ml-1.5" disabled={busy} onClick={() => renew(r)}>
                        Start renewal
                      </Button>
                    ) : null}
                    {x?.eligible_more && x.open_deal_id ? (
                      <Link
                        href={`/deals/${x.open_deal_id}`}
                        className="ml-1.5 text-xs font-medium text-accent hover:underline"
                      >
                        Deal D-{x.open_deal_number} open
                      </Link>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-1.5"
                      aria-expanded={expanded}
                      aria-label={`Details for ${r.business_name}`}
                      onClick={() => setOpen(expanded ? null : r.id)}
                    >
                      Details
                    </Button>
                  </td>
                </tr>
                {expanded ? (
                  <tr className="bg-surface-3/50">
                    <td colSpan={11} className="px-4 py-3">
                      <FundingDetail
                        row={r}
                        extra={x}
                        today={today}
                        manager={manager}
                        onCorrect={() => setCorrecting(r)}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {paying ? <PaidDialog row={paying} onClose={() => setPaying(null)} /> : null}
      {correcting ? <CorrectDialog row={correcting} onClose={() => setCorrecting(null)} /> : null}
    </Card>
  );
}
