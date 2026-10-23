"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteClientAction, updateClientAction } from "@/app/actions";
import type { ClientDetail } from "@/lib/data/types";
import { formatDate, relativeDay } from "@/lib/format";
import { formatUS } from "@/lib/mca/phone";
import { STAGE_GROUPS, STAGES, TIMER_LABELS } from "@/lib/mca/stages";
import { formatMoney } from "@/lib/money";
import { ContactStatusButton } from "./ContactStatus";
import { ContactActions } from "../ContactActions";
import { StageBadge } from "../StageBadge";
import { useStageMove } from "../stage-move/useStageMove";
import { useApp } from "../app-context";
import { Button, cn, Field, Input, Select } from "../ui";
import { clientFieldsPayload, clientForm, dateInTz, dueTone, type ClientForm } from "./logic";
import { FormDialog, Muted, Stat, useCopy, useFormState, useRun } from "./parts";

/** Business name, stage, next follow-up and Call/Text/Email — pinned under the app nav while scrolling. */
export function StickyBar({ card }: { card: ClientDetail["card"] }) {
  const { today } = useApp();
  const tone = card.next_due_on ? dueTone(card.next_due_on, today) : "later";
  return (
    <div className="sticky top-[57px] z-20 rounded-xl border border-border bg-surface px-4 py-2.5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-bold tracking-tight">{card.business_name}</h1>
            <StageBadge stage={card.stage} />
          </div>
          <p
            className={cn(
              "mt-0.5 text-sm",
              tone === "overdue" ? "font-semibold text-bad" : "text-muted",
            )}
          >
            {card.next_due_on && card.next_due_kind ? (
              <>
                Next: {TIMER_LABELS[card.next_due_kind].toLowerCase()}{" "}
                <span className={cn("font-medium", tone === "overdue" ? "" : "text-text")}>
                  {formatDate(card.next_due_on, today)}
                </span>{" "}
                · {relativeDay(card.next_due_on, today)}
              </>
            ) : (
              "No follow-up set"
            )}
          </p>
        </div>
        <ContactActions client={card} size="md" />
      </div>
    </div>
  );
}

function CopyValue({ value, shown, label }: { value: string; shown: string; label: string }) {
  const copy = useCopy();
  return (
    <button
      type="button"
      title="Click to copy"
      onClick={() => void copy(value, label)}
      className="max-w-full truncate rounded text-left text-sm font-medium underline decoration-dotted underline-offset-4 hover:text-accent"
    >
      {shown}
    </button>
  );
}

export function ClientDetails({ detail }: { detail: ClientDetail }) {
  const { card } = detail;
  const { today, timezone } = useApp();
  const { requestMove, dialogs } = useStageMove();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);

  async function move(stage: string) {
    const def = STAGES.find((s) => s.key === stage);
    if (!def || def.key === card.stage) return;
    setMoving(true);
    await requestMove(card, def.key);
    setMoving(false);
  }

  const addLink = (what: string) => (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="text-sm text-muted underline decoration-dotted underline-offset-4 hover:text-accent"
    >
      Add {what}
    </button>
  );
  const facts = [
    card.industry,
    card.state,
    card.source ? `Source: ${card.source}` : "",
    card.monthly_revenue_cents !== null
      ? `${formatMoney(card.monthly_revenue_cents)}/mo revenue`
      : "",
    card.time_in_business_months !== null ? `${card.time_in_business_months} mo in business` : "",
  ].filter(Boolean);

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-5">
          <Stat label="Merchant">
            {card.contact_name || addLink("name")}
            {card.dba ? <span className="font-normal text-muted"> · dba {card.dba}</span> : null}
          </Stat>
          <Stat label="Phone">
            {card.phone ? (
              <CopyValue value={card.phone} shown={formatUS(card.phone)} label="phone" />
            ) : (
              addLink("phone")
            )}
          </Stat>
          <Stat label="Email" className="col-span-2 sm:col-span-1">
            {card.email ? (
              <CopyValue value={card.email} shown={card.email} label="email" />
            ) : (
              addLink("email")
            )}
          </Stat>
          <Stat label="Application in">
            {card.application_received_on ? (
              formatDate(card.application_received_on, today)
            ) : (
              <span className="font-normal text-muted">—</span>
            )}
          </Stat>
          <Stat label="Client since">{formatDate(dateInTz(card.created_at, timezone), today)}</Stat>
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-44">
            <Select
              aria-label="Move to stage"
              className="h-9"
              value=""
              disabled={moving}
              onChange={(e) => void move(e.target.value)}
            >
              <option value="">Move to…</option>
              {STAGE_GROUPS.map((g) => (
                <optgroup key={g.key} label={g.label}>
                  {STAGES.filter((s) => s.group === g.key).map((s) => (
                    <option key={s.key} value={s.key} disabled={s.key === card.stage}>
                      {s.label}
                      {s.key === card.stage ? " (current)" : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </div>
          <Button size="sm" onClick={() => setEditing(true)}>
            Edit details
          </Button>
          <ContactStatusButton card={card} />
          <Button size="sm" variant="danger" onClick={() => setDeleting(true)}>
            Delete client
          </Button>
        </div>
      </div>
      {facts.length > 0 ? <Muted className="mt-3">{facts.join(" · ")}</Muted> : null}
      {dialogs}
      {editing ? <EditClientDialog card={card} onClose={() => setEditing(false)} /> : null}
      {deleting ? <DeleteClientDialog detail={detail} onClose={() => setDeleting(false)} /> : null}
    </div>
  );
}

function EditClientDialog({ card, onClose }: { card: ClientDetail["card"]; onClose: () => void }) {
  const run = useRun();
  const { v, bind } = useFormState<ClientForm>(() => clientForm(card));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const ok = await run(
      updateClientAction({ clientId: card.id, fields: clientFieldsPayload(v) }),
      "Details saved",
    );
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <FormDialog
      title="Edit details"
      onClose={onClose}
      onSubmit={() => void save()}
      busy={busy}
      wide
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Business name">
          <Input {...bind("businessName")} required autoFocus />
        </Field>
        <Field label="DBA (doing business as)">
          <Input {...bind("dba")} />
        </Field>
        <Field label="Merchant name">
          <Input {...bind("contactName")} autoComplete="off" />
        </Field>
        <Field label="Phone">
          <Input {...bind("phone")} type="tel" inputMode="tel" />
        </Field>
        <Field label="Email">
          <Input {...bind("email")} type="email" inputMode="email" />
        </Field>
        <Field label="Industry">
          <Input {...bind("industry")} />
        </Field>
        <Field label="State">
          <Input {...bind("state")} />
        </Field>
        <Field label="Source (who sent them)">
          <Input {...bind("source")} />
        </Field>
        <Field label="Monthly revenue" hint="Like 50k or $75,000">
          <Input {...bind("monthlyRevenue")} inputMode="decimal" />
        </Field>
        <Field label="Time in business (months)">
          <Input {...bind("timeInBusinessMonths")} inputMode="numeric" />
        </Field>
        <Field label="Application received">
          <Input {...bind("applicationReceivedOn")} type="date" />
        </Field>
      </div>
    </FormDialog>
  );
}

function DeleteClientDialog({ detail, onClose }: { detail: ClientDetail; onClose: () => void }) {
  const { card } = detail;
  const router = useRouter();
  const run = useRun();
  const [busy, setBusy] = useState(false);
  const attached = [
    count(detail.activities.length, "note or history entry", "notes and history entries"),
    count(detail.positions.length, "other advance", "other advances"),
    count(detail.offers.length, "competing offer", "competing offers"),
    count(detail.stips.length, "stip", "stips"),
    count(detail.fundings.length, "funded advance", "funded advances"),
  ].filter(Boolean);

  async function remove() {
    setBusy(true);
    const ok = await run(
      deleteClientAction({ clientId: card.id }),
      `${card.business_name} deleted`,
    );
    if (ok) router.push("/clients");
    else setBusy(false);
  }

  return (
    <FormDialog
      title={`Delete ${card.business_name}?`}
      onClose={onClose}
      onSubmit={() => void remove()}
      busy={busy}
      submitLabel="Delete for good"
      danger
    >
      <p className="text-sm">
        This removes <strong>{card.business_name}</strong> and everything attached to it
        {attached.length > 0 ? `: ${attached.join(", ")}` : ""}. It can&apos;t be undone.
      </p>
      <p className="rounded-lg bg-surface-2 p-3 text-sm text-muted">
        Not ready to lose the notes? Close this and use <em>Move to…</em> instead (Not interested,
        Dead deal). The client stays on your follow-up list and comes back when the timer is due.
      </p>
    </FormDialog>
  );
}

function count(n: number, one: string, many: string): string {
  return n === 0 ? "" : `${n} ${n === 1 ? one : many}`;
}
