"use client";

import { useState } from "react";
import { saveAiSettingsAction } from "@/app/settings-actions";
import { useFormState, useRun } from "@/components/client/parts";
import { Button, Card, Field, Input, SectionTitle, Select } from "@/components/ui";
import type { ShopSettingsRow } from "@/lib/settings/queries";

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

export function AiSettingsForm({ s }: { s: ShopSettingsRow }) {
  const run = useRun();
  const [busy, setBusy] = useState(false);
  const { v, bind, set } = useFormState(() => ({
    aiEnabled: s.ai_enabled,
    aiModel: s.ai_model,
    aiDailyCapCents: String(s.ai_daily_cap_cents),
    aiAutoApplyLowStakes: s.ai_auto_apply_low_stakes,
  }));
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await run(saveAiSettingsAction(v), "Saved");
        setBusy(false);
      }}
    >
      <Card className="space-y-3">
        <SectionTitle>What the AI may do</SectionTitle>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={v.aiEnabled}
            onChange={(e) => set("aiEnabled", e.target.checked)}
          />
          <span className="font-medium">AI on</span>
          <span className="text-xs text-muted">
            — the kill switch. Off, nothing is read or drafted.
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={v.aiAutoApplyLowStakes}
            onChange={(e) => set("aiAutoApplyLowStakes", e.target.checked)}
          />
          <span className="font-medium">Apply low-stakes reads on its own</span>
          <span className="text-xs text-muted">
            — &quot;docs received&quot;, &quot;stips requested&quot;. Money and status still wait
            for a manager.
          </span>
        </label>
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
        </div>
      </Card>
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
