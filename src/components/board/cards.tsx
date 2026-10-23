"use client";

import { useDraggable } from "@dnd-kit/core";
import Link from "next/link";
import { memo, useCallback, type PointerEvent, type ReactNode, type TouchEvent } from "react";
import { ContactActions } from "@/components/ContactActions";
import { StageBadge } from "@/components/StageBadge";
import { cn } from "@/components/ui";
import type { ClientCard } from "@/lib/data/types";
import { formatDate, formatDateTime, toLocalInput } from "@/lib/format";
import type { ISODate } from "@/lib/mca/dates";
import { formatUS } from "@/lib/mca/phone";
import { stageDef } from "@/lib/mca/stages";
import { formatMoneyCompact } from "@/lib/money";
import { APP_IN_STAGES, cardPaydown, lastContact, positionsText, STIP_STAGES } from "./logic";
import { DueChip, PaydownBar, Pill, remittanceText } from "./parts";

const who = (card: ClientCard) =>
  [card.contact_name, card.phone ? formatUS(card.phone) : ""].filter(Boolean).join(" · ");

/** Anything inside this must not start a card drag — dialogs opened from it live in the card's DOM. */
const stop = (e: PointerEvent | TouchEvent) => e.stopPropagation();

/**
 * The only part of a card that talks to dnd-kit. It re-renders when a drag starts or the hovered
 * column changes; its children are elements built by the memoised parent, so React skips them.
 */
function Shell({
  card,
  from,
  children,
}: {
  card: ClientCard;
  /** Where the card is now, in the words of the current view. */
  from: string;
  children: ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: card.id,
    data: { name: card.business_name, from },
    attributes: { role: "group", roleDescription: "draggable merchant card" },
  });
  const ref = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      setActivatorNodeRef(node);
    },
    [setNodeRef, setActivatorNodeRef],
  );
  return (
    <article
      ref={ref}
      aria-label={`${card.business_name}, ${from}`}
      {...attributes}
      {...listeners}
      className={cn(
        "group relative cursor-grab touch-manipulation rounded-lg border border-border bg-surface p-2.5 text-sm shadow-sm pointer-coarse:select-none [-webkit-touch-callout:none]",
        isDragging && "opacity-40",
      )}
    >
      {children}
    </article>
  );
}

function NameLink({ card }: { card: ClientCard }) {
  return (
    <Link
      href={`/clients/${card.id}`}
      prefetch={false}
      draggable={false}
      className="min-w-0 truncate font-semibold leading-snug hover:underline max-sm:py-3"
      title={card.dba ? `${card.business_name} (DBA ${card.dba})` : card.business_name}
    >
      {card.business_name}
    </Link>
  );
}

function PickerButton({
  label,
  aria,
  onClick,
}: {
  label: string;
  aria: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={aria}
      className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-text max-sm:h-10 max-sm:px-3 max-sm:text-sm"
    >
      {label}
    </button>
  );
}

/**
 * Last-call note by default; Call / Text / Email on hover or keyboard focus (always shown on touch
 * screens). Both occupy one row, so a card never changes height.
 */
function Footer({ card }: { card: ClientCard }) {
  const note = card.last_call_note?.trim() ?? "";
  return (
    <div className="mt-1.5 grid">
      <p
        title={note}
        className="truncate text-xs text-muted italic pointer-fine:self-center pointer-fine:[grid-area:1/1] pointer-fine:group-focus-within:invisible pointer-fine:group-hover:invisible"
      >
        {note ? `“${note}”` : ""}
      </p>
      <div
        onPointerDown={stop}
        onTouchStart={stop}
        className="mt-1 pointer-fine:invisible pointer-fine:mt-0 pointer-fine:[grid-area:1/1] pointer-fine:group-focus-within:visible pointer-fine:group-hover:visible"
      >
        <ContactActions client={card} size="sm" explain="touch" />
      </div>
    </div>
  );
}

function ContactLine({
  card,
  today,
  timezone,
}: {
  card: ClientCard;
  today: ISODate;
  timezone: string;
}) {
  const c = lastContact(card, today, timezone);
  return (
    <p className="mt-1 text-xs text-muted">
      {c.call}
      {c.touch ? ` · ${c.touch}` : ""}
    </p>
  );
}

function Money({ card }: { card: ClientCard }) {
  const group = stageDef(card.stage).group;
  const wanted = card.wanted_amount_cents;
  const approve = card.est_approval_cents;
  if (group === "prospecting" || group === "underwriting") {
    if (wanted === null && approve === null) return null;
    return (
      <p className="mt-1 text-xs">
        {wanted !== null ? (
          <span className="font-medium">Wants {formatMoneyCompact(wanted)}</span>
        ) : null}
        {approve !== null ? (
          <span className="text-muted">
            {wanted !== null ? " · " : ""}Funders would approve ~{formatMoneyCompact(approve)}
          </span>
        ) : null}
      </p>
    );
  }
  if (group === "exit" && wanted !== null)
    return <p className="mt-1 text-xs text-muted">Wanted {formatMoneyCompact(wanted)}</p>;
  return null;
}

function FundedLine({ card, today }: { card: ClientCard; today: ISODate }) {
  const pct = cardPaydown(card, today);
  const remit = remittanceText(card);
  if (pct === null && remit === null) return null;
  return (
    <div className="mt-1.5 space-y-1">
      {pct !== null ? <PaydownBar pct={pct} /> : null}
      <p className="flex justify-between gap-2 text-xs">
        <span className="truncate">{remit ?? ""}</span>
        {pct !== null ? <span className="shrink-0 font-medium">{pct}% paid down</span> : null}
      </p>
    </div>
  );
}

function DefaultLine({
  card,
  today,
  timezone,
}: {
  card: ClientCard;
  today: ISODate;
  timezone: string;
}) {
  if (card.funding_id === null) return null;
  const promise = card.promise_to_pay_at;
  const passed = promise !== null && toLocalInput(promise, timezone).slice(0, 10) < today;
  return (
    <div className="mt-1 space-y-0.5 text-xs">
      {card.defaulted_on ? <p>Defaulted {formatDate(card.defaulted_on, today)}</p> : null}
      {promise ? (
        <p className={passed ? "text-bad" : undefined}>
          Promise to pay <span suppressHydrationWarning>{formatDateTime(promise, timezone)}</span>
          {card.promise_amount_cents !== null
            ? ` · ${formatMoneyCompact(card.promise_amount_cents)}`
            : ""}
          {passed ? " (date passed)" : ""}
        </p>
      ) : (
        <p className="text-muted">No promise to pay yet</p>
      )}
    </div>
  );
}

interface CardProps {
  card: ClientCard;
  today: ISODate;
  timezone: string;
  onOpenPicker: (card: ClientCard) => void;
}

export const PipelineCard = memo(function PipelineCard({
  card,
  today,
  timezone,
  onOpenPicker,
}: CardProps) {
  const def = stageDef(card.stage);
  const positions = positionsText(card);
  const stips = STIP_STAGES.includes(card.stage) && card.stips_required > 0;
  return (
    <Shell card={card} from={def.label}>
      <div className="flex items-start justify-between gap-2">
        <NameLink card={card} />
        <PickerButton
          label="Move to…"
          aria={`Move ${card.business_name} to another stage`}
          onClick={() => onOpenPicker(card)}
        />
      </div>
      <p className="truncate text-xs text-muted">{who(card) || "No contact on file"}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <DueChip card={card} today={today} withDate={def.group === "funded"} />
        {stips ? (
          <Pill
            tone={card.stips_received >= card.stips_required ? "good" : "neutral"}
            title="Stips received"
          >
            Stips {card.stips_received}/{card.stips_required}
          </Pill>
        ) : null}
        {APP_IN_STAGES.includes(card.stage) && card.application_received_on ? (
          <Pill title="Date the signed application came in">
            App in {formatDate(card.application_received_on, today)}
          </Pill>
        ) : null}
        {positions ? <Pill tone="accent">{positions}</Pill> : null}
      </div>
      <Money card={card} />
      {def.group === "funded" ? <FundedLine card={card} today={today} /> : null}
      {def.group === "trouble" ? (
        <DefaultLine card={card} today={today} timezone={timezone} />
      ) : null}
      <ContactLine card={card} today={today} timezone={timezone} />
      <Footer card={card} />
    </Shell>
  );
});

export const FollowUpCard = memo(function FollowUpCard({
  card,
  today,
  timezone,
  bucketLabel,
  onOpenPicker,
}: CardProps & { bucketLabel: string }) {
  const def = stageDef(card.stage);
  const positions = positionsText(card);
  return (
    <Shell card={card} from={bucketLabel}>
      <div className="flex items-start justify-between gap-2">
        <NameLink card={card} />
        <PickerButton
          label="Follow up in…"
          aria={`Choose when to follow up with ${card.business_name}`}
          onClick={() => onOpenPicker(card)}
        />
      </div>
      <p className="truncate text-xs text-muted">{who(card) || "No contact on file"}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <StageBadge stage={card.stage} />
        {positions ? <Pill tone="accent">{positions}</Pill> : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        {card.next_due_on ? (
          <span className="font-medium">Due {formatDate(card.next_due_on, today)}</span>
        ) : null}
        <DueChip card={card} today={today} />
      </div>
      <Money card={card} />
      {def.group === "funded" ? <FundedLine card={card} today={today} /> : null}
      {def.group === "trouble" ? (
        <DefaultLine card={card} today={today} timezone={timezone} />
      ) : null}
      <ContactLine card={card} today={today} timezone={timezone} />
      <Footer card={card} />
    </Shell>
  );
});

/** What follows the pointer while dragging: just enough to know which merchant it is. */
export function DragFace({ card, detail }: { card: ClientCard; detail: string }) {
  return (
    <div className="cursor-grabbing rounded-lg border-2 border-accent bg-surface p-2.5 text-sm shadow-xl">
      <p className="truncate font-semibold">{card.business_name}</p>
      <p className="truncate text-xs text-muted">{who(card) || "No contact on file"}</p>
      <p className="mt-1 text-xs font-medium text-accent">{detail}</p>
    </div>
  );
}
