import { stageDef, type StageKey } from "@/lib/mca/stages";
import { GROUP_COLOR } from "./ui";

export function StageBadge({ stage }: { stage: StageKey }) {
  const def = stageDef(stage);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap">
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ background: GROUP_COLOR[def.group] }}
      />
      {def.label}
    </span>
  );
}
