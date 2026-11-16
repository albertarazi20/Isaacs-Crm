"use client";

import { useId, useState } from "react";
import { saveAiSettingsAction } from "@/app/settings-actions";
import { useFormState, useRun } from "@/components/client/parts";
import { Button, Field, Input, Select } from "@/components/ui";
import type { ShopSettingsRow } from "@/lib/settings/queries";
import { SettingsCard } from "./primitives";
import { Toggle } from "./Toggle";

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

export function AiSettingsForm({ s }: { s: ShopSettingsRow }) {
  const run = useRun();
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const { v, bind, set } = useFormState(() => ({
    aiEnabled: s.ai_enabled,
    aiModel: s.ai_model,
    aiDailyCapCents: String(s.ai_daily_cap_cents),
    aiAutoApplyLowStakes: s.ai_auto_apply_low_stakes,
    winbackOpenerMode: s.winback_opener_mode,
  }));
  return (
    <SettingsCard
      title="What the AI may do"
      footer={
        <Button type="submit" form={formId} variant="primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      }
    >
      <form
        id={formId}
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await run(saveAiSettingsAction(v), "Saved");
          setBusy(false);
        }}
      >
        <div className="space-y-3">
          <Toggle
            label="AI on"
            hint="— the kill switch. Off, nothing is read or drafted."
            checked={v.aiEnabled}
            onChange={(x) => set("aiEnabled", x)}
          />
          <Toggle
            label="Apply low-stakes reads on its own"
            hint={`— "docs received", "stips requested". Money and status still wait for a manager.`}
            checked={v.aiAutoApplyLowStakes}
            onChange={(x) => set("aiAutoApplyLowStakes", x)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Model for reading lender email">
            <Select {...bind("aiModel")}>
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Daily spend cap (cents)">
            <Input {...bind("aiDailyCapCents")} inputMode="numeric" />
          </Field>
          <Field
            label="Win-back opening line"
            hint="The first line Claude drafts for each merchant in a win-back pool"
          >
            <Select {...bind("winbackOpenerMode")}>
              <option value="review">Review: a manager reads each line first</option>
              <option value="auto">Auto: use the line as drafted</option>
            </Select>
          </Field>
        </div>
      </form>
    </SettingsCard>
  );
}
