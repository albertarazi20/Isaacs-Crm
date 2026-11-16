"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { previewFundAction, proposeFundingAction } from "@/app/money-actions";
import { FormDialog, useFormState } from "@/components/client/parts";
import { useApp } from "@/components/app-context";
import { useToast } from "@/components/overlay";
import { Button, Field, Input, Select, Textarea, cn } from "@/components/ui";
import type { FundPreview } from "@/lib/money/fund";
import { formatMoney } from "@/lib/money";

export interface FundLender {
  funderId: string;
  name: string;
  status: string;
  /** The live offer from this lender, to prefill the terms. */
  offer: {
    amount_cents: number;
    factor_rate: number;
    payment_cents: number | null;
    frequency: string | null;
    term_days: number | null;
    position_no: number | null;
  } | null;
}

interface Checklist {
  state: string | null;
  items: { key: string; label: string; required: boolean }[] | null;
}

const FREQ = ["daily", "weekly", "biweekly", "monthly"] as const;

/**
 * The green button. Terms, points and PSF in; the commission out, before anyone commits. A rep's FUND waits for a
 * manager; a manager's FUND confirms in the same click (the action decides).
 */
export function FundDialog({
  clientId,
  businessName,
  lenders,
  canConfirm,
}: {
  clientId: string;
  businessName: string;
  lenders: FundLender[];
  canConfirm: boolean;
}) {
  const { today } = useApp();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<(FundPreview & { checklist: Checklist }) | null>(null);
  const first = lenders.find((l) => l.offer) ?? lenders[0];
  const { v, bind, set } = useFormState(() => ({
    funderId: first?.funderId ?? "",
    funderName: "",
    fundedOn: today,
    amount: first?.offer ? String(first.offer.amount_cents / 100) : "",
    sellRate: first?.offer ? String(first.offer.factor_rate) : "",
    buyRate: "",
    points: "",
    psf: "",
    psfCollectedAt: "at_closing",
    payment: first?.offer?.payment_cents ? String(first.offer.payment_cents / 100) : "",
    frequency: first?.offer?.frequency ?? "daily",
    termDays: first?.offer?.term_days ? String(first.offer.term_days) : "",
    positionNo: first?.offer?.position_no ? String(first.offer.position_no) : "1",
    note: "",
  }));

  const payload = () => ({
    clientId,
    funderId: v.funderId || null,
    funderName: v.funderId ? undefined : v.funderName,
    fundedOn: v.fundedOn,
    amount: v.amount,
    sellRate: v.sellRate,
    buyRate: v.buyRate || null,
    points: v.points || null,
    psf: v.psf || null,
    psfCollectedAt: v.psfCollectedAt,
    payment: v.payment,
    frequency: v.frequency,
    termDays: v.termDays ? Number(v.termDays) : null,
    positionNo: v.positionNo ? Number(v.positionNo) : 1,
    note: v.note,
  });

  function pickLender(id: string) {
    set("funderId", id);
    const l = lenders.find((x) => x.funderId === id);
    if (l?.offer) {
      set("amount", String(l.offer.amount_cents / 100));
      set("sellRate", String(l.offer.factor_rate));
      if (l.offer.payment_cents) set("payment", String(l.offer.payment_cents / 100));
      if (l.offer.frequency) set("frequency", l.offer.frequency);
      if (l.offer.term_days) set("termDays", String(l.offer.term_days));
      if (l.offer.position_no) set("positionNo", String(l.offer.position_no));
    }
    setPreview(null);
  }

  async function doPreview() {
    setBusy(true);
    const r = await previewFundAction(payload());
    setBusy(false);
    if (!r.ok) return toast({ message: r.error, tone: "error" });
    setPreview(r.data as FundPreview & { checklist: Checklist });
  }

  async function submit() {
    setBusy(true);
    const r = await proposeFundingAction(payload());
    setBusy(false);
    if (!r.ok) return toast({ message: r.error, tone: "error" });
    toast({
      message: r.data.confirmed
        ? "Funded and confirmed — the commission is on the ledger"
        : "Funded — a manager confirms it, then the commission posts",
      tone: "success",
    });
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <Button
        variant="primary"
        className="bg-good text-white shadow-good/30 hover:brightness-110"
        onClick={() => setOpen(true)}
      >
        FUND
      </Button>
      {open ? (
        <FormDialog
          title={`Fund ${businessName}`}
          onClose={() => setOpen(false)}
          onSubmit={submit}
          busy={busy}
          submitLabel={canConfirm ? "Fund and confirm" : "Fund (manager confirms)"}
          wide
          leftFooter={
            <Button onClick={doPreview} disabled={busy}>
              Preview commission
            </Button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Lender">
              <Select value={v.funderId} onChange={(e) => pickLender(e.target.value)}>
                {lenders.map((l) => (
                  <option key={l.funderId} value={l.funderId}>
                    {l.name} · {l.status.replace(/_/g, " ")}
                  </option>
                ))}
                <option value="">Other lender…</option>
              </Select>
            </Field>
            {v.funderId === "" ? (
              <Field label="Lender name">
                <Input {...bind("funderName")} placeholder="Who funded it" />
              </Field>
            ) : (
              <Field label="Funded on">
                <Input type="date" {...bind("fundedOn")} />
              </Field>
            )}
            <Field label="Advance amount">
              <Input
                {...bind("amount")}
                placeholder="50,000"
                inputMode="decimal"
                onBlur={() => setPreview(null)}
              />
            </Field>
            <Field label="Sell rate (factor the merchant pays)">
              <Input {...bind("sellRate")} placeholder="1.35" inputMode="decimal" />
            </Field>
            <Field label="Buy rate (lender's factor)">
              <Input {...bind("buyRate")} placeholder="1.28" inputMode="decimal" />
            </Field>
            <Field label="Points (sell − buy, or type them)">
              <Input {...bind("points")} placeholder="7" inputMode="decimal" />
            </Field>
            <Field label="PSF (professional service fee)">
              <Input {...bind("psf")} placeholder="2,500" inputMode="decimal" />
            </Field>
            <Field label="PSF collected">
              <Select {...bind("psfCollectedAt")}>
                <option value="at_closing">At closing</option>
                <option value="from_proceeds">From proceeds</option>
                <option value="none">No PSF</option>
              </Select>
            </Field>
            <Field label="Remittance">
              <Input {...bind("payment")} placeholder="506.25" inputMode="decimal" />
            </Field>
            <Field label="Frequency">
              <Select {...bind("frequency")}>
                {FREQ.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Term (days)">
              <Input {...bind("termDays")} placeholder="120" inputMode="numeric" />
            </Field>
            <Field label="Position">
              <Input {...bind("positionNo")} placeholder="1" inputMode="numeric" />
            </Field>
          </div>
          <Field label="Note">
            <Textarea {...bind("note")} rows={2} placeholder="Anything the ledger should know" />
          </Field>
          {preview ? (
            <div className="rounded-xl border border-border bg-surface-2/60 p-3 text-sm">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted">Payback</dt>
                  <dd className="font-semibold tabular-nums">
                    {formatMoney(preview.paybackCents)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Points</dt>
                  <dd className="font-semibold tabular-nums">{preview.points ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Gross commission</dt>
                  <dd className="font-semibold tabular-nums text-good">
                    {preview.grossCommissionCents === null
                      ? "—"
                      : formatMoney(preview.grossCommissionCents)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Your cut ({preview.splitPct}%)</dt>
                  <dd className="font-semibold tabular-nums">
                    {preview.repCutCents === null ? "—" : formatMoney(preview.repCutCents)}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-muted">
                Net to merchant {formatMoney(preview.netToMerchantCents)}
                {preview.houseCutCents !== null
                  ? ` · house ${formatMoney(preview.houseCutCents)}`
                  : ""}
              </p>
              {preview.warnings.length > 0 ? (
                <ul className="mt-2 space-y-0.5 text-xs text-warn">
                  {preview.warnings.map((w) => (
                    <li key={w}>⚠ {w}</li>
                  ))}
                </ul>
              ) : null}
              {preview.checklist.items?.some((i) => i.required) ? (
                <ul className="mt-2 space-y-0.5 text-xs">
                  {preview.checklist.items
                    .filter((i) => i.required)
                    .map((i) => (
                      <li key={i.key} className={cn("text-muted")}>
                        ☐ {i.label}
                        {preview.checklist.state ? ` (${preview.checklist.state})` : ""}
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted">
              Press Preview commission to see payback, points and your cut before you fund.
            </p>
          )}
        </FormDialog>
      ) : null}
    </>
  );
}
