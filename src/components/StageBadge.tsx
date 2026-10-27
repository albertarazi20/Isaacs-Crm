import { foldStage, stageDef, type StageKey } from "@/lib/mca/stages";
import { GROUP_COLOR } from "./ui";

export function StageBadge({ stage }: { stage: StageKey }) {
  const def = stageDef(foldStage(stage));
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap"
      style={{ background: `color-mix(in srgb, ${GROUP_COLOR[def.group]} 12%, transparent)` }}
    >
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ background: GROUP_COLOR[def.group] }}
      />
      {def.label}
    </span>
  );
}
