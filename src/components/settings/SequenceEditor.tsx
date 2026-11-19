"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { setBucketDailyTemplateAction, setBucketStepsAction } from "@/app/buckets-actions";
import { useRun } from "@/components/client/parts";
import { Button, cn, IconButton, Input, Select } from "@/components/ui";
import type { BucketRow, BucketStepRow, TemplateRow } from "@/lib/buckets/queries";
import { minuteLabel } from "@/lib/settings/format";
import { ICON, Icon } from "./primitives";

interface Step {
  dayOffset: string;
  action: "email" | "call" | "move_to_cold";
  templateId: string;
}

const ACTION_ICON: Record<Step["action"], string> = {
  email: ICON.mail,
  call: ICON.phone,
  move_to_cold: ICON.snow,
};
const ACTION_INK: Record<Step["action"], string> = {
  email: "text-accent",
  call: "text-good",
  move_to_cold: "text-info",
};

const toSteps = (steps: BucketStepRow[]): Step[] =>
  steps.map((s) => ({
    dayOffset: String(s.day_offset),
    action: s.action as Step["action"],
    templateId: s.template_id ?? "",
  }));

/**
 * A manager's pick of the template a bucket sends to every member once a day (0593). While one is picked the
 * step list below is not used.
 */
function DailyReminder({
  bucket,
  templates,
  onChange,
}: {
  bucket: BucketRow;
  templates: TemplateRow[];
  onChange: (templateId: string) => void;
}) {
  const run = useRun();
  const router = useRouter();
  const [picked, setPicked] = useState(bucket.daily_template_id ?? "");
  const [saved, setSaved] = useState(bucket.daily_template_id ?? "");
  const [busy, setBusy] = useState(false);
  const dirty = picked !== saved;
  // what the engine may send on its own: not archived, and approved or shared (the one already picked always stays listed)
  const offered = templates.filter(
    (t) => t.id === saved || (!t.archived && (t.approved || t.owner_id === null)),
  );
  return (
    <div
      className="mb-5 rounded-xl border border-border bg-surface-2/40 p-3.5"
      data-daily={bucket.name}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`daily-${bucket.id}`} className="text-[13px] font-semibold text-text-2">
          Daily reminder
        </label>
        <Select
          id={`daily-${bucket.id}`}
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          className="h-9 w-full text-sm sm:h-9 sm:w-auto sm:min-w-56 sm:flex-1 sm:text-[13px]"
        >
          <option value="">None: use the steps below</option>
          {offered.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant={dirty ? "primary" : "secondary"}
          disabled={busy || !dirty}
          onClick={async () => {
            setBusy(true);
            const sent = picked;
            const ok = await run(
              setBucketDailyTemplateAction({ bucketId: bucket.id, templateId: sent || null }),
              sent ? "Daily reminder saved" : "Daily reminder off",
            );
            setBusy(false);
            if (ok) {
              setSaved(sent);
              onChange(sent);
              router.refresh();
            }
          }}
        >
          {busy ? "Saving…" : "Save reminder"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">
        {saved
          ? `Everyone in this bucket gets it daily at ${minuteLabel(bucket.daily_reminder_minute)}, their time, every day but Saturday, until they leave. Changing the template starts everyone again today.`
          : "Pick a template and every member gets it once a day instead of the steps below."}
      </p>
    </div>
  );
}

/**
 * A bucket's sequence as a timeline: each step is a stop on the line that reads "day N, do this, with that
 * template". Saved whole. On a phone a stop's controls wrap under its day.
 */
export function SequenceEditor({
  bucket,
  steps,
  templates,
  canEdit,
  manager,
}: {
  bucket: BucketRow;
  steps: BucketStepRow[];
  templates: TemplateRow[];
  canEdit: boolean;
  /** Only a manager picks the daily reminder. */
  manager: boolean;
}) {
  const run = useRun();
  const router = useRouter();
  const [rows, setRows] = useState<Step[]>(() => toSteps(steps));
  const [saved, setSaved] = useState(() => JSON.stringify(toSteps(steps)));
  const [busy, setBusy] = useState(false);
  const [daily, setDaily] = useState(bucket.daily_template_id !== null);
  const dirty = JSON.stringify(rows) !== saved;
  const update = (i: number, patch: Partial<Step>) =>
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div data-sequence={bucket.name}>
      {manager ? (
        <DailyReminder bucket={bucket} templates={templates} onChange={(t) => setDaily(t !== "")} />
      ) : daily ? (
        <p className="mb-4 text-xs text-muted">
          This bucket sends a daily reminder, set by a manager.
        </p>
      ) : null}
      {daily ? (
        <p className="mb-3 text-[13px] font-medium text-warn">
          Not used while a daily reminder is on
        </p>
      ) : null}
      <div className={cn(daily && "opacity-50")}>
        {rows.length === 0 ? (
          <p className="flex items-center gap-2.5 text-[13px] text-muted">
            <span
              aria-hidden
              className="flex size-8 items-center justify-center rounded-full border border-dashed border-border-strong"
            >
              <Icon d={ICON.plus} className="size-3.5" />
            </span>
            {daily
              ? "No steps. The daily reminder is what goes out."
              : "No steps yet. Nothing goes out on its own."}
          </p>
        ) : (
          <ol>
            {rows.map((r, i) => (
              <li key={i} className="relative flex gap-3 pb-3 last:pb-0">
                {i < rows.length - 1 ? (
                  <span
                    aria-hidden
                    className="absolute top-9 bottom-0 left-[17.5px] w-px bg-border-strong/70"
                  />
                ) : null}
                <span
                  aria-hidden
                  className={cn(
                    "relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface-3",
                    ACTION_INK[r.action],
                  )}
                >
                  <Icon d={ACTION_ICON[r.action]} className="size-4" />
                </span>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="flex h-9 shrink-0 items-center gap-1.5 text-[13px] text-muted">
                    <span className="w-14 font-semibold whitespace-nowrap text-text-2 tabular-nums">
                      Step {i + 1}
                    </span>
                    day
                    <span className="block w-14">
                      <Input
                        value={r.dayOffset}
                        disabled={!canEdit}
                        onChange={(e) => update(i, { dayOffset: e.target.value })}
                        inputMode="numeric"
                        aria-label={`Step ${i + 1} day`}
                        className="h-9 px-2 text-center text-sm font-semibold tabular-nums sm:h-9 sm:text-[13px]"
                      />
                    </span>
                  </span>
                  {canEdit ? (
                    <IconButton
                      label={`Remove step ${i + 1}`}
                      className="order-last ml-auto sm:size-9"
                      onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}
                    >
                      <Icon d={ICON.close} className="size-3.5" />
                    </IconButton>
                  ) : null}
                  <Select
                    value={r.action}
                    disabled={!canEdit}
                    onChange={(e) => update(i, { action: e.target.value as Step["action"] })}
                    aria-label={`Step ${i + 1} action`}
                    className="h-9 w-full text-sm sm:h-9 sm:w-36 sm:text-[13px]"
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
                      className="h-9 w-full text-sm sm:h-9 sm:w-auto sm:min-w-52 sm:flex-1 sm:text-[13px]"
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
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
      {canEdit ? (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3.5">
          <span className="mr-auto text-xs text-muted">
            {dirty ? (
              <span className="font-medium text-accent">Unsaved changes</span>
            ) : rows.length > 0 ? (
              "Stops the moment they reply, upload or sign."
            ) : null}
          </span>
          <Button
            size="sm"
            variant="ghost"
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
            variant={dirty ? "primary" : "secondary"}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const sent = rows;
              const ok = await run(
                setBucketStepsAction({
                  bucketId: bucket.id,
                  steps: sent.map((r) => ({
                    dayOffset: r.dayOffset,
                    action: r.action,
                    templateId: r.action === "email" ? r.templateId || null : null,
                  })),
                }),
                "Sequence saved",
              );
              setBusy(false);
              if (ok) {
                setSaved(JSON.stringify(sent));
                router.refresh();
              }
            }}
          >
            {busy ? "Saving…" : "Save sequence"}
          </Button>
        </div>
      ) : (
        <p className="mt-4 border-t border-border pt-3 text-xs text-muted">
          A manager edits the shop&apos;s sequences.
        </p>
      )}
    </div>
  );
}
