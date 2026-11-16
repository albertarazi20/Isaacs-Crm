"use client";

import { useState } from "react";
import { saveShopSettingsAction } from "@/app/settings-actions";
import { useFormState, useRun } from "@/components/client/parts";
import { Button, Card, Field, Input, SectionTitle, Select } from "@/components/ui";
import type { ShopSettingsRow } from "@/lib/settings/queries";

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="font-medium">{label}</span>
        {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

export function ShopSettingsForm({ s }: { s: ShopSettingsRow }) {
  const run = useRun();
  const [busy, setBusy] = useState(false);
  const { v, bind, set } = useFormState(() => ({
    shopName: s.shop_name,
    postalAddress: s.postal_address,
    dailyCap: String(s.daily_cap),
    amberAt: String(s.amber_at),
    reservedForIntake: String(s.reserved_for_intake),
    sequencesEnabled: s.sequences_enabled,
    sendWindowStart: String(s.send_window_start),
    sendWindowEnd: String(s.send_window_end),
    sendOnWeekends: s.send_on_weekends,
    perMerchantDaily: String(s.per_merchant_daily),
    perMerchantWeekly: String(s.per_merchant_weekly),
    automationFrom: s.automation_from,
    automationReplyToRep: s.automation_reply_to_rep,
    lenderChaseDays: String(s.lender_chase_days),
    lenderChaseMode: s.lender_chase_mode,
    lenderChaseMax: String(s.lender_chase_max),
    maxLendersPerDeal: String(s.max_lenders_per_deal),
  }));
  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await run(saveShopSettingsAction(v), "Saved");
        setBusy(false);
      }}
    >
      <Card className="space-y-3">
        <SectionTitle>The shop</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Shop name (in every footer)">
            <Input {...bind("shopName")} />
          </Field>
          <Field label="Postal address (CAN-SPAM — automation stays off until this is filled)">
            <Input {...bind("postalAddress")} placeholder="123 Main St, Suite 4, Miami, FL 33101" />
          </Field>
          <Field label="Automation sender (Resend, on your subdomain)">
            <Input
              {...bind("automationFrom")}
              placeholder="Selective Capital <hello@mail.selectivecap.com>"
            />
          </Field>
          <div className="pt-6">
            <Toggle
              label="Replies go to the rep"
              hint="Automated emails carry the rep's address as Reply-To"
              checked={v.automationReplyToRep}
              onChange={(x) => set("automationReplyToRep", x)}
            />
          </div>
        </div>
      </Card>
      <Card className="space-y-3">
        <SectionTitle>The cap</SectionTitle>
        <p className="text-xs text-muted">
          Per mailbox, rolling 24 hours. Google Workspace allows 2,000; 1,500 keeps a margin.
          Lead-intake emails use the reserved slice and never wait.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Daily cap">
            <Input {...bind("dailyCap")} inputMode="numeric" />
          </Field>
          <Field label="Amber warning at">
            <Input {...bind("amberAt")} inputMode="numeric" />
          </Field>
          <Field label="Reserved for lead intake">
            <Input {...bind("reservedForIntake")} inputMode="numeric" />
          </Field>
          <Field label="Per merchant per day">
            <Input {...bind("perMerchantDaily")} inputMode="numeric" />
          </Field>
          <Field label="Per merchant per week">
            <Input {...bind("perMerchantWeekly")} inputMode="numeric" />
          </Field>
        </div>
      </Card>
      <Card className="space-y-3">
        <SectionTitle>When emails go out</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Window starts (merchant's local hour)">
            <Input {...bind("sendWindowStart")} inputMode="numeric" />
          </Field>
          <Field label="Window ends">
            <Input {...bind("sendWindowEnd")} inputMode="numeric" />
          </Field>
          <div className="space-y-2 pt-6">
            <Toggle
              label="Send on weekends"
              checked={v.sendOnWeekends}
              onChange={(x) => set("sendOnWeekends", x)}
            />
            <Toggle
              label="Sequences slow down"
              hint="Off = the same template every day until they act"
              checked={v.sequencesEnabled}
              onChange={(x) => set("sequencesEnabled", x)}
            />
          </div>
        </div>
      </Card>
      <Card className="space-y-3">
        <SectionTitle>Lenders</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Chase a quiet lender after (days)">
            <Input {...bind("lenderChaseDays")} inputMode="numeric" />
          </Field>
          <Field label="Chases per lender, max">
            <Input {...bind("lenderChaseMax")} inputMode="numeric" />
          </Field>
          <Field label="Auto-chase">
            <Select {...bind("lenderChaseMode")}>
              <option value="send">Send from the rep&apos;s Gmail</option>
              <option value="off">Off</option>
            </Select>
          </Field>
          <Field label="Shotgun limit (lenders per file)">
            <Input {...bind("maxLendersPerDeal")} inputMode="numeric" />
          </Field>
        </div>
      </Card>
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? "Saving…" : "Save settings"}
      </Button>
    </form>
  );
}
