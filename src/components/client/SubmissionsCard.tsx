"use client";

import Link from "next/link";
import { useState } from "react";
import {
  acceptOfferAction,
  removeOfferAction,
  removeSubmissionAction,
  setOfferStatusAction,
  setSubmissionStatusAction,
} from "@/app/funders-actions";
import { offerToFundingPrefill } from "@/components/funders/prefill";
import { QuietConfirm } from "@/components/funders/QuietConfirm";
import { SendDialog } from "@/components/funders/SendDialog";
import { DeclineDialog, OfferDialog, StipsDialog } from "@/components/funders/SubmissionDialogs";
import type { ClientCard, PositionRow, StipRow } from "@/lib/data/types";
import { formatDate } from "@/lib/format";
import {
  offerChips,
  offerExtras,
  offerTerms,
  SUBMISSION_ACTIONS,
  waitText,
  type SubmissionAction,
} from "@/lib/funders/offers";
import {
  DECLINE_REASON_LABELS,
  OFFER_STATUS_LABELS,
  SUBMISSION_STATUS_LABELS,
  type ClientFundersData,
  type FunderRow,
  type FunderOfferRow,
  type OfferStatus,
  type SubmissionRow,
  type SubmissionStatus,
} from "@/lib/funders/types";
import { buildSubmissionPackage, gmailComposeUrl } from "@/lib/funders/package";
import { formatMoney } from "@/lib/money";
import { useApp } from "../app-context";
import { useToast } from "../overlay";
import { useStageMove } from "../stage-move/useStageMove";
import { Badge, Button, buttonClass, cn, EmptyState } from "../ui";
import { Muted, Panel, useRun } from "./parts";

type Tone = "neutral" | "good" | "warn" | "bad" | "accent";
const STATUS_TONE: Record<SubmissionStatus, Tone> = {
  sent: "accent",
  stips_requested: "warn",
  approved: "good",
  declined: "bad",
  no_response: "neutral",
  withdrawn: "neutral",
};
const OFFER_TONE: Record<OfferStatus, Tone> = {
  open: "accent",
  presented: "accent",
  accepted: "good",
  declined: "neutral",
  expired: "neutral",
};

const ACTION_LABEL: Record<SubmissionAction, string> = {
  approved: "Approved",
  declined: "Declined",
  stips_requested: "Stips requested",
  no_response: "No response",
  withdrawn: "Withdrawn",
  reopen: "Back to waiting",
  stips_sent: "Stips sent",
  add_offer: "Add offer",
};

type Dialog =
  | { kind: "send" }
  | { kind: "decline"; sub: SubmissionRow }
  | { kind: "stips"; sub: SubmissionRow }
  | { kind: "offer"; sub: SubmissionRow }
  | null;

/**
 * Who this merchant went to, what each funder said, and the offers that came back. Everything here
 * is a database action — marking a funder approved, declined or silent changes the rows and the
 * reminders, not just the screen.
 */
export function SubmissionsCard({
  card,
  data,
  positions = [],
  stips = [],
  className,
}: {
  card: ClientCard;
  data: ClientFundersData;
  /** For the funder summary: the merchant's other advances and which statements are in. */
  positions?: readonly PositionRow[];
  stips?: readonly StipRow[];
  className?: string;
}) {
  const { today, senderName } = useApp();
  const toast = useToast();
  const run = useRun();
  const { requestMove, dialogs } = useStageMove();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const { funders, submissions } = data;
  const chips = offerChips(submissions);
  const activeFunders = funders.filter((f) => f.active);

  async function guarded(task: () => Promise<unknown>) {
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  }

  function act(sub: SubmissionRow, action: SubmissionAction) {
    switch (action) {
      case "approved":
      case "add_offer":
        return setDialog({ kind: "offer", sub });
      case "declined":
        return setDialog({ kind: "decline", sub });
      case "stips_requested":
        return setDialog({ kind: "stips", sub });
      case "no_response":
      case "withdrawn":
      case "reopen":
      case "stips_sent": {
        const status: SubmissionStatus =
          action === "reopen" || action === "stips_sent" ? "sent" : action;
        const done: Record<typeof action, string> = {
          no_response: `${sub.funder_name}: no response`,
          withdrawn: `Withdrawn from ${sub.funder_name}`,
          reopen: `Waiting on ${sub.funder_name} again — chase set`,
          stips_sent: `Stips sent to ${sub.funder_name} — chase set`,
        };
        return guarded(() =>
          run(
            setSubmissionStatusAction({ submissionId: sub.id, status }),
            done[action as keyof typeof done],
          ),
        );
      }
    }
  }

  /** Funded dialog, pre-filled from the offer. Cancelling it leaves the offer accepted. */
  function openFunded(sub: SubmissionRow, offer: FunderOfferRow) {
    const funder = funders.find((f) => f.id === sub.funder_id) ?? null;
    return requestMove(card, "funded", {
      fundingPrefill: offerToFundingPrefill(
        offer,
        sub.funder_name,
        funder,
        card.position_count + 1,
      ),
    });
  }

  function accept(sub: SubmissionRow, offer: FunderOfferRow) {
    return guarded(async () => {
      const ok = await run(
        acceptOfferAction({ offerId: offer.id }),
        `Accepted ${sub.funder_name}'s offer — fill in the funding details`,
      );
      if (ok) await openFunded(sub, offer);
    });
  }

  const summaryFor = (funderContact?: string) =>
    buildSubmissionPackage({ card, positions, stips, senderName, funderContact });

  async function copySummary() {
    const pkg = summaryFor();
    try {
      await navigator.clipboard.writeText(`${pkg.subject}\n\n${pkg.body}`);
      toast({ message: "Summary copied — paste it into your email", tone: "success" });
    } catch {
      toast({ message: "Couldn't copy — your browser blocked it", tone: "error" });
    }
  }

  const offerStatus = (offer: FunderOfferRow, status: OfferStatus, done: string) =>
    guarded(() => run(setOfferStatusAction({ offerId: offer.id, status }), done));

  return (
    <Panel
      title="Submissions"
      className={className}
      aside={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Link href="/funders" className={buttonClass("ghost", "sm")}>
            Funders
          </Link>
          <Button
            size="sm"
            onClick={() => void copySummary()}
            title="The merchant's facts as an email you can paste"
          >
            Copy summary
          </Button>
          <Button size="sm" variant="primary" onClick={() => setDialog({ kind: "send" })}>
            Send to funders
          </Button>
        </div>
      }
    >
      {chips.length > 0 ? (
        <p className="mb-3 rounded-lg bg-surface-2 p-3 text-sm" aria-label="Offers in">
          <span className="font-medium">Offers in:</span>{" "}
          {chips.map((c, i) => (
            <span key={c.offerId}>
              {i > 0 ? <span className="text-muted"> · </span> : null}
              <span className={cn(c.best ? "font-semibold text-good" : "")}>
                {c.funderName} {c.text}
              </span>
              {c.best ? (
                <Badge tone="good" className="ml-1">
                  lowest factor
                </Badge>
              ) : null}
            </span>
          ))}
        </p>
      ) : null}

      {submissions.length === 0 ? (
        <EmptyState title="Not sent to any funder yet">
          {activeFunders.length === 0
            ? "Add the funders you send applications to first, then send this merchant out. Each one is checked against the merchant's fields before you send."
            : "Send this merchant to funders to start tracking who answers. A reminder to chase each funder is set for the next business day."}
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {submissions.map((sub) => (
            <li
              key={sub.id}
              data-submission={sub.funder_name}
              className="rounded-lg border border-border p-3"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="min-w-0 truncate font-medium">{sub.funder_name}</p>
                <Badge tone={STATUS_TONE[sub.status]}>{SUBMISSION_STATUS_LABELS[sub.status]}</Badge>
                <span className="text-xs text-muted">Sent {formatDate(sub.sent_on, today)}</span>
                <EmailPackageLink
                  funder={funders.find((f) => f.id === sub.funder_id)}
                  summaryFor={summaryFor}
                />
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {[waitText(sub, today), chaseText(sub, today)].filter(Boolean).join(" · ")}
              </p>
              {sub.status === "declined" ? (
                <p className="mt-1 text-sm">
                  <span className="font-medium">
                    {sub.decline_reason ? DECLINE_REASON_LABELS[sub.decline_reason] : "Declined"}
                  </span>
                  {sub.decline_note ? ` — ${sub.decline_note}` : ""}
                </p>
              ) : null}
              {sub.note && sub.status !== "declined" ? (
                <p className="mt-1 text-sm whitespace-pre-wrap">{sub.note}</p>
              ) : null}

              {sub.offers.length > 0 ? (
                <ul className="mt-2 space-y-2">
                  {sub.offers.map((o) => (
                    <OfferItem
                      key={o.id}
                      offer={o}
                      busy={busy}
                      today={today}
                      showFund={card.funded_on === null || card.funded_on < o.received_on}
                      onAccept={() => void accept(sub, o)}
                      onFund={() => void openFunded(sub, o)}
                      onStatus={(status, done) => void offerStatus(o, status, done)}
                      onRemove={() =>
                        void guarded(() =>
                          run(removeOfferAction({ offerId: o.id }), "Offer removed"),
                        )
                      }
                    />
                  ))}
                </ul>
              ) : null}

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {SUBMISSION_ACTIONS[sub.status].map((a) => (
                  <Button
                    key={a}
                    size="sm"
                    variant={a === "approved" || a === "add_offer" ? "secondary" : "ghost"}
                    disabled={busy}
                    onClick={() => void act(sub, a)}
                  >
                    {ACTION_LABEL[a]}
                  </Button>
                ))}
                {sub.status === "sent" && sub.chase_due_on === null ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    title="No reminder is set for this one — set one for the next business day"
                    onClick={() =>
                      void guarded(() =>
                        run(
                          setSubmissionStatusAction({ submissionId: sub.id, status: "sent" }),
                          `Reminder set to chase ${sub.funder_name}`,
                        ),
                      )
                    }
                  >
                    Remind me to chase
                  </Button>
                ) : null}
                <span className="ml-auto">
                  <QuietConfirm
                    label="Remove"
                    confirmLabel="Click again to remove"
                    busy={busy}
                    onConfirm={() =>
                      void guarded(() =>
                        run(
                          removeSubmissionAction({ submissionId: sub.id }),
                          `Removed the submission to ${sub.funder_name}`,
                        ),
                      )
                    }
                  />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Muted className="mt-3">
        Offers here are what your funders came back with. Offers from other brokers or funders go
        under Competing offers.
      </Muted>

      {dialog?.kind === "send" ? (
        <SendDialog
          card={card}
          funders={funders}
          submissions={submissions}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "decline" ? (
        <DeclineDialog sub={dialog.sub} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "stips" ? (
        <StipsDialog sub={dialog.sub} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "offer" ? (
        <OfferDialog sub={dialog.sub} card={card} onClose={() => setDialog(null)} />
      ) : null}
      {dialogs}
    </Panel>
  );
}

/** "Chase Mon, Oct 26" while the reminder is open; "Chase overdue" once it has passed. */
function chaseText(sub: SubmissionRow, today: string): string {
  if (sub.chase_due_on === null) return "";
  if (sub.chase_due_on < today) return "Chase overdue";
  return `Chase ${formatDate(sub.chase_due_on, today)}`;
}

function OfferItem({
  offer: o,
  busy,
  today,
  showFund,
  onAccept,
  onFund,
  onStatus,
  onRemove,
}: {
  offer: FunderOfferRow;
  busy: boolean;
  today: string;
  showFund: boolean;
  onAccept: () => void;
  onFund: () => void;
  onStatus: (status: OfferStatus, done: string) => void;
  onRemove: () => void;
}) {
  const live = o.status === "open" || o.status === "presented";
  const extras = offerExtras(o, formatMoney);
  return (
    <li
      data-offer={o.status}
      className={cn(
        "rounded-lg border p-2.5",
        o.status === "accepted" ? "border-good bg-good-soft" : "border-border bg-surface-2",
        o.status === "declined" || o.status === "expired" ? "opacity-70" : "",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-sm">{offerTerms(o, formatMoney)}</p>
        <Badge tone={OFFER_TONE[o.status]}>{OFFER_STATUS_LABELS[o.status]}</Badge>
      </div>
      <p className="text-xs text-muted">
        {[extras, `received ${formatDate(o.received_on, today)}`].filter(Boolean).join(" · ")}
      </p>
      {o.note ? <p className="mt-1 text-sm whitespace-pre-wrap">{o.note}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {live ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={onAccept}>
            Accept
          </Button>
        ) : null}
        {o.status === "accepted" && showFund ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={onFund}>
            Mark funded
          </Button>
        ) : null}
        {o.status === "open" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onStatus("presented", "Marked as presented to the merchant")}
          >
            Presented
          </Button>
        ) : null}
        {live ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onStatus("declined", "Offer turned down")}
          >
            Turn down
          </Button>
        ) : null}
        {o.status === "declined" || o.status === "expired" || o.status === "accepted" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              onStatus("open", o.status === "accepted" ? "Acceptance undone" : "Offer reopened")
            }
          >
            {o.status === "accepted" ? "Undo accept" : "Reopen"}
          </Button>
        ) : null}
        <span className="ml-auto">
          <QuietConfirm
            label="Remove"
            confirmLabel="Click again to remove"
            busy={busy}
            onConfirm={onRemove}
          />
        </span>
      </div>
    </li>
  );
}

/** Opens a Gmail compose window to the funder's submission address with the summary filled in. Statements are attached by hand. */
function EmailPackageLink({
  funder,
  summaryFor,
}: {
  funder: FunderRow | undefined;
  summaryFor: (funderContact?: string) => { subject: string; body: string };
}) {
  const to = funder?.submission_email.trim();
  if (!funder || !to) return null;
  return (
    <a
      href={gmailComposeUrl(to, summaryFor(funder.contact_name))}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs font-medium text-accent underline"
      title={`Opens Gmail with the summary written for ${funder.name}. Attach the statements yourself.`}
    >
      Email package
    </a>
  );
}
