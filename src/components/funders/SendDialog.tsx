"use client";

import Link from "next/link";
import { useState } from "react";
import { sendToFundersAction } from "@/app/funders-actions";
import { useApp } from "@/components/app-context";
import { FormDialog, Muted, useRun } from "@/components/client/parts";
import { Badge, buttonClass, cn, Field, Input } from "@/components/ui";
import type { ClientCard } from "@/lib/data/types";
import { formatDate } from "@/lib/format";
import { checkFit, merchantFacts, selectedByDefault, type FitResult } from "@/lib/funders/fit";
import { ordinal } from "@/lib/funders/format";
import { isLiveSubmission, latestByFunder } from "@/lib/funders/offers";
import { SUBMISSION_STATUS_LABELS, type FunderRow, type SubmissionRow } from "@/lib/funders/types";
import { formatMoneyCompact } from "@/lib/money";

const LEVEL_ORDER = { fits: 0, check: 1, warn: 2 } as const;

interface Candidate {
  funder: FunderRow;
  fit: FitResult;
  earlier: SubmissionRow | undefined;
}

/** What the fit check is working from, with blanks spelled out as "unknown" so nothing looks like a failure. */
function MerchantLine({ card }: { card: ClientCard }) {
  const facts = merchantFacts(card);
  const bits = [
    facts.industry.trim() || "industry unknown",
    facts.state.trim() || "state unknown",
    facts.monthlyRevenueCents === null
      ? "revenue unknown"
      : `${formatMoneyCompact(facts.monthlyRevenueCents)}/mo`,
    facts.timeInBusinessMonths === null
      ? "time in business unknown"
      : `${facts.timeInBusinessMonths} mo in business`,
    facts.wantedAmountCents === null
      ? "amount wanted unknown"
      : `wants ${formatMoneyCompact(facts.wantedAmountCents)}`,
    `would be ${ordinal(facts.nextPosition)} position`,
  ];
  return (
    <p className="rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-sm text-text-2">
      <span className="font-medium text-text">Checking against:</span> {bits.join(" · ")}
    </p>
  );
}

function FitNote({ fit }: { fit: FitResult }) {
  if (fit.level === "fits") return <Badge tone="good">Fits</Badge>;
  if (fit.level === "check")
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge>Fits so far</Badge>
        <span className="text-xs text-muted">{fit.unknown.join(", ")} unknown</span>
      </span>
    );
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone="warn">Check first</Badge>
      <span className="text-xs text-warn">{fit.reasons.join("; ")}</span>
      {fit.unknown.length > 0 ? (
        <span className="text-xs text-muted">{fit.unknown.join(", ")} unknown</span>
      ) : null}
    </span>
  );
}

/**
 * Pick the funders to send this merchant to. Every funder is checked against the merchant's card:
 * the ones that fit are ticked, the ones that may pass are flagged in amber — a warning, never a block.
 */
export function SendDialog({
  card,
  funders,
  submissions,
  onClose,
}: {
  card: ClientCard;
  funders: FunderRow[];
  submissions: SubmissionRow[];
  onClose: () => void;
}) {
  const { today, maxLendersPerDeal } = useApp();
  const run = useRun();
  const facts = merchantFacts(card);
  const latest = latestByFunder(submissions);
  const candidates: Candidate[] = funders
    .filter((f) => f.active)
    .map((funder) => ({ funder, fit: checkFit(funder, facts), earlier: latest.get(funder.id) }))
    .sort(
      (a, b) =>
        LEVEL_ORDER[a.fit.level] - LEVEL_ORDER[b.fit.level] ||
        a.funder.name.localeCompare(b.funder.name),
    );

  const [picked, setPicked] = useState<Set<string>>(
    () =>
      new Set(
        candidates
          .filter((c) => selectedByDefault(c.fit) && !(c.earlier && isLiveSubmission(c.earlier)))
          .map((c) => c.funder.id),
      ),
  );
  const [sentOn, setSentOn] = useState(today);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The shotgun check (P2-40): lenders that already hold this file plus the ones ticked now. A warning,
  // never a block — sometimes six lenders is the right call, but it should never happen by accident.
  const holding = candidates
    .filter((c) => c.earlier && isLiveSubmission(c.earlier))
    .map((c) => c.funder.id);
  const wouldHold = new Set([...holding, ...picked]).size;
  const shotgun = wouldHold > maxLendersPerDeal;

  async function send() {
    if (picked.size === 0) {
      setProblem("Pick at least one funder");
      return;
    }
    setProblem(null);
    setBusy(true);
    const names = candidates.filter((c) => picked.has(c.funder.id)).map((c) => c.funder.name);
    const ok = await run(
      sendToFundersAction({
        clientId: card.id,
        funderIds: [...picked],
        sentOn,
        note,
        force: shotgun,
      }),
      `Sent to ${names.join(", ")} — you'll be reminded to chase`,
    );
    setBusy(false);
    if (ok) onClose();
  }

  if (candidates.length === 0) {
    return (
      <FormDialog
        title={`Send ${card.business_name} to funders`}
        onClose={onClose}
        onSubmit={onClose}
        busy={false}
        submitLabel="Close"
      >
        <p className="text-sm">
          {funders.length === 0
            ? "You haven't added any funders yet."
            : "Every funder is archived right now."}{" "}
          Add the funders you send applications to, with what each one writes, and this list will
          check each of them against the merchant before you send.
        </p>
        <Link href="/funders" className={buttonClass("primary")}>
          Go to Funders
        </Link>
      </FormDialog>
    );
  }

  return (
    <FormDialog
      title={`Send ${card.business_name} to funders`}
      onClose={onClose}
      onSubmit={() => void send()}
      busy={busy}
      submitLabel={
        picked.size === 0
          ? "Send"
          : `Send${shotgun ? " anyway" : ""} to ${picked.size} ${picked.size === 1 ? "funder" : "funders"}`
      }
      wide
    >
      {problem ? (
        <p role="alert" className="rounded-lg bg-bad-soft p-3 text-sm text-bad">
          {problem}
        </p>
      ) : null}
      <MerchantLine card={card} />
      {shotgun ? (
        <p
          role="status"
          className="rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn"
        >
          <span className="font-semibold">Shotgun warning.</span> This file would be with{" "}
          {wouldHold} lenders; the shop limit is {maxLendersPerDeal}. Every lender who sees it is a
          backdoor risk — untick some, or send anyway on purpose.
        </p>
      ) : null}
      <ul
        className="divide-y divide-border overflow-hidden rounded-lg border border-border"
        aria-label="Funders"
      >
        {candidates.map(({ funder, fit, earlier }) => {
          const on = picked.has(funder.id);
          return (
            <li key={funder.id}>
              <label
                className={cn(
                  "flex min-h-12 cursor-pointer items-start gap-3 px-3 py-2 transition",
                  on ? "bg-accent-soft/60" : "hover:bg-surface-3",
                )}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 size-5 shrink-0 accent-accent"
                  checked={on}
                  onChange={() => toggle(funder.id)}
                  aria-label={funder.name}
                />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block text-sm font-medium">{funder.name}</span>
                  <FitNote fit={fit} />
                  {earlier ? (
                    <span className="block text-xs text-muted">
                      Sent {formatDate(earlier.sent_on, today)} —{" "}
                      {SUBMISSION_STATUS_LABELS[earlier.status].toLowerCase()}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field label="Sent on">
          <Input
            type="date"
            max={today}
            value={sentOn}
            onChange={(e) => setSentOn(e.target.value)}
            required
          />
        </Field>
        <Field label="Note" hint="Optional — shows on the timeline">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <Muted>
        A reminder to chase each funder is set for the next business day after the sent date.
        Logging a call or text with the merchant won&apos;t clear it; an answer from the funder
        will.
      </Muted>
    </FormDialog>
  );
}
