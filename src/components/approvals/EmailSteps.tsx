"use client";

import type { SentStep } from "@/lib/approvals/queries";
import { stepName, type CadenceStep } from "@/lib/approvals/words";
import { cn } from "../ui";

/**
 * The approval emails as a row of marks: filled for each one sent, a pulsing ring for the one on its way, a ring for
 * the next, a dot for the rest. Each mark's tooltip says which email it is and when it went.
 */
export function EmailSteps({
  cadence,
  steps,
  nextStep,
  running,
  fmt,
  className,
}: {
  cadence: readonly CadenceStep[];
  steps: readonly SentStep[];
  nextStep: number | null;
  running: boolean;
  fmt: (iso: string) => string;
  className?: string;
}) {
  const total = Math.max(cadence.length, ...steps.map((s) => s.step), 0);
  const sentCount = steps.filter((s) => s.status === "sent").length;
  return (
    <ol
      aria-label={`${sentCount} of ${total} approval emails sent`}
      className={cn("flex items-center gap-1", className)}
    >
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
        const s = steps.find((x) => x.step === n);
        const sent = s?.status === "sent";
        // only a running approval has an email on its way: a stop the engine has not written yet cancels the queued one
        const going = (s?.status === "queued" || s?.status === "sending") && running;
        const next = !sent && !going && running && nextStep === n;
        const title = sent
          ? `${stepName(n)}: sent ${fmt(s.at)}`
          : going
            ? `${stepName(n)}: going out ${fmt(s.at)}`
            : next
              ? `${stepName(n)}: next`
              : stepName(n);
        return (
          <li key={n} title={title} className="flex items-center gap-1">
            {n > 1 ? (
              <span
                aria-hidden
                className={cn(
                  "h-px w-3 rounded-full sm:w-4",
                  sent || going ? "bg-good/50" : "bg-border-strong",
                )}
              />
            ) : null}
            <span
              className={cn(
                "relative flex size-5 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums ring-1 ring-inset transition",
                sent && "bg-good-soft text-good ring-good/30",
                going && "bg-accent-soft text-accent ring-accent/50",
                next && "bg-surface text-accent ring-accent/40",
                !sent && !going && !next && "bg-surface-2 text-muted ring-border",
              )}
            >
              {going ? (
                <span
                  aria-hidden
                  className="absolute inset-0 animate-ping rounded-full ring-1 ring-accent/40 motion-reduce:animate-none"
                />
              ) : null}
              {sent ? (
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  className="size-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
              ) : (
                n
              )}
              <span className="sr-only">{title}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
