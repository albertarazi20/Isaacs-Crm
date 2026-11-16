"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { saveCommissionPlanAction } from "@/app/settings-actions";
import { useApp } from "@/components/app-context";
import { useFormState, useRun } from "@/components/client/parts";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import type { PlanRow } from "@/lib/settings/queries";
import { SettingsCard } from "./primitives";

export function PlanForm({
  reps,
  base,
}: {
  reps: { id: string; name: string }[];
  base: PlanRow | null;
}) {
  const { today } = useApp();
  const run = useRun();
  const router = useRouter();
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const { v, bind } = useFormState(() => ({
    userId: base?.user_id ?? "",
    effectiveFrom: today,
    splitPct: String(base?.split_pct ?? 50),
    selfGenSplitPct:
      base?.self_gen_split_pct === null || base?.self_gen_split_pct === undefined
        ? ""
        : String(base.self_gen_split_pct),
    psfSharePct: String(base?.psf_share_pct ?? 0),
    renewalSplitPct:
      base?.renewal_split_pct === null || base?.renewal_split_pct === undefined
        ? ""
        : String(base.renewal_split_pct),
    tier1From: base?.tiers[0] ? String(base.tiers[0].from_cents / 100) : "",
    tier1Pct: base?.tiers[0] ? String(base.tiers[0].split_pct) : "",
    tier2From: base?.tiers[1] ? String(base.tiers[1].from_cents / 100) : "",
    tier2Pct: base?.tiers[1] ? String(base.tiers[1].split_pct) : "",
    managerOverridePct: String(base?.manager_override_pct ?? 0),
    clawbackBorneBy: base?.clawback_borne_by ?? "rep",
    note: "",
  }));
  return (
    <SettingsCard
      title="New plan row"
      description="Plans are kept by effective date; a new row never rewrites an old funding's split."
      footer={
        <Button type="submit" form={formId} variant="primary" disabled={busy}>
          {busy ? "Saving…" : "Save plan"}
        </Button>
      }
    >
      <form
        id={formId}
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const tiers = [
            v.tier1From && v.tier1Pct
              ? { fromAmount: Number(v.tier1From), splitPct: Number(v.tier1Pct) }
              : null,
            v.tier2From && v.tier2Pct
              ? { fromAmount: Number(v.tier2From), splitPct: Number(v.tier2Pct) }
              : null,
          ].filter(Boolean);
          const ok = await run(
            saveCommissionPlanAction({
              userId: v.userId || null,
              effectiveFrom: v.effectiveFrom,
              splitPct: v.splitPct,
              selfGenSplitPct: v.selfGenSplitPct || null,
              psfSharePct: v.psfSharePct || 0,
              renewalSplitPct: v.renewalSplitPct || null,
              tiers,
              managerOverridePct: v.managerOverridePct || 0,
              clawbackBorneBy: v.clawbackBorneBy,
              note: v.note,
            }),
            "Plan saved",
          );
          setBusy(false);
          if (ok) router.refresh();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Applies to">
            <Select {...bind("userId")}>
              <option value="">The whole shop (default)</option>
              {reps.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Effective from">
            <Input type="date" {...bind("effectiveFrom")} />
          </Field>
          <Field label="Rep split %">
            <Input {...bind("splitPct")} inputMode="decimal" />
          </Field>
          <Field label="Self-generated split % (own form / referral)">
            <Input {...bind("selfGenSplitPct")} inputMode="decimal" placeholder="same" />
          </Field>
          <Field label="Rep's share of the PSF %">
            <Input {...bind("psfSharePct")} inputMode="decimal" />
          </Field>
          <Field label="Renewal split %">
            <Input {...bind("renewalSplitPct")} inputMode="decimal" placeholder="same" />
          </Field>
          <Field label="Tier 1: from $ funded in the month">
            <Input {...bind("tier1From")} inputMode="decimal" placeholder="250000" />
          </Field>
          <Field label="Tier 1 split %">
            <Input {...bind("tier1Pct")} inputMode="decimal" placeholder="55" />
          </Field>
          <Field label="Manager override %">
            <Input {...bind("managerOverridePct")} inputMode="decimal" />
          </Field>
          <Field label="Tier 2: from $">
            <Input {...bind("tier2From")} inputMode="decimal" placeholder="500000" />
          </Field>
          <Field label="Tier 2 split %">
            <Input {...bind("tier2Pct")} inputMode="decimal" placeholder="60" />
          </Field>
          <Field label="Clawback borne by">
            <Select {...bind("clawbackBorneBy")}>
              <option value="rep">The rep</option>
              <option value="house">The house</option>
              <option value="split">Split the same way</option>
            </Select>
          </Field>
        </div>
        <Field label="Note">
          <Textarea {...bind("note")} rows={2} className="min-h-16" />
        </Field>
      </form>
    </SettingsCard>
  );
}
