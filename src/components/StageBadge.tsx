import { foldStage, stageDef, type StageKey } from "@/lib/mca/stages";
import { GROUP_COLOR } from "./ui";

/** The stage as a badge: the group's colour as a dot and a tint, the stage name always in words. */
export function StageBadge({ stage }: { stage: StageKey }) {
  const def = stageDef(foldStage(stage));
  const color = GROUP_COLOR[def.group];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-1.5 text-[11px] font-semibold whitespace-nowrap text-text-2 ring-1 ring-inset"
      style={
        {
          background: `color-mix(in srgb, ${color} 12%, transparent)`,
          "--tw-ring-color": `color-mix(in srgb, ${color} 26%, transparent)`,
        } as React.CSSProperties
      }
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: color }} />
      {def.label}
    </span>
  );
}
