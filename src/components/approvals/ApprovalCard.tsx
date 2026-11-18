"use client";

import Link from "next/link";
import { useState } from "react";
import {
  pauseApprovalAction,
  pitchedAction,
  reopenApprovalAction,
  resumeApprovalAction,
} from "@/app/approval-actions";
import type { ApprovalRow } from "@/lib/approvals/queries";
import {
  advanceWords,
  canResume,
  emailsStatus,
  holdWords,
  offerMoney,
  whenWords,
  type CadenceStep,
} from "@/lib/approvals/words";
import type { ActionResult } from "@/lib/data/types";
import { timeAgo } from "@/lib/format";
import { useApp } from "../app-context";
import { useCall, useToast } from "../overlay";
import { Glyph } from "../shell/icons";
import { Badge, Button, cn, TONE_TEXT } from "../ui";
import { ApprovalForm } from "./ApprovalForm";
import { EmailSteps } from "./EmailSteps";

/**
 * The approval on a merchant's page. Open: the offer, the hold, where the emails stand, and Pitched. Otherwise a
 * slim strip to mark a new one (shown once the merchant is brought in, or when they have had one before).
 */
export function ApprovalCard({
  merchant,
  approval,
  cadence,
  broughtIn,
  className,
}: {
  merchant: { id: string; name: string };
  approval: ApprovalRow | null;
  cadence: readonly CadenceStep[];
  broughtIn: boolean;
  className?: string;
}) {
  const { timezone, nowMs, today } = useApp();
  const call = useCall();
  const toast = useToast();
  const [form, setForm] = useState<"new" | "edit" | null>(null);
  const [busy, setBusy] = useState(false);
  const fmt = (iso: string) => whenWords(iso, timezone, nowMs);
  const open = approval?.status === "open" ? approval : null;

  async function run<T>(p: Promise<ActionResult<T>>, ok?: string) {
    setBusy(true);
    const res = await call(p, ok);
    setBusy(false);
    return res;
  }

  /** Start or resume, and say what actually happened (an unsubscribed merchant does not get emailed). */
  async function resume() {
    if (!open) return;
    const res = await run(resumeApprovalAction({ approvalId: open.id }));
    if (!res) return;
    toast({
      message: `${open.emails_note === "held" ? "Started" : "Resumed"}. ${advanceWords(res, fmt)}`,
      tone: res.kind === "queued" || res.kind === "idle" ? "success" : "info",
    });
  }

  if (!open && !approval && !broughtIn) return null;

  const dialogs = (
    <>
      {form === "new" ? (
        <ApprovalForm
          open
          onClose={() => setForm(null)}
          merchant={merchant}
          cadence={cadence}
          fmt={fmt}
        />
      ) : null}
      {form === "edit" && open ? (
        <ApprovalForm
          open
          onClose={() => setForm(null)}
          editing={open}
          cadence={cadence}
          fmt={fmt}
        />
      ) : null}
    </>
  );

  if (!open) {
    const last = approval;
    return (
      <section
        aria-label="Approval"
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-border-strong/70 bg-surface-3/40 px-4 py-3 sm:px-5",
          className,
        )}
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold">Got an approval?</p>
          <p className="text-xs text-muted">
            {last
              ? `Last one: ${offerMoney(last.amount_cents)}, ${last.status === "pitched" ? `pitched ${fmt(last.pitched_at ?? last.created_at)}` : `closed${last.closed_reason ? ` (${last.closed_reason})` : ""}`}.`
              : "Mark it and the approval emails go out on their own until you pitch it."}
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setForm("new")}>
          <Glyph name="target" className="size-4" />
          Mark approved
        </Button>
        {dialogs}
      </section>
    );
  }

  const status = emailsStatus(open, fmt);
  const hold = holdWords(open.hold_until, today);
  return (
    <section
      aria-label="Open approval"
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-surface p-4 sm:p-5",
        status.hot ? "border-accent/50 shadow-glow" : "border-accent/25",
        className,
      )}
    >
      <div
        aria-hidden
        className="bg-brand-soft pointer-events-none absolute inset-y-0 left-0 w-1 rounded-l-2xl"
      />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-6">
        <div className="min-w-0 lg:w-60">
          <p className="eyebrow flex items-center gap-2">
            Open approval {status.hot ? <Badge tone="accent">Replied</Badge> : null}
          </p>
          <p className="mt-1 text-2xl leading-none font-semibold tracking-[-0.03em] tabular-nums">
            {offerMoney(open.amount_cents)}
          </p>
          <p className="mt-1 truncate text-xs text-muted">
            {[open.funder, `marked ${timeAgo(open.created_at, new Date(nowMs))}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="min-w-0 lg:w-44">
          <p className="eyebrow">Hold</p>
          {hold ? (
            <p className="mt-1 text-sm font-medium">
              {hold.label}{" "}
              <span className={cn("text-xs", TONE_TEXT[hold.tone])}>· {hold.left}</span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted">No date</p>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <EmailSteps
            cadence={cadence}
            steps={open.steps}
            nextStep={open.next_step}
            running={open.emails === "running" && !open.halt}
            fmt={fmt}
          />
          <p className="mt-1.5 text-xs">
            <span className={cn("font-semibold", TONE_TEXT[status.tone])}>{status.label}</span>
            {status.detail ? <span className="text-muted"> {status.detail}</span> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {open.emails === "running" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(pauseApprovalAction({ approvalId: open.id }), "Emails paused")
              }
            >
              Pause emails
            </Button>
          ) : canResume(open) ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void resume()}>
              {open.emails_note === "held" ? "Start emails" : "Resume emails"}
            </Button>
          ) : null}
          <Button size="sm" disabled={busy} onClick={() => setForm("edit")}>
            Change
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={async () => {
              const res = await run(pitchedAction({ approvalId: open.id }));
              if (!res) return;
              toast({
                message: "Pitched. The approval emails stopped.",
                tone: "success",
                action: {
                  label: "Undo",
                  onClick: () =>
                    void call(
                      reopenApprovalAction({ approvalId: open.id, restore: true }),
                      "Back on Open approvals, the emails as they were",
                    ),
                },
              });
            }}
          >
            <Glyph name="check" className="size-4" />
            Pitched
          </Button>
        </div>
      </div>
      {open.note ? (
        <p className="mt-3 border-t border-border pt-3 text-xs text-text-2">{open.note}</p>
      ) : null}
      <p className="mt-3 text-xs text-muted">
        <Link href="/approvals" className="font-medium text-text-2 hover:underline">
          All open approvals
        </Link>
      </p>
      {dialogs}
    </section>
  );
}
