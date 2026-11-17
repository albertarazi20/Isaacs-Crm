"use client";

import { useId, useState, type ReactNode } from "react";
import { saveShopSettingsAction } from "@/app/settings-actions";
import { useFormState, useRun } from "@/components/client/parts";
import { Button, cn, Field, Input } from "@/components/ui";
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
  // what the server last accepted, so the bar can say whether anything is waiting to be saved
  const [saved, setSaved] = useState(() => JSON.stringify(v));
  const dirty = JSON.stringify(v) !== saved;
  return (
    <form
      id={formId}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const sent = JSON.stringify(v);
        const ok = await run(saveShopSettingsAction(v), "Saved");
        setBusy(false);
        if (ok) setSaved(sent);
      }}
    >
      <SettingsCard
        title="The shop"
        description="Who the automated emails come from, and what goes in every footer."
        flush
      >
        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
          <Field label="Shop name" hint="Shown in every footer.">
            <Input {...bind("shopName")} />
          </Field>
          <Field label="Postal address" hint="CAN-SPAM: automation stays off until this is filled.">
            <Input {...bind("postalAddress")} placeholder="123 Main St, Suite 4, Miami, FL 33101" />
          </Field>
          <Field
            label="Automation sender"
            hint="Sent through Resend, from your own subdomain."
            className="sm:col-span-2"
          >
            <Input
              {...bind("automationFrom")}
              placeholder="Selective Capital <hello@mail.selectivecap.com>"
            />
          </Field>
        </div>
        <div className="border-t border-border px-4 py-2 sm:px-5">
          <Toggle
            label="Replies go to the rep"
            hint="Automated emails carry the rep's address as Reply-To."
            checked={v.automationReplyToRep}
            onChange={(x) => set("automationReplyToRep", x)}
          />
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
      <SettingsCard
        title="When emails go out"
        description="The hours and days the engine may send, in each merchant's own local time."
        flush
      >
        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
          <Field label="Window starts" hint="The merchant's local hour, 0 to 23.">
            <Input {...bind("sendWindowStart")} inputMode="numeric" />
          </Field>
          <Field label="Window ends" hint="Nothing goes out after this hour.">
            <Input {...bind("sendWindowEnd")} inputMode="numeric" />
          </Field>
        </div>
        <div className="divide-y divide-border border-t border-border px-4 sm:px-5">
          <Toggle
            label="Send on weekends"
            hint="Off = Saturday and Sunday are skipped."
            checked={v.sendOnWeekends}
            onChange={(x) => set("sendOnWeekends", x)}
            className="py-2"
          />
          <Toggle
            label="Send on US holidays"
            hint="Off = federal holidays are skipped, like a weekend."
            checked={v.sendOnHolidays}
            onChange={(x) => set("sendOnHolidays", x)}
            className="py-2"
          />
          <Toggle
            label="Sequences slow down"
            hint="Off = the same template every day until they act."
            checked={v.sequencesEnabled}
            onChange={(x) => set("sequencesEnabled", x)}
            className="py-2"
          />
        </div>
      </SettingsCard>
      {/* One save for the three topics above. It rides the bottom of the window while they are on screen. */}
      <div className="pointer-events-none sticky bottom-3 z-20 flex justify-end pb-1 xl:pl-[calc(17rem+2.5rem)]">
        <div
          className={cn(
            "glass-strong pointer-events-auto flex w-full items-center justify-between gap-3 rounded-full border py-1.5 pr-1.5 pl-4 shadow-pop transition-colors duration-200",
            dirty ? "border-accent/40" : "border-border",
          )}
        >
          <p className="flex min-w-0 items-center gap-2 text-[13px]">
            <span
              aria-hidden
              className={cn("size-2 shrink-0 rounded-full", dirty ? "bg-accent" : "bg-good")}
            />
            <span className="truncate font-medium">
              {dirty ? "Unsaved changes" : "Everything is saved"}
            </span>
            <span className="hidden truncate text-muted sm:inline">
              {dirty
                ? "The shop, the cap and the sending window save together."
                : "The shop, the cap and the sending window."}
            </span>
          </p>
          <Button type="submit" form={formId} variant="primary" disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </div>
    </form>
  );
}
