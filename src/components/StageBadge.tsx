import { foldStage, stageDef, type StageKey } from "@/lib/mca/stages";
import { GROUP_COLOR } from "./ui";

/** The stage as a badge: the group's colour as a dot and a tint, the stage name always in words. */
export function StageBadge({ stage }: { stage: StageKey }) {
  const def = stageDef(foldStage(stage));
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-text-2"
      style={{ background: `color-mix(in srgb, ${GROUP_COLOR[def.group]} 12%, transparent)` }}
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ background: GROUP_COLOR[def.group] }}
      />
      {def.label}
    </span>
  );
}
