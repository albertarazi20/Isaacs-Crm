"use client";

import { useApp } from "@/components/app-context";
import { Dialog } from "@/components/overlay";
import { needsInput } from "@/components/stage-move/forms";
import { GROUP_COLOR } from "@/components/ui";
import type { ClientCard } from "@/lib/data/types";
import { formatDate } from "@/lib/format";
import { FOLLOW_UP_PRESETS } from "@/lib/mca/dates";
import { CORE_STAGES, foldStage, STAGE_GROUPS, type StageKey } from "@/lib/mca/stages";
import { bucketDueDate, timerText, type DropBucket } from "./logic";

const AGAIN: Partial<Record<StageKey, string>> = {
  funded: "Record a new advance (a renewal)",
  lost: "Change who they went with",
  default_workable: "Update the default date or promise to pay",
  default_bad: "Update the default date or promise to pay",
};

const OPTION =
  "rounded-lg border border-border px-3 py-2 text-left text-sm transition hover:bg-surface-2 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent";

/**
 * The tap-friendly way to move a card, and the keyboard and screen-reader way. One shared dialog
 * instead of a <select> on every card keeps 2,000 cards light.
 */
export function StageSheet({
  card,
  onPick,
  onClose,
}: {
  card: ClientCard;
  onPick: (stage: StageKey) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open wide onClose={onClose} title={`Move ${card.business_name} to…`}>
      <div className="space-y-4">
        {STAGE_GROUPS.map((g) => (
          <section key={g.key} aria-label={g.label}>
            <h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted uppercase">
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ background: GROUP_COLOR[g.key] }}
              />
              {g.label}
            </h3>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {CORE_STAGES.filter((s) => s.group === g.key).map((s) => {
                const current = s.key === foldStage(card.stage);
                // Funded, lost and default stages can be re-entered to record a new advance,
                // a different competitor or a new promise to pay.
                const again = current && needsInput(card, s.key);
                return (
                  <button
                    key={s.key}
                    type="button"
                    disabled={current && !again}
                    aria-current={current ? "true" : undefined}
                    onClick={() => onPick(s.key)}
                    className={OPTION}
                  >
                    <span className="block font-medium">
                      {s.label}
                      {current ? " (current)" : ""}
                    </span>
                    <span className="block text-xs text-muted">
                      {again ? AGAIN[s.key] : `${s.hint} · follow up ${timerText(s.followUp)}`}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

const CHOICES: readonly { key: DropBucket; label: string }[] = [
  { key: "today", label: "Today" },
  ...FOLLOW_UP_PRESETS.map((p) => ({ key: p.key, label: p.label })),
];

export function FollowUpSheet({
  card,
  onPick,
  onClose,
}: {
  card: ClientCard;
  onPick: (bucket: DropBucket) => void;
  onClose: () => void;
}) {
  const { today } = useApp();
  return (
    <Dialog open onClose={onClose} title={`Follow up with ${card.business_name} in…`}>
      <div className="grid grid-cols-2 gap-1.5">
        {CHOICES.map((c) => (
          <button key={c.key} type="button" onClick={() => onPick(c.key)} className={OPTION}>
            <span className="block font-medium">{c.label}</span>
            <span className="block text-xs text-muted">
              {formatDate(bucketDueDate(c.key, today), today)}
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
