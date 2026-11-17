"use client";

import Link from "next/link";
import { useState } from "react";
import {
  closeApprovalAction,
  pauseApprovalAction,
  pitchedAction,
  reopenApprovalAction,
  resumeApprovalAction,
} from "@/app/approval-actions";
import type { ApprovalRow, ApprovalStatus } from "@/lib/approvals/queries";
import {
  advanceWords,
  canResume,
  emailsStatus,
  holdWords,
  whenWords,
  type CadenceStep,
  type Status,
} from "@/lib/approvals/words";
import type { ActionResult } from "@/lib/data/types";
import { timeAgo } from "@/lib/format";
import { formatUS } from "@/lib/mca/phone";
import { formatMoney } from "@/lib/money";
import { useApp } from "../app-context";
import { OverflowMenu } from "../OverflowMenu";
import { Dialog, useCall, useToast } from "../overlay";
import { Glyph } from "../shell/icons";
import { Avatar, Badge, Button, buttonClass, cn, Input, TONE_TEXT } from "../ui";
import { ApprovalForm } from "./ApprovalForm";
import { EmailSteps } from "./EmailSteps";

const MENU_ITEM =
  "flex min-h-10 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[13px] font-medium text-text-2 transition hover:bg-surface-2 hover:text-text focus-visible:bg-surface-2 focus-visible:outline-none";

const CLOSE_REASONS = [
  "Not interested",
  "Went with another funder",
  "Offer pulled",
  "Can't reach them",
] as const;

/** The approvals of one view (waiting on a pitch, pitched, closed), each with what a rep does next. */
export function ApprovalList({
  rows,
  view,
  cadence,
}: {
  rows: readonly ApprovalRow[];
  view: ApprovalStatus;
  cadence: readonly CadenceStep[];
}) {
  const { timezone, nowMs } = useApp();
  const fmt = (iso: string) => whenWords(iso, timezone, nowMs);
  const [editing, setEditing] = useState<ApprovalRow | null>(null);
  const [closing, setClosing] = useState<ApprovalRow | null>(null);
  return (
    <>
      <ul
        className="stagger space-y-2.5"
        aria-label={
          view === "open" ? "Waiting on a pitch" : view === "pitched" ? "Pitched" : "Closed"
        }
      >
        {rows.map((r) => (
          <ApprovalItem
            key={r.id}
            row={r}
            cadence={cadence}
            fmt={fmt}
            onEdit={() => setEditing(r)}
            onClose={() => setClosing(r)}
          />
        ))}
      </ul>
      {editing ? (
        <ApprovalForm
          open
          onClose={() => setEditing(null)}
          editing={editing}
          cadence={cadence}
          fmt={fmt}
        />
      ) : null}
      {closing ? <CloseDialog row={closing} onDone={() => setClosing(null)} /> : null}
    </>
  );
}

function StatusLine({ status }: { status: Status }) {
  return (
    <p className="mt-1.5 text-xs">
      <span className={cn("font-semibold", TONE_TEXT[status.tone])}>{status.label}</span>
      {status.detail ? <span className="text-muted"> {status.detail}</span> : null}
    </p>
  );
}

function ApprovalItem({
  row,
  cadence,
  fmt,
  onEdit,
  onClose,
}: {
  row: ApprovalRow;
  cadence: readonly CadenceStep[];
  fmt: (iso: string) => string;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { today, nowMs } = useApp();
  const call = useCall();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const status = emailsStatus(row, fmt);
  const hold = holdWords(row.hold_until, today);
  const name = row.business_name || row.contact_name;
  const open = row.status === "open";

  async function run<T>(p: Promise<ActionResult<T>>, ok?: string) {
    setBusy(true);
    const res = await call(p, ok);
    setBusy(false);
    return res;
  }

  /** Start or resume, and say what actually happened (an unsubscribed merchant does not get emailed). */
  async function resume() {
    const res = await run(resumeApprovalAction({ approvalId: row.id }));
    if (!res) return;
    toast({
      message: `${row.emails_note === "held" ? "Started" : "Resumed"}. ${advanceWords(res, fmt)}`,
      tone: res.kind === "queued" || res.kind === "idle" ? "success" : "info",
    });
  }

  async function pitched() {
    const res = await run(pitchedAction({ approvalId: row.id }));
    if (!res) return;
    toast({
      message: `${name}: pitched. Emails stopped.`,
      tone: "success",
      action: {
        label: "Undo",
        onClick: () =>
          void call(
            reopenApprovalAction({ approvalId: row.id, restore: true }),
            "Back on Open approvals, the emails as they were",
          ),
      },
    });
  }

  return (
    <li
      className={cn(
        // the open "more" menu (and a focused control) lifts its card above the next one: each card is its own layer
        "relative rounded-2xl border bg-surface p-4 transition focus-within:z-30 has-[[aria-expanded=true]]:z-30 sm:p-5",
        status.hot ? "border-accent/45 shadow-glow" : "border-border hover:border-border-strong",
      )}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.75fr)_minmax(0,0.8fr)_minmax(0,1.25fr)_auto] lg:items-center lg:gap-5">
        {/* merchant */}
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={name} size={40} />
          <div className="min-w-0">
            <p className="flex min-w-0 items-center gap-2">
              <Link
                href={`/clients/${row.client_id}`}
                className="truncate text-[15px] font-semibold tracking-[-0.01em] hover:underline"
              >
                {name}
              </Link>
              {status.hot ? <Badge tone="accent">Replied</Badge> : null}
            </p>
            <p className="truncate text-xs text-muted">
              {[row.contact_name, row.rep_name ? `Rep: ${row.rep_name}` : ""]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>

        {/* the offer and the hold: side by side on a phone, their own columns on a wide screen */}
        <div className="grid grid-cols-2 gap-4 lg:contents">
          <div className="min-w-0">
            <p className="eyebrow">Approved</p>
            <p className="mt-0.5 text-xl leading-tight font-semibold tracking-[-0.03em] tabular-nums">
              {formatMoney(row.amount_cents)}
            </p>
            <p className="truncate text-xs text-muted" title={row.note || undefined}>
              {[row.funder, timeAgo(row.created_at, new Date(nowMs))].filter(Boolean).join(" · ")}
            </p>
          </div>

          {/* the hold, or when it was pitched / closed */}
          <div className="min-w-0">
            {open ? (
              <>
                <p className="eyebrow">Hold</p>
                {hold ? (
                  <>
                    <p className="mt-0.5 text-sm font-medium">{hold.label}</p>
                    <p className={cn("text-xs font-medium", TONE_TEXT[hold.tone])}>{hold.left}</p>
                  </>
                ) : (
                  <p className="mt-0.5 text-sm text-muted">No date</p>
                )}
              </>
            ) : row.status === "pitched" && row.pitched_at ? (
              <>
                <p className="eyebrow">Pitched</p>
                <p className="mt-0.5 text-sm font-medium">{fmt(row.pitched_at)}</p>
                <p className="truncate text-xs text-muted">
                  {row.pitched_by_name ? `by ${row.pitched_by_name}` : ""}
                </p>
              </>
            ) : row.closed_at ? (
              <>
                <p className="eyebrow">Closed</p>
                <p className="mt-0.5 text-sm font-medium">{fmt(row.closed_at)}</p>
                <p className="truncate text-xs text-muted" title={row.closed_reason}>
                  {row.closed_reason}
                </p>
              </>
            ) : null}
          </div>
        </div>

        {/* the emails */}
        <div className="min-w-0">
          <EmailSteps
            cadence={cadence}
            steps={row.steps}
            nextStep={row.next_step}
            running={open && row.emails === "running" && !row.halt}
            fmt={fmt}
          />
          <StatusLine status={status} />
          {row.last_call_at ? (
            <p className="mt-0.5 text-xs text-muted">Last call {fmt(row.last_call_at)}</p>
          ) : null}
        </div>

        {/* what to do */}
        <div className="flex items-center gap-2 lg:justify-end">
          {open ? (
            <>
              {row.phone ? (
                <a
                  href={`tel:${row.phone}`}
                  className={buttonClass("secondary", "sm", "max-lg:flex-1")}
                  aria-label={`Call ${name}, ${formatUS(row.phone)}`}
                >
                  <Glyph name="phone" className="size-4" />
                  Call
                </a>
              ) : null}
              <Button
                size="sm"
                variant="primary"
                className="max-lg:flex-1"
                disabled={busy}
                onClick={() => void pitched()}
              >
                <Glyph name="check" className="size-4" />
                Pitched
              </Button>
              <OverflowMenu label={`More for ${name}`}>
                {row.emails === "running" ? (
                  <button
                    type="button"
                    className={MENU_ITEM}
                    onClick={() =>
                      void run(pauseApprovalAction({ approvalId: row.id }), "Emails paused")
                    }
                  >
                    Pause the emails
                  </button>
                ) : canResume(row) ? (
                  <button type="button" className={MENU_ITEM} onClick={() => void resume()}>
                    {row.emails_note === "held" ? "Start the emails" : "Resume the emails"}
                  </button>
                ) : null}
                <button type="button" className={MENU_ITEM} onClick={onEdit}>
                  Change the offer
                </button>
                <Link href={`/clients/${row.client_id}`} className={MENU_ITEM}>
                  Open the merchant
                </Link>
                <button
                  type="button"
                  className={cn(MENU_ITEM, "text-bad hover:text-bad")}
                  onClick={onClose}
                >
                  Close it (not going ahead)
                </button>
              </OverflowMenu>
            </>
          ) : (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(reopenApprovalAction({ approvalId: row.id }), "Back on Open approvals")
                }
              >
                Reopen
              </Button>
              <Link
                href={`/clients/${row.client_id}`}
                className={buttonClass("ghost", "sm")}
                aria-label={`Open ${name}`}
              >
                Open
              </Link>
            </>
          )}
        </div>
      </div>
      {open && row.note ? (
        <p className="mt-3 border-t border-border pt-3 text-xs text-text-2">{row.note}</p>
      ) : null}
    </li>
  );
}

function CloseDialog({ row, onDone }: { row: ApprovalRow; onDone: () => void }) {
  const call = useCall();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const name = row.business_name || row.contact_name;
  async function close() {
    setBusy(true);
    const res = await call(
      closeApprovalAction({ approvalId: row.id, reason }),
      `${name}: closed. Emails stopped.`,
    );
    setBusy(false);
    if (res) onDone();
  }
  return (
    <Dialog
      open
      onClose={onDone}
      title={`Close ${name}'s approval`}
      footer={
        <>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void close()}>
            Close it
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        It leaves Open approvals and the emails stop. You can reopen it from Closed.
      </p>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Common reasons">
        {CLOSE_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={reason === r}
            onClick={() => setReason(r)}
            className={cn(
              "h-10 rounded-full border px-3.5 text-[13px] font-medium transition sm:h-9",
              reason === r
                ? "border-accent/50 bg-accent-soft text-accent"
                : "border-border bg-surface text-text-2 hover:border-border-strong",
            )}
          >
            {r}
          </button>
        ))}
      </div>
      <label className="mt-4 block space-y-1.5">
        <span className="text-[12px] font-medium text-text-2">Why (optional)</span>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </label>
    </Dialog>
  );
}
