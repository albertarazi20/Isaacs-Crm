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
} from "@/lib/approvals/words";
import type { ActionResult } from "@/lib/data/types";
import { timeAgo } from "@/lib/format";
import { callWindow, localTime } from "@/lib/followup/dial";
import { diffDays, type ISODate } from "@/lib/mca/dates";
import { formatUS } from "@/lib/mca/phone";
import { formatMoney } from "@/lib/money";
import { useApp } from "../app-context";
import { copyText } from "../client/parts";
import { OverflowMenu } from "../OverflowMenu";
import { Dialog, useCall, useToast } from "../overlay";
import { Glyph } from "../shell/icons";
import { Avatar, Badge, Button, buttonClass, cn, Input, TONE_TEXT } from "../ui";
import { OfferForm } from "../offers/OfferForm";
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
  const [offering, setOffering] = useState<ApprovalRow | null>(null);
  return (
    <>
      <ul
        className="stagger grid gap-4 lg:grid-cols-2 2xl:grid-cols-3"
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
            onOffer={() => setOffering(r)}
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
      {offering ? (
        <OfferForm
          merchant={{
            id: offering.client_id,
            name: offering.business_name || offering.contact_name,
            email: offering.email,
            timezone: offering.timezone,
          }}
          approval={{
            id: offering.id,
            amountCents: offering.amount_cents,
            holdUntil: offering.hold_until,
            funder: offering.funder,
          }}
          onClose={() => setOffering(null)}
        />
      ) : null}
    </>
  );
}

/** A merchant's own clock: "EST 2:39 PM", amber outside 8 am to 9 pm there. */
function TheirTime({ timezone, nowMs }: { timezone: string; nowMs: number }) {
  const now = new Date(nowMs);
  const w = callWindow(timezone, now);
  let zone = "";
  try {
    zone =
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" })
        .formatToParts(now)
        .find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    zone = "";
  }
  return (
    <span
      className={cn(
        "block text-[11.5px] tabular-nums",
        w === "early" || w === "late" ? "font-medium text-warn" : "text-muted",
      )}
    >
      {[zone, localTime(timezone, now)].filter(Boolean).join(" ")}
      {w === "early"
        ? " · too early to call"
        : w === "late"
          ? " · too late to call"
          : " their time"}
    </span>
  );
}

/** The hold as a ring that empties toward the funder's date. */
function HoldRing({ row, today }: { row: ApprovalRow; today: ISODate }) {
  const hold = holdWords(row.hold_until, today);
  if (!row.hold_until || !hold)
    return (
      <div className="flex flex-col items-center text-center">
        <span className="flex size-[68px] items-center justify-center rounded-full border border-dashed border-border-strong text-[11px] font-medium text-muted">
          No date
        </span>
        <span className="mt-1.5 text-[11px] text-muted">Hold</span>
      </div>
    );
  const left = diffDays(today, row.hold_until as ISODate);
  const total = Math.max(
    1,
    diffDays(row.created_at.slice(0, 10) as ISODate, row.hold_until as ISODate),
  );
  const share = Math.max(0, Math.min(1, left / total));
  const r = 28;
  const c = 2 * Math.PI * r;
  const ink = hold.tone === "bad" ? "text-bad" : hold.tone === "warn" ? "text-warn" : "text-accent";
  return (
    <div className="flex flex-col items-center text-center" title={`${hold.label} · ${hold.left}`}>
      <span className={cn("relative flex size-[68px] items-center justify-center", ink)}>
        <svg aria-hidden viewBox="0 0 68 68" className="absolute inset-0 -rotate-90">
          <circle cx="34" cy="34" r={r} fill="none" strokeWidth="6" className="stroke-border" />
          <circle
            cx="34"
            cy="34"
            r={r}
            fill="none"
            strokeWidth="6"
            strokeLinecap="round"
            stroke="currentColor"
            strokeDasharray={`${share * c} ${c}`}
          />
        </svg>
        <span className="relative leading-none">
          <span className="block text-[18px] font-semibold tabular-nums">{Math.max(0, left)}</span>
          <span className="block text-[9.5px] font-semibold tracking-wide text-muted uppercase">
            {left === 1 ? "day" : "days"}
          </span>
        </span>
      </span>
      <span className="mt-1.5 text-[11px] font-medium text-text-2">{hold.label}</span>
      <span className={cn("text-[11px] font-medium", TONE_TEXT[hold.tone])}>{hold.left}</span>
    </div>
  );
}

function ApprovalItem({
  row,
  cadence,
  fmt,
  onEdit,
  onClose,
  onOffer,
}: {
  row: ApprovalRow;
  cadence: readonly CadenceStep[];
  fmt: (iso: string) => string;
  onEdit: () => void;
  onClose: () => void;
  onOffer: () => void;
}) {
  const { today, nowMs } = useApp();
  const call = useCall();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const status = emailsStatus(row, fmt);
  const name = row.business_name || row.contact_name;
  const open = row.status === "open";
  const sent = row.steps.filter((s) => s.status === "sent").length;
  const total = Math.max(cadence.length, ...row.steps.map((s) => s.step), 0);

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

  async function copyNumber() {
    const ok = await copyText(formatUS(row.phone));
    toast({
      message: ok ? `${formatUS(row.phone)} copied` : "Couldn't copy. Select the number yourself",
      tone: ok ? "success" : "error",
    });
  }

  return (
    <li
      className={cn(
        // the open "more" menu (and a focused control) lifts its card above the next one: each card is its own layer
        "relative flex flex-col rounded-3xl border bg-surface shadow-card transition duration-200 focus-within:z-30 has-[[aria-expanded=true]]:z-30",
        status.hot
          ? "border-accent/50 shadow-glow"
          : "border-border hover:-translate-y-px hover:border-border-strong",
      )}
    >
      {status.hot ? (
        <p className="flex items-center gap-2 rounded-t-3xl bg-accent px-5 py-2 text-[12.5px] font-semibold text-accent-fg">
          <span className="live-dot" />
          Replied · {status.detail}
        </p>
      ) : null}

      <div className="flex flex-1 flex-col gap-4 p-5">
        {/* who */}
        <div className="flex items-start gap-3">
          <Avatar name={name} size={42} />
          <div className="min-w-0 flex-1">
            <Link
              href={`/clients/${row.client_id}`}
              className="block truncate text-[15.5px] font-semibold tracking-[-0.01em] hover:underline"
            >
              {name}
            </Link>
            <p className="truncate text-xs text-muted">
              {[row.contact_name, row.rep_name ? `Rep: ${row.rep_name}` : ""]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {row.offer ? (
              <p
                className={cn(
                  "mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold ring-1 ring-inset",
                  row.offer.state === "accepted"
                    ? "bg-good-soft text-good ring-good/25"
                    : row.offer.state === "sent" && row.offer.views > 0
                      ? "bg-accent-soft text-accent ring-accent/30"
                      : "bg-surface-2 text-muted ring-border",
                )}
              >
                <Glyph
                  name={
                    row.offer.state === "accepted"
                      ? "check"
                      : row.offer.state === "sent" && row.offer.views > 0
                        ? "eye"
                        : "send"
                  }
                  className="size-3.5"
                />
                {row.offer.state === "accepted"
                  ? `Offer of ${formatMoney(row.offer.funded_cents)} accepted`
                  : row.offer.state === "sent"
                    ? row.offer.views > 0 && row.offer.last_viewed_at
                      ? `Offer opened ${row.offer.views === 1 ? "once" : `${row.offer.views}×`} · ${timeAgo(row.offer.last_viewed_at, new Date(nowMs))}`
                      : "Offer sent · not opened yet"
                    : row.offer.state === "expired"
                      ? "Offer expired"
                      : "Offer withdrawn"}
              </p>
            ) : null}
          </div>
          <Badge tone={status.tone === "neutral" ? "neutral" : status.tone}>{status.label}</Badge>
        </div>

        {/* the offer, and the hold or what happened to it */}
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="eyebrow">Approved</p>
            <p className="mt-1 text-[30px] leading-none font-semibold tracking-[-0.04em] tabular-nums">
              {formatMoney(row.amount_cents)}
            </p>
            <p className="mt-1.5 truncate text-xs text-muted" title={row.note || undefined}>
              {[row.funder, `approved ${timeAgo(row.created_at, new Date(nowMs))}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          {open ? (
            <HoldRing row={row} today={today} />
          ) : (
            <div className="shrink-0 text-right">
              <p className="eyebrow">{row.status === "pitched" ? "Pitched" : "Closed"}</p>
              <p className="mt-1 text-sm font-medium">
                {fmt((row.status === "pitched" ? row.pitched_at : row.closed_at) ?? row.created_at)}
              </p>
              <p className="max-w-40 truncate text-xs text-muted" title={row.closed_reason}>
                {row.status === "pitched"
                  ? row.pitched_by_name
                    ? `by ${row.pitched_by_name}`
                    : ""
                  : row.closed_reason}
              </p>
            </div>
          )}
        </div>

        {/* the emails */}
        <div className="rounded-2xl border border-border bg-surface-3/50 px-3.5 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="eyebrow">Approval emails</p>
            <p className="text-[11.5px] text-muted tabular-nums">
              {sent} of {total} sent
            </p>
          </div>
          <EmailSteps
            className="mt-2.5"
            cadence={cadence}
            steps={row.steps}
            nextStep={row.next_step}
            running={open && row.emails === "running" && !row.halt}
            fmt={fmt}
          />
          <p className="mt-2 text-xs text-muted">
            {status.hot ? "Emails stop when you press Pitched." : status.detail}
          </p>
          {row.last_call_at ? (
            <p className="mt-0.5 text-xs text-muted">Last call {fmt(row.last_call_at)}</p>
          ) : null}
        </div>

        {open && row.note ? (
          <p className="border-l-2 border-accent/40 pl-3 text-xs text-text-2">{row.note}</p>
        ) : null}
      </div>

      {/* the number and what to do */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          {row.phone ? (
            <>
              <button
                type="button"
                onClick={() => void copyNumber()}
                title="Copy this number"
                aria-label={`Copy ${name}'s number`}
                className="block cursor-copy truncate rounded text-[14px] font-semibold tabular-nums hover:text-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {formatUS(row.phone)}
              </button>
              <TheirTime timezone={row.timezone} nowMs={nowMs} />
            </>
          ) : (
            <span className="text-xs text-muted">No phone number</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {open ? (
            <>
              {row.phone ? (
                <a
                  href={`tel:${row.phone}`}
                  className={buttonClass("secondary", "sm")}
                  aria-label={`Call ${name}, ${formatUS(row.phone)}`}
                >
                  <Glyph name="phone" className="size-4" />
                  Call
                </a>
              ) : null}
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void pitched()}>
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
                <button type="button" className={MENU_ITEM} onClick={onOffer}>
                  Generate merchant offer
                </button>
                <button type="button" className={MENU_ITEM} onClick={onEdit}>
                  Change the approval
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
