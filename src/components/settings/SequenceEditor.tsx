"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { setBucketStepsAction } from "@/app/buckets-actions";
import { useRun } from "@/components/client/parts";
import { Button, Select } from "@/components/ui";
import type { BucketRow, BucketStepRow, TemplateRow } from "@/lib/buckets/queries";

interface Step {
  dayOffset: string;
  action: "email" | "call" | "move_to_cold";
  templateId: string;
}

/** A bucket's sequence: day N → template (or a call task / move to cold). Saved whole. */
export function SequenceEditor({
  bucket,
  steps,
  templates,
  canEdit,
}: {
  bucket: BucketRow;
  steps: BucketStepRow[];
  templates: TemplateRow[];
  canEdit: boolean;
}) {
  const run = useRun();
  const router = useRouter();
  const [rows, setRows] = useState<Step[]>(
    steps.map((s) => ({
      dayOffset: String(s.day_offset),
      action: s.action as Step["action"],
      templateId: s.template_id ?? "",
    })),
  );
  const [busy, setBusy] = useState(false);
  const update = (i: number, patch: Partial<Step>) =>
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2" data-sequence={bucket.name}>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">No steps — nothing goes out on its own.</p>
      ) : null}
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-12 text-xs text-muted">Step {i + 1}</span>
          <span className="text-xs text-muted">day</span>
          <input
            value={r.dayOffset}
            disabled={!canEdit}
            onChange={(e) => update(i, { dayOffset: e.target.value })}
            inputMode="numeric"
            className="h-8 w-16 rounded-lg border border-border bg-surface px-2 text-sm"
          />
          <Select
            value={r.action}
            disabled={!canEdit}
            onChange={(e) => update(i, { action: e.target.value as Step["action"] })}
            className="h-8 text-sm"
          >
            <option value="email">Email</option>
            <option value="call">Call task</option>
            <option value="move_to_cold">Move to cold</option>
          </Select>
          {r.action === "email" ? (
            <Select
              value={r.templateId}
              disabled={!canEdit}
              onChange={(e) => update(i, { templateId: e.target.value })}
              className="h-8 min-w-56 text-sm"
            >
              <option value="">Pick a template…</option>
              {templates
                .filter((t) => !t.archived)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.approved ? "" : " (unapproved)"}
                  </option>
                ))}
            </Select>
          ) : null}
          {canEdit ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove step ${i + 1}`}
              title="Remove this step"
              onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}
            >
              ✕
            </Button>
          ) : null}
        </div>
      ))}
      {canEdit ? (
        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            onClick={() =>
              setRows((cur) => [
                ...cur,
                {
                  dayOffset: String(cur.length ? Number(cur[cur.length - 1]!.dayOffset) + 3 : 0),
                  action: "email",
                  templateId: "",
                },
              ])
            }
            disabled={rows.length >= 12}
          >
            + Step
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const ok = await run(
                setBucketStepsAction({
                  bucketId: bucket.id,
                  steps: rows.map((r) => ({
                    dayOffset: r.dayOffset,
                    action: r.action,
                    templateId: r.action === "email" ? r.templateId || null : null,
                  })),
                }),
                "Sequence saved",
              );
              setBusy(false);
              if (ok) router.refresh();
            }}
          >
            Save sequence
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted">A manager edits the shop&apos;s sequences.</p>
      )}
    </div>
  );
}
