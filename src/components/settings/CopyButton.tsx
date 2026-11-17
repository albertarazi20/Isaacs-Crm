"use client";

import { useState } from "react";
import { cn } from "@/components/ui";
import { ICON, Icon } from "./primitives";

/** Copies a value and shows a tick for a moment. `label` names what is copied, for a screen reader and the tooltip. */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? `${label} copied` : `Copy ${label}`}
      title={done ? "Copied" : `Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          /* clipboard blocked: the text beside the button can still be selected */
        }
      }}
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-full transition duration-150 hover:bg-surface-2 active:scale-90 sm:size-8",
        done ? "text-good" : "text-muted hover:text-text",
        className,
      )}
    >
      <Icon d={done ? ICON.check : ICON.copy} className="size-3.5" />
    </button>
  );
}
