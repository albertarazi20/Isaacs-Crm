"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  acceptOfferAction,
  removeOfferAction,
  removeSubmissionAction,
  setOfferStatusAction,
  setSubmissionStatusAction,
} from "@/app/funders-actions";
import { ResubmitToOpsButton, SubmitToOpsButton } from "@/components/deals/SubmitToOps";
import { QuietConfirm } from "@/components/funders/QuietConfirm";
import { SendDialog } from "@/components/funders/SendDialog";
import { DeclineDialog, OfferDialog, StipsDialog } from "@/components/funders/SubmissionDialogs";
import type { ClientCard, PositionRow, StipRow } from "@/lib/data/types";
import { DEAL_STATUS_LABELS, type DealStatus } from "@/lib/deals/types";
import { formatDate } from "@/lib/format";
import {
  isPlainAction,
  offerChips,
  offerExtras,
  offerTerms,
  PLAIN_STATUS_ACTIONS,
  SUBMISSION_ACTIONS,
  waitText,
  type PlainAction,
  type SubmissionAction,
} from "@/lib/funders/offers";
import {
  DECLINE_REASON_LABELS,
  OFFER_STATUS_LABELS,
  SUBMISSION_STATUS_LABELS,
  type ClientFundersData,
  type DeclineReasonRow,
  type FunderRow,
  type FunderOfferRow,
  type OfferStatus,
  type OpenDeal,
  type SubmissionRow,
  type SubmissionStatus,
} from "@/lib/funders/types";
import { buildSubmissionPackage, gmailComposeUrl } from "@/lib/funders/package";
import { formatMoney } from "@/lib/money";
import { useApp } from "../app-context";
import { useToast } from "../overlay";
import { Badge, Button, buttonClass, cn, EmptyState } from "../ui";
import { Muted, Panel, useRun } from "./parts";

type Tone = "neutral" | "good" | "warn" | "bad" | "accent";
const STATUS_TONE: Record<SubmissionStatus, Tone> = {
  sent: "accent",
  stips_requested: "warn",
  approved: "good",
  revised: "good",
  declined: "bad",
  no_response: "neutral",
  withdrawn: "neutral",
  contracts_out: "accent",
  contracts_in: "accent",
  funding_call: "accent",
  funded: "good",
  expired: "neutral",
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
  contracts_out: "Contracts out",
  contracts_in: "Contracts in",
  funding_call: "Funding call",
};

/** The toast after a plain status change. */
const DONE_TEXT: Record<PlainAction, (name: string) => string> = {
  no_response: (n) => `${n}: no response`,
  withdrawn: (n) => `Withdrawn from ${n}`,
  reopen: (n) => `Waiting on ${n} again — chase set`,
  stips_sent: (n) => `Stips sent to ${n} — chase set`,
  contracts_out: (n) => `${n}: contracts out to the merchant`,
  contracts_in: (n) => `${n}: signed contracts are in`,
  funding_call: (n) => `${n}: funding call — press FUND when the money lands`,
};

type Dialog =
  | { kind: "send" }
  | { kind: "decline"; sub: SubmissionRow }
  | { kind: "stips"; sub: SubmissionRow }
  | { kind: "offer"; sub: SubmissionRow }
  | null;

/** The deal page with the FUND dialog already open on this lender. */
export const fundHref = (dealId: string, funderId: string): string =>
  `/deals/${dealId}?tab=offers&fund=${encodeURIComponent(funderId)}`;

/** The label a stored decline reason shows: the table's wording first, the typed list as the fallback. */
export function declineReasonLabel(
  key: SubmissionRow["decline_reason"],
  rows: readonly DeclineReasonRow[],
): string {
  if (!key) return "Declined";
  return rows.find((r) => r.key === key)?.label ?? DECLINE_REASON_LABELS[key] ?? key;
}

/**
 * Who this merchant went to, what each funder said, and the offers that came back. Everything here
 * is a database action — marking a funder approved, declined or silent changes the rows and the
 * reminders, not just the screen. Accepting an offer only accepts it: the money is recorded through
 * FUND on the deal page (propose → manager confirms), never from here.
 */
export function SubmissionsCard({
  card,
  data,
  positions = [],
  stips = [],
  canSubmitToOps = false,
  className,
}: {
  card: ClientCard;
  data: ClientFundersData;
  /** For the funder summary: the merchant's other advances and which statements are in. */
  positions?: readonly PositionRow[];
  stips?: readonly StipRow[];
  /** Reps and managers submit files to ops; ops does not (it is their queue). */
  canSubmitToOps?: boolean;
  className?: string;
}) {
  const { today, senderName } = useApp();
  const toast = useToast();
  const run = useRun();
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const { funders, submissions, declineReasons, deal } = data;
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
      default: {
        if (!isPlainAction(action)) return;
        return guarded(() =>
          run(
            setSubmissionStatusAction({
              submissionId: sub.id,
              status: PLAIN_STATUS_ACTIONS[action],
            }),
            DONE_TEXT[action](sub.funder_name),
          ),
        );
      }
    }
  }

  /** Accept only accepts. The money lands through FUND, which keeps the lender caps and the manager's confirm. */
  function accept(sub: SubmissionRow, offer: FunderOfferRow) {
    return guarded(() =>
      run(
        acceptOfferAction({ offerId: offer.id }),
        `Offer accepted — press FUND when the money lands`,
      ),
    );
  }

  /** "Mark funded" is the FUND dialog: already on this page (the deal page) or one hop away (the merchant page). */
  function fund(sub: SubmissionRow) {
    if (!deal) return;
    router.push(fundHref(deal.id, sub.funder_id));
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
          <Button
            size="sm"
            variant={canSubmitToOps && !deal ? "secondary" : "primary"}
            onClick={() => setDialog({ kind: "send" })}
          >
            Send to funders
          </Button>
          {canSubmitToOps && !deal ? (
            <SubmitToOpsButton
              clientId={card.id}
              businessName={card.business_name}
              wantedAmountCents={card.wanted_amount_cents}
              size="sm"
            />
          ) : null}
        </div>
      }
    >
      {deal ? <DealLine deal={deal} canSubmitToOps={canSubmitToOps} clientId={card.id} /> : null}

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
            : canSubmitToOps && !deal
              ? "Submit the file to ops and they send it to lenders — or send it yourself. A reminder to chase each funder is set for the next business day."
              : "Send this merchant to funders to start tracking who answers. A reminder to chase each funder is set for the next business day."}
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {submissions.map((sub) => (
            <li
              key={sub.id}
              data-submission={sub.funder_name}
              data-status={sub.status}
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
                    {declineReasonLabel(sub.decline_reason, declineReasons)}
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
                      showFund={
                        sub.status !== "funded" &&
                        (card.funded_on === null || card.funded_on < o.received_on)
                      }
                      fundHref={deal ? fundHref(deal.id, sub.funder_id) : null}
                      onAccept={() => void accept(sub, o)}
                      onFund={() => fund(sub)}
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
                {sub.status === "funded" ? (
                  <span className="text-xs text-muted">
                    Funded through FUND — the money and the commission live on the deal page.
                  </span>
                ) : null}
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
        <DeclineDialog sub={dialog.sub} reasons={declineReasons} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "stips" ? (
        <StipsDialog sub={dialog.sub} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "offer" ? (
        <OfferDialog sub={dialog.sub} card={card} onClose={() => setDialog(null)} />
      ) : null}
    </Panel>
  );
}

/** "D-12 · With ops" with the way to the deal page, and Resubmit when ops sent the file back. */
function DealLine({
  deal,
  canSubmitToOps,
  clientId,
}: {
  deal: OpenDeal;
  canSubmitToOps: boolean;
  clientId: string;
}) {
  const label = DEAL_STATUS_LABELS[deal.status as DealStatus] ?? deal.status.replace(/_/g, " ");
  const kicked = deal.ops_status === "kicked_back";
  return (
    <div
      className={cn(
        "mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2 text-sm",
        kicked ? "border-warn/40 bg-warn-soft" : "border-border bg-surface-2",
      )}
    >
      <Link href={`/deals/${deal.id}`} className="font-semibold hover:underline">
        Deal D-{deal.number}
      </Link>
      <Badge tone={kicked ? "warn" : "accent"}>{label}</Badge>
      {kicked && deal.kickback_note ? (
        <span className="min-w-0 truncate text-muted">{deal.kickback_note}</span>
      ) : null}
      <span className="ml-auto flex items-center gap-1.5">
        {kicked && canSubmitToOps ? (
          <ResubmitToOpsButton clientId={clientId} kind={deal.kind} size="sm" />
        ) : null}
        <Link href={`/deals/${deal.id}`} className={buttonClass("ghost", "sm")}>
          Open the deal →
        </Link>
      </span>
    </div>
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
  fundHref,
  onAccept,
  onFund,
  onStatus,
  onRemove,
}: {
  offer: FunderOfferRow;
  busy: boolean;
  today: string;
  showFund: boolean;
  /** Where FUND lives for this offer; null when the merchant has no open deal. */
  fundHref: string | null;
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
          fundHref ? (
            <Button
              size="sm"
              variant="primary"
              className="bg-good text-white shadow-good/30 hover:brightness-110"
              disabled={busy}
              title="Opens FUND on the deal page with this lender picked"
              onClick={onFund}
            >
              Mark funded
            </Button>
          ) : (
            <span className="text-xs text-muted">
              Submit the file to ops to open a deal — FUND lives on the deal page.
            </span>
          )
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
