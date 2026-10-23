"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  findDuplicatesAction,
  mergeClientsAction,
  trashClientAction,
  updateClientAction,
} from "@/app/actions";
import type { DuplicateMatch } from "@/lib/data/queries";
import type { ClientDetail } from "@/lib/data/types";
import { formatDate, relativeDay } from "@/lib/format";
import { formatUS, normalizeUS } from "@/lib/mca/phone";
import { stageDef, STAGE_GROUPS, STAGES, TIMER_LABELS } from "@/lib/mca/stages";
import { formatMoney } from "@/lib/money";
import { ContactStatusButton } from "./ContactStatus";
import { ContactActions } from "../ContactActions";
import { SourceInput } from "../SourceInput";
import { StageBadge } from "../StageBadge";
import { useStageMove } from "../stage-move/useStageMove";
import { useApp } from "../app-context";
import { useCall } from "../overlay";
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
        <ContactActions client={card} size="md" explain="always" />
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
      className="max-w-full truncate rounded text-left text-sm font-medium underline decoration-dotted underline-offset-4 hover:text-accent max-sm:py-3"
    >
      {shown}
    </button>
  );
}

export function ClientDetails({ detail, className }: { detail: ClientDetail; className?: string }) {
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
      className="text-sm text-muted underline decoration-dotted underline-offset-4 hover:text-accent max-sm:py-3"
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
    <div className={cn("rounded-xl border border-border bg-surface p-4", className)}>
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
              className="sm:h-9"
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
            Move to trash
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
  const call = useCall();
  const router = useRouter();
  const { v, bind } = useFormState<ClientForm>(() => clientForm(card));
  const [busy, setBusy] = useState(false);
  // Another card that looks like this one, found when the phone or name was changed (the same warning Add client gives).
  const [dupes, setDupes] = useState<DuplicateMatch[] | null>(null);
  const [merging, setMerging] = useState<DuplicateMatch | null>(null);
  const identityChanged =
    normalizeUS(v.phone) !== normalizeUS(card.phone) ||
    v.businessName.trim().toLowerCase() !== card.business_name.trim().toLowerCase();

  async function save(force = false) {
    setBusy(true);
    if (!force && identityChanged) {
      const found = await call(
        findDuplicatesAction({ phone: v.phone, businessName: v.businessName, excludeId: card.id }),
      );
      if (found && found.length > 0) {
        setDupes(found);
        setBusy(false);
        return;
      }
    }
    const ok = await run(
      updateClientAction({ clientId: card.id, fields: clientFieldsPayload(v) }),
      "Details saved",
    );
    setBusy(false);
    if (ok) onClose();
  }

  async function merge(other: DuplicateMatch) {
    setBusy(true);
    const ok = await run(
      mergeClientsAction({ keepId: card.id, dropId: other.id }),
      `Merged ${other.business_name} into ${card.business_name}`,
    );
    setBusy(false);
    if (ok) {
      onClose();
      router.refresh();
    }
  }

  return (
    <FormDialog
      title="Edit details"
      onClose={onClose}
      onSubmit={() => void save(dupes !== null)}
      busy={busy}
      submitLabel={dupes ? "Save anyway" : "Save"}
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
        <Field
          label="Phone"
          hint={
            v.phone.trim() !== "" && normalizeUS(v.phone) === null
              ? "Not a usable phone number yet — Call and Text stay off until it has 10 digits."
              : undefined
          }
        >
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
          <SourceInput {...bind("source")} />
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
      {dupes ? (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-warn bg-warn-soft p-3 text-sm"
        >
          <p className="font-semibold text-warn">This looks like someone you already have:</p>
          <ul className="space-y-2">
            {dupes.map((d) => (
              <li key={d.id} className="space-y-1">
                <a href={`/clients/${d.id}`} className="font-medium text-accent underline">
                  {d.business_name}
                </a>{" "}
                <span className="text-muted">
                  ({stageDef(d.stage).label}) — {d.reason}
                  {d.trashed ? " — removed, but marked do-not-contact." : ""}
                </span>
                {d.trashed ? null : merging?.id === d.id ? (
                  <div className="space-y-2 rounded-md bg-surface p-2">
                    <p>
                      This moves every note, advance, stip and offer from{" "}
                      <strong>{d.business_name}</strong> onto <strong>{card.business_name}</strong>,
                      then removes the other card. It can&apos;t be undone.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy}
                        onClick={() => void merge(d)}
                      >
                        {busy ? "Merging…" : "Yes, merge them"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setMerging(null)}
                      >
                        Back
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <Button size="sm" onClick={() => setMerging(d)}>
                      Same merchant — merge into this card
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="text-muted">
            Not the same business? Choose <em>Save anyway</em> and both cards stay.
          </p>
        </div>
      ) : null}
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
      trashClientAction({ clientId: card.id }),
      `${card.business_name} moved to the trash`,
    );
    if (ok) router.push("/clients");
    else setBusy(false);
  }

  return (
    <FormDialog
      title={`Move ${card.business_name} to the trash?`}
      onClose={onClose}
      onSubmit={() => void remove()}
      busy={busy}
      submitLabel="Move to trash"
      danger
    >
      <p className="text-sm">
        <strong>{card.business_name}</strong> disappears from your lists and every reminder stops.
        {attached.length > 0 ? ` Kept in the trash: ${attached.join(", ")}.` : ""} You can restore
        it any time from <em>Clients → Trash</em>.
        {detail.fundings.length > 0
          ? " Its funded advances and commission also drop out of Earnings and Renewals until you restore it."
          : ""}
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
