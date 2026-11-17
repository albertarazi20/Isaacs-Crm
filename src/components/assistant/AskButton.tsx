"use client";

import { Glyph } from "@/components/shell/icons";
import { buttonClass, cn } from "@/components/ui";
import { useAssistant } from "./Assistant";

/**
 * "Ask the assistant" about the thing on this page: the brief names it (with its id, so the assistant reads the right
 * record) and the person's bubble shows the short label.
 */
export function AskButton({
  prompt,
  label,
  text = "Ask the assistant",
  size = "md",
  className,
}: {
  prompt: string;
  label: string;
  text?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const ask = useAssistant();
  return (
    <button
      type="button"
      onClick={() => ask({ prompt, label, send: true, fresh: true })}
      className={cn(
        buttonClass("secondary", size),
        "bg-brand-soft ring-1 ring-accent/25 ring-inset hover:ring-accent/50",
        className,
      )}
    >
      <Glyph name="sparkles" className="size-3.5 text-accent" />
      {text}
    </button>
  );
}
