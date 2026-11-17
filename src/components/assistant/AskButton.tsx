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

export const merchantBrief = (business: string, id: string) =>
  `Look at ${business} (merchant_id ${id}): read the file and tell me where it stands, what is still missing, and the next best step today. Write the message I should send next (a short email and a text), and set up the actions.`;

export const bucketBrief = (name: string, id: string) =>
  `Look at the "${name}" bucket (bucket_id ${id}): its email sequence and its merchants. Who is closest to done, who has gone quiet, and what should I do with this bucket today? Set up the actions.`;

export const ALL_BUCKETS_BRIEF =
  "Look at all my follow-up buckets. Which one needs attention most today and why, and which emails are not landing? Give me a short plan and set up the actions.";
