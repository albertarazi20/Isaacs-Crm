"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { setBucketStepsAction } from "@/app/buckets-actions";
import { useRun } from "@/components/client/parts";
import { Button, Input, Select } from "@/components/ui";
import type { BucketRow, BucketStepRow, TemplateRow } from "@/lib/buckets/queries";
import { ICON, Icon } from "./primitives";

interface Step {
  dayOffset: string;
  action: "email" | "call" | "move_to_cold";
  templateId: string;
}

/**
 * A bucket's sequence: day N → template (or a call task / move to cold). Saved whole. Each step is one row that
 * reads left to right — "Step 1 · day 0 · Email · which template" — and stacks into a small card on a phone.
 */
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
    <div className="space-y-3" data-sequence={bucket.name}>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">No steps — nothing goes out on its own.</p>
      ) : (
        <ol className="space-y-2">
          {rows.map((r, i) => (
            <li
              key={i}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 rounded-lg border border-border bg-surface-3 p-2.5 text-sm sm:flex sm:flex-wrap sm:border-0 sm:bg-transparent sm:p-0"
            >
              <span className="w-12 shrink-0 text-xs font-semibold text-muted tabular-nums">
                Step {i + 1}
              </span>
              <span className="flex items-center gap-1.5 text-xs text-muted">
                day
                <Input
                  value={r.dayOffset}
                  disabled={!canEdit}
                  onChange={(e) => update(i, { dayOffset: e.target.value })}
                  inputMode="numeric"
                  aria-label={`Step ${i + 1} day`}
                  className="h-9 w-16 px-2 text-center text-sm tabular-nums sm:h-8 sm:text-[13px]"
                />
              </span>
              {canEdit ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove step ${i + 1}`}
                  title="Remove this step"
                  className="h-9 w-9 px-0 text-muted sm:order-last sm:ml-auto sm:h-8 sm:w-8"
                  onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}
                >
                  <Icon d={ICON.close} />
                </Button>
              ) : null}
              <Select
                value={r.action}
                disabled={!canEdit}
                onChange={(e) => update(i, { action: e.target.value as Step["action"] })}
                aria-label={`Step ${i + 1} action`}
                className="col-span-3 h-9 text-sm sm:h-8 sm:w-36 sm:text-[13px]"
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
                  aria-label={`Step ${i + 1} template`}
                  className="col-span-3 h-9 text-sm sm:h-8 sm:min-w-56 sm:flex-1 sm:text-[13px]"
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
            </li>
          ))}
        </ol>
      )}
      {canEdit ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
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
