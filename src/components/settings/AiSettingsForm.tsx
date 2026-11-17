"use client";

import { useId, useState } from "react";
import { saveAiSettingsAction } from "@/app/settings-actions";
import { useFormState, useRun } from "@/components/client/parts";
import { Button, Field, Input, Select } from "@/components/ui";
import type { ShopSettingsRow } from "@/lib/settings/queries";
import { SettingsCard, StatusChip } from "./primitives";
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
  const [saved, setSaved] = useState(() => JSON.stringify(v));
  const dirty = JSON.stringify(v) !== saved;
  const cap = Number(v.aiDailyCapCents);
  return (
    <SettingsCard
      title="What the AI may do"
      description="One switch turns it all off. The model does the reading; the cap stops the day's spend."
      aside={
        v.aiEnabled ? (
          <StatusChip tone="good">On</StatusChip>
        ) : (
          <StatusChip tone="warn">Off</StatusChip>
        )
      }
      flush
      footer={
        <>
          <span className="mr-auto text-xs font-medium text-accent">
            {dirty ? "Unsaved changes" : null}
          </span>
          <Button type="submit" form={formId} variant="primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const sent = JSON.stringify(v);
          const ok = await run(saveAiSettingsAction(v), "Saved");
          setBusy(false);
          if (ok) setSaved(sent);
        }}
      >
        <div className="px-4 py-2 sm:px-5">
          <Toggle
            label="AI on"
            hint="The kill switch. Off, no reply is tagged and no lead line is split."
            checked={v.aiEnabled}
            onChange={(x) => set("aiEnabled", x)}
          />
        </div>
        <div className="grid gap-3 border-t border-border p-4 sm:grid-cols-2 sm:p-5">
          <Field label="Model">
            <Select {...bind("aiModel")}>
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Daily spend cap (cents)"
            hint={
              Number.isFinite(cap) && cap > 0
                ? `$${(cap / 100).toFixed(2)} a day, counted across every kind of run.`
                : "Counted across every kind of run."
            }
          >
            <Input {...bind("aiDailyCapCents")} inputMode="numeric" />
          </Field>
        </div>
      </form>
    </SettingsCard>
  );
}
