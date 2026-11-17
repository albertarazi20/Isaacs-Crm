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
            hint="— the kill switch. Off, no reply is tagged and no lead line is split."
            checked={v.aiEnabled}
            onChange={(x) => set("aiEnabled", x)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Model">
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
        </div>
      </form>
    </SettingsCard>
  );
}
