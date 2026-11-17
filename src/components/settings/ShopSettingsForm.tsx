"use client";

import { useId, useState, type ReactNode } from "react";
import { saveShopSettingsAction } from "@/app/settings-actions";
import { useFormState, useRun } from "@/components/client/parts";
import { Button, Field, Input } from "@/components/ui";
import type { ShopSettingsRow } from "@/lib/settings/queries";
import { SettingsCard } from "./primitives";
import { Toggle } from "./Toggle";

export function ShopSettingsForm({
  s,
  afterShop,
}: {
  s: ShopSettingsRow;
  /** A card that belongs right under "The shop" (the DNS check reads the sender typed there). */
  afterShop?: ReactNode;
}) {
  const run = useRun();
  const formId = useId();
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
    sendOnHolidays: s.send_on_holidays,
    perMerchantDaily: String(s.per_merchant_daily),
    perMerchantWeekly: String(s.per_merchant_weekly),
    automationFrom: s.automation_from,
    automationReplyToRep: s.automation_reply_to_rep,
  }));
  const save = (
    <Button type="submit" form={formId} variant="primary" disabled={busy}>
      {busy ? "Saving…" : "Save settings"}
    </Button>
  );
  return (
    <form
      id={formId}
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await run(saveShopSettingsAction(v), "Saved");
        setBusy(false);
      }}
    >
      <SettingsCard title="The shop">
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
          <div className="flex items-end">
            <Toggle
              label="Replies go to the rep"
              hint="Automated emails carry the rep's address as Reply-To"
              checked={v.automationReplyToRep}
              onChange={(x) => set("automationReplyToRep", x)}
            />
          </div>
        </div>
      </SettingsCard>
      {afterShop}
      <SettingsCard
        title="The cap"
        description="Per mailbox, rolling 24 hours. Google Workspace allows 2,000; 1,500 keeps a margin. Lead-intake emails use the reserved slice and never wait."
      >
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
      </SettingsCard>
      <SettingsCard title="When emails go out" footer={save}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Window starts (merchant's local hour)">
            <Input {...bind("sendWindowStart")} inputMode="numeric" />
          </Field>
          <Field label="Window ends">
            <Input {...bind("sendWindowEnd")} inputMode="numeric" />
          </Field>
          <div className="space-y-2 sm:col-span-3">
            <Toggle
              label="Send on weekends"
              checked={v.sendOnWeekends}
              onChange={(x) => set("sendOnWeekends", x)}
            />
            <Toggle
              label="Send on US holidays"
              hint="Off = federal holidays are skipped, like a weekend"
              checked={v.sendOnHolidays}
              onChange={(x) => set("sendOnHolidays", x)}
            />
            <Toggle
              label="Sequences slow down"
              hint="Off = the same template every day until they act"
              checked={v.sequencesEnabled}
              onChange={(x) => set("sequencesEnabled", x)}
            />
          </div>
        </div>
      </SettingsCard>
    </form>
  );
}
