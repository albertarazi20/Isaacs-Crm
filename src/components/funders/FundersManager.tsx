"use client";

import { useState } from "react";
import { deleteFunderAction, setFunderActiveAction } from "@/app/funders-actions";
import { Muted, useRun } from "@/components/client/parts";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import { factorText, ordinal } from "@/lib/funders/format";
import { emptyScore, type ScoreRow } from "@/lib/funders/scoreboard";
import {
  DECLINE_REASON_LABELS,
  MONEY_TERM_DEFAULTS,
  RENEWAL_COMMISSION_BASIS_LABELS,
  type FunderRow,
} from "@/lib/funders/types";
import { formatMoneyCompact } from "@/lib/money";
import { FunderDialog } from "./FunderDialog";
import { QuietConfirm } from "./QuietConfirm";

/** The appetite as short chips: "Min revenue $50k", "Up to 2nd position", "Skips FL, NY"… Empty when they have no rules. */
export function appetiteChips(f: FunderRow): string[] {
  const chips: string[] = [];
  if (f.min_monthly_revenue_cents !== null)
    chips.push(`Min revenue ${formatMoneyCompact(f.min_monthly_revenue_cents)}/mo`);
  if (f.min_time_in_business_months !== null)
    chips.push(`Min ${f.min_time_in_business_months} mo in business`);
  if (f.max_position !== null) chips.push(`Up to ${ordinal(f.max_position)} position`);
  if (f.min_amount_cents !== null && f.max_amount_cents !== null)
    chips.push(
      `${formatMoneyCompact(f.min_amount_cents)} to ${formatMoneyCompact(f.max_amount_cents)} advances`,
    );
  else if (f.min_amount_cents !== null)
    chips.push(`Advances from ${formatMoneyCompact(f.min_amount_cents)}`);
  else if (f.max_amount_cents !== null)
    chips.push(`Advances up to ${formatMoneyCompact(f.max_amount_cents)}`);
  if (f.excluded_states.length > 0) chips.push(`Skips ${f.excluded_states.join(", ")}`);
  if (f.excluded_industries.length > 0) chips.push(`Skips ${f.excluded_industries.join(", ")}`);
  if (f.commission_points !== null) chips.push(`${f.commission_points} commission points`);
  if (f.renewal_paydown_pct !== null) chips.push(`Renews at ${f.renewal_paydown_pct}% paid down`);
  return chips;
}

/**
 * The money terms as chips: the two caps when set, and every clock — "Clawback 30 days", "Approval good 30 days",
 * "Statements fresh from the 5th", "Commission paid after 7 days", "Renewal commission on new money only".
 */
export function moneyTermChips(f: FunderRow): string[] {
  const chips: string[] = [];
  if (f.max_upsell_points !== null) chips.push(`Max ${f.max_upsell_points} upsell points`);
  if (f.psf_cap_pct !== null) chips.push(`PSF cap ${f.psf_cap_pct}% of the advance`);
  chips.push(`Clawback ${f.clawback_days} days`);
  chips.push(`Approval good ${f.approval_valid_days} days`);
  chips.push(`Statements fresh from the ${ordinal(f.statement_fresh_day)}`);
  chips.push(
    f.commission_paid_after_days === 0
      ? "Commission paid at funding"
      : `Commission paid after ${f.commission_paid_after_days} days`,
  );
  chips.push(
    `Renewal commission on ${RENEWAL_COMMISSION_BASIS_LABELS[f.renewal_commission_basis].toLowerCase()}`,
  );
  return chips;
}

/** True when every money term is still the shop default — the chips then say so in one line instead of seven. */
export function moneyTermsAreDefault(f: FunderRow): boolean {
  return (
    f.max_upsell_points === null &&
    f.psf_cap_pct === null &&
    f.clawback_days === MONEY_TERM_DEFAULTS.clawback_days &&
    f.approval_valid_days === MONEY_TERM_DEFAULTS.approval_valid_days &&
    f.statement_fresh_day === MONEY_TERM_DEFAULTS.statement_fresh_day &&
    f.commission_paid_after_days === MONEY_TERM_DEFAULTS.commission_paid_after_days &&
    f.renewal_commission_basis === MONEY_TERM_DEFAULTS.renewal_commission_basis
  );
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

/** Average days to a first answer: "Same day", "1 day", "1.5 days". */
function answerTime(days: number | null): string {
  if (days === null) return "—";
  if (days === 0) return "Same day";
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-base font-semibold">{value}</dd>
      {sub ? <dd className="truncate text-xs text-muted">{sub}</dd> : null}
    </div>
  );
}

function Scoreboard({ score }: { score: ScoreRow }) {
  if (score.submissions === 0) {
    return (
      <p className="border-t border-border pt-3 text-sm text-muted">
        Nothing sent yet. Results show up here once you send a merchant to this funder.
      </p>
    );
  }
  const decided = score.approvals + score.declines;
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Stat
          label="Sent"
          value={String(score.submissions)}
          sub={score.pending > 0 ? `${score.pending} waiting` : undefined}
        />
        <Stat
          label="Approval rate"
          value={score.approvalRate === null ? "—" : pct(score.approvalRate)}
          sub={decided === 0 ? "No answers yet" : `${score.approvals} of ${decided} answered`}
        />
        <Stat
          label="Average factor"
          value={score.avgFactor === null ? "—" : factorText(score.avgFactor)}
          sub={
            score.offerCount > 0
              ? `${score.offerCount} ${score.offerCount === 1 ? "offer" : "offers"}`
              : "No offers yet"
          }
        />
        <Stat
          label="Answers in"
          value={answerTime(score.avgDaysToRespond)}
          sub={score.noResponse > 0 ? `${score.noResponse} never answered` : undefined}
        />
      </dl>
      {score.declinesByReason.length > 0 ? (
        <p className="text-sm text-muted">
          <span className="font-medium text-text">Declined for:</span>{" "}
          {score.declinesByReason
            .map(
              (d) =>
                `${d.reason === "unspecified" ? "No reason given" : DECLINE_REASON_LABELS[d.reason]} ${d.count}`,
            )
            .join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function FunderCard({
  funder,
  score,
  onEdit,
}: {
  funder: FunderRow;
  score: ScoreRow;
  onEdit: () => void;
}) {
  const run = useRun();
  const [busy, setBusy] = useState(false);
  const chips = appetiteChips(funder);
  const money = moneyTermChips(funder);
  const contact = [funder.contact_name, funder.phone, funder.submission_email].filter(Boolean);

  async function toggle() {
    setBusy(true);
    await run(
      setFunderActiveAction({ id: funder.id, active: !funder.active }),
      funder.active ? `Archived ${funder.name}` : `Restored ${funder.name}`,
    );
    setBusy(false);
  }
  async function remove() {
    setBusy(true);
    await run(deleteFunderAction({ id: funder.id }), `Deleted ${funder.name}`);
    setBusy(false);
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <span className="truncate">{funder.name}</span>
            {funder.active ? null : <Badge>Archived</Badge>}
          </h2>
          {contact.length > 0 ? (
            <p className="mt-0.5 truncate text-sm text-muted">{contact.join(" · ")}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-1 sm:justify-end">
          <Button size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void toggle()}>
            {funder.active ? "Archive" : "Restore"}
          </Button>
          {score.submissions === 0 ? (
            <QuietConfirm
              label="Delete"
              confirmLabel="Click again to delete"
              busy={busy}
              onConfirm={() => void remove()}
            />
          ) : null}
        </div>
      </div>
      {chips.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="What they write">
          {chips.map((c) => (
            <li key={c}>
              <Badge>{c}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <Muted>No limits entered — the fit check treats this funder as writing everyone.</Muted>
      )}
      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">Money terms</p>
        {moneyTermsAreDefault(funder) ? (
          <Muted>
            Shop defaults — no points or PSF cap, {MONEY_TERM_DEFAULTS.clawback_days}-day clawback,
            approvals good {MONEY_TERM_DEFAULTS.approval_valid_days} days. Edit to set this
            lender&apos;s own.
          </Muted>
        ) : (
          <ul className="flex flex-wrap gap-1.5" aria-label="Money terms">
            {money.map((c) => (
              <li key={c}>
                <Badge tone="accent">{c}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
      {funder.notes ? <p className="text-sm whitespace-pre-wrap">{funder.notes}</p> : null}
      <Scoreboard score={score} />
    </Card>
  );
}

export function FundersManager({
  funders,
  scores,
}: {
  funders: FunderRow[];
  scores: Record<string, ScoreRow>;
}) {
  const [editing, setEditing] = useState<FunderRow | "new" | null>(null);
  const active = funders.filter((f) => f.active);
  const archived = funders.filter((f) => !f.active);
  const scoreOf = (id: string): ScoreRow => scores[id] ?? emptyScore(id);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Funders</h1>
          <p className="text-sm text-muted">
            Who you send applications to, what each one writes, and how they&apos;ve treated you.
          </p>
        </div>
        <Button variant="primary" onClick={() => setEditing("new")}>
          + Add funder
        </Button>
      </div>

      {funders.length === 0 ? (
        <EmptyState title="Start by adding the funders you send applications to">
          Put in what each one writes — the highest position, minimum revenue, states and industries
          they skip. Then open any merchant and press Send to funders: the CRM checks every funder
          against that merchant first, sets a reminder to chase the ones that go quiet, and keeps
          score of who approves, who declines and why.
        </EmptyState>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {active.map((f) => (
            <FunderCard key={f.id} funder={f} score={scoreOf(f.id)} onEdit={() => setEditing(f)} />
          ))}
        </div>
      )}

      {archived.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">Archived</h2>
          <div className="grid gap-4 xl:grid-cols-2">
            {archived.map((f) => (
              <FunderCard
                key={f.id}
                funder={f}
                score={scoreOf(f.id)}
                onEdit={() => setEditing(f)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {editing ? (
        <FunderDialog
          existing={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
