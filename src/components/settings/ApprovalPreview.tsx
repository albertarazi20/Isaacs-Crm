"use client";

import { useMemo, useState } from "react";
import { fillApprovalEmail, SAMPLE_VALUES } from "@/lib/approvals/html";
import { Dialog } from "../overlay";
import { Avatar, cn } from "../ui";
import { inboxPreview } from "./approvalCadence";
import { ICON, Icon } from "./primitives";

/** The design is drawn 600px wide (an email's width) and shrunk to this. */
const DESIGN_W = 600;
const THUMB_W = 176;
const THUMB_H = 220;
const SCALE = THUMB_W / DESIGN_W;

type Width = "desktop" | "phone";

/**
 * A design as the merchant would see it, filled with the sample merchant: a small thumbnail that opens the full
 * preview. Both frames are sandboxed with no permissions at all (no scripts, no same-origin): the HTML is the shop's
 * own, but it is still HTML from a file.
 */
export function ApprovalPreview({
  html,
  subject,
  name,
  unsaved,
}: {
  html: string;
  subject: string;
  /** "Email 1", "Follow-up 2". */
  name: string;
  /** The design shown is not saved yet. */
  unsaved: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState<Width>("desktop");
  const filled = useMemo(
    () => fillApprovalEmail({ subject, html }, SAMPLE_VALUES),
    [subject, html],
  );
  const preheader = useMemo(() => inboxPreview(filled.html), [filled.html]);
  return (
    <>
      <div
        className="relative shrink-0 overflow-hidden rounded-xl border border-border bg-white shadow-card"
        style={{ width: THUMB_W, height: THUMB_H }}
      >
        <iframe
          title={`${name}, small preview`}
          aria-hidden
          tabIndex={-1}
          sandbox=""
          srcDoc={filled.html}
          loading="lazy"
          className="pointer-events-none absolute top-0 left-0 border-0 bg-white"
          style={{
            width: DESIGN_W,
            height: THUMB_H / SCALE,
            transform: `scale(${SCALE})`,
            transformOrigin: "0 0",
          }}
        />
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Preview ${name}`}
          className="group absolute inset-0 flex items-end justify-center bg-linear-to-t from-black/45 via-black/0 to-black/0 pb-3 transition hover:from-black/60 focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
        >
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-surface/95 px-3 text-xs font-semibold text-text shadow-card transition group-hover:scale-105 group-active:scale-95">
            <Icon d={ICON.external} className="size-3.5" />
            Preview
          </span>
        </button>
        {unsaved ? (
          <span className="absolute top-2 left-2 rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-semibold text-white shadow-card">
            Not saved
          </span>
        ) : null}
      </div>

      <Dialog open={open} onClose={() => setOpen(false)} title={`Preview: ${name}`} wide>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 basis-56 text-xs text-muted">
            Filled in for a sample merchant: {SAMPLE_VALUES.first_name} at{" "}
            {SAMPLE_VALUES.business_name}, {SAMPLE_VALUES.offer_amount}.
            {unsaved ? " This design is not saved yet." : ""}
          </p>
          <div
            role="group"
            aria-label="Preview width"
            className="inline-flex shrink-0 gap-0.5 rounded-full border border-border bg-surface-2/70 p-1"
          >
            {(
              [
                ["desktop", "Desktop", ICON.monitor],
                ["phone", "Phone", ICON.phone],
              ] as const
            ).map(([w, label, icon]) => (
              <button
                key={w}
                type="button"
                aria-pressed={width === w}
                onClick={() => setWidth(w)}
                className={cn(
                  "inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition duration-150 focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none sm:h-8",
                  width === w
                    ? "bg-surface text-text shadow-card"
                    : "text-muted hover:bg-surface/60 hover:text-text",
                )}
              >
                <Icon d={icon} className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 flex items-start gap-3 rounded-xl border border-border bg-surface-2/60 px-3 py-2.5">
          <Avatar name={SAMPLE_VALUES.rep_name} size={36} />
          <div className="min-w-0 flex-1">
            <p className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-semibold">{SAMPLE_VALUES.rep_name}</span>
              <span className="eyebrow shrink-0">Inbox</span>
            </p>
            <p className="truncate text-[13px]">
              <span className="font-semibold">{filled.subject || "(no subject)"}</span>
              {preheader ? <span className="text-muted"> — {preheader}</span> : null}
            </p>
          </div>
        </div>

        <div
          className={cn(
            "mt-3 overflow-x-auto rounded-xl border border-border",
            width === "phone" ? "bg-surface-3 py-4" : "bg-white",
          )}
        >
          <iframe
            title={`${name} as the merchant sees it, ${width === "phone" ? "phone" : "desktop"} width`}
            sandbox=""
            srcDoc={filled.html}
            className={cn(
              "mx-auto block h-[60vh] border-0 bg-white",
              width === "phone"
                ? "w-[375px] max-w-none rounded-2xl shadow-pop"
                : "w-full min-w-[600px]",
            )}
          />
        </div>
      </Dialog>
    </>
  );
}
