"use client";

import type { ReactNode } from "react";
import { useCall } from "@/components/overlay";
import { Glyph } from "@/components/shell/icons";
import type { Tone } from "@/components/ui";

export { Badge, Button, EmptyState } from "@/components/ui";

/** The shared action caller (toasts on failure), under a name that says what it is for here. */
export const useCallSafe = useCall;

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** How each kind of alert looks in the feed: its tone, its icon, and which filter it answers to. */
export const ALERT_LOOK: Record<
  string,
  { tone: Tone; icon: ReactNode; group: "signed" | "sending" }
> = {
  application_signed: {
    tone: "good",
    group: "signed",
    icon: (
      <svg aria-hidden viewBox="0 0 24 24" className="size-[18px]" {...stroke}>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5zM14 3v5h5" />
        <path d="m9 14.5 2.2 2.2L15.5 12" />
      </svg>
    ),
  },
  // every required document is in (0543): the rep's cue to hand the merchant off
  file_complete: {
    tone: "good",
    group: "signed",
    icon: (
      <svg aria-hidden viewBox="0 0 24 24" className="size-[18px]" {...stroke}>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        <path d="m9 13 2 2 4-4" />
      </svg>
    ),
  },
  template_paused: {
    tone: "warn",
    group: "sending",
    icon: (
      <svg aria-hidden viewBox="0 0 24 24" className="size-[18px]" {...stroke}>
        <circle cx="12" cy="12" r="9" />
        <path d="M10 9v6M14 9v6" />
      </svg>
    ),
  },
  bounce_spike: {
    tone: "warn",
    group: "sending",
    icon: (
      <svg aria-hidden viewBox="0 0 24 24" className="size-[18px]" {...stroke}>
        <rect x="3" y="5" width="18" height="14" rx="2.5" />
        <path d="m3.5 7.5 8.5 6 8.5-6" />
      </svg>
    ),
  },
};

type Look = { tone: Tone; icon: ReactNode; group: "signed" | "sending" | null };

/** A kind this page has no drawing for still gets a fair tone, read from the word itself. */
export function lookOf(kind: string): Look {
  const known = ALERT_LOOK[kind];
  if (known) return known;
  if (/paus|bounce|stale|kick|fail|error|block/.test(kind))
    return { tone: "warn", group: null, icon: <Glyph name="alert" className="size-[18px]" /> };
  if (/sign|brought|approv|reply|docs|upload|won/.test(kind))
    return { tone: "good", group: null, icon: <Glyph name="check" className="size-[18px]" /> };
  return { tone: "accent", group: null, icon: <Glyph name="bell" className="size-[18px]" /> };
}

/** "stale_deal" reads as "Stale deal" when the feed has no label for it. */
export function kindLabel(kind: string, labels: Record<string, string>): string {
  const known = labels[kind];
  if (known) return known;
  const words = kind.replaceAll("_", " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Alert";
}

export const TONE_CHIP: Record<Tone, string> = {
  neutral: "bg-surface-2 text-text-2 ring-border",
  good: "bg-good-soft text-good ring-good/25",
  warn: "bg-warn-soft text-warn ring-warn/25",
  bad: "bg-bad-soft text-bad ring-bad/25",
  accent: "bg-accent-soft text-accent ring-accent/25",
  info: "bg-info-soft text-info ring-info/25",
};
