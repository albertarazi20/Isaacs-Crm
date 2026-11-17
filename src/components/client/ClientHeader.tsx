"use client";

import Link from "next/link";
import { AskButton } from "@/components/assistant/AskButton";
import { merchantBrief } from "@/lib/assistant/prompts";
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
import {
  CORE_STAGES,
  foldStage,
  stageDef,
  STAGE_GROUPS,
  STAGES,
  timerLabel,
} from "@/lib/mca/stages";
import { formatMoney } from "@/lib/money";
import { ContactStatusButton } from "./ContactStatus";
import { ContactActions } from "../ContactActions";
import { toggleHot, useHotIds } from "../power/prefs";
import { SourceInput } from "../SourceInput";
import { StageBadge } from "../StageBadge";
import { useStageMove } from "../stage-move/useStageMove";
import { useApp } from "../app-context";
import { useCall } from "../overlay";
import { Avatar, Badge, Button, cn, Field, Input } from "../ui";
import { Icon, type IconName } from "./icons";
import { clientFieldsPayload, clientForm, dateInTz, dueTone, type ClientForm } from "./logic";
import { Dot } from "./primitives";
import { FormDialog, useCopy, useFormState, useRun } from "./parts";

const CHIP =
  "inline-flex h-11 max-w-full items-center gap-2 rounded-full border border-border bg-surface-3/70 px-3 text-[13px] font-medium whitespace-nowrap text-text-2 sm:h-8";

/** A value you can copy with one click: the icon says what it is, the copy mark lights up on hover. */
function CopyChip({
  icon,
  value,
  shown,
  label,
}: {
  icon: IconName;
  value: string;
  shown: string;
  label: "phone" | "email";
}) {
  const copy = useCopy();
  return (
    <button
      type="button"
      title={`Copy ${label}`}
      onClick={() => void copy(value, label)}
      className={cn(
        CHIP,
        "group pr-2.5 text-text transition duration-150 hover:border-border-strong hover:bg-surface-2 active:scale-[0.97]",
      )}
    >
      <Icon name={icon} className="size-3.5 text-muted" />
      <span className="sr-only">Copy {label}: </span>
      <span className="truncate tabular-nums">{shown}</span>
      <Icon name="copy" className="size-3.5 text-muted transition group-hover:text-accent" />
    </button>
  );
}

/** Star a merchant: it stays on top of Today on every device. */
function StarToggle({ id, name }: { id: string; name: string }) {
  const hot = useHotIds().has(id);
  return (
    <button
      type="button"
      aria-pressed={hot}
      aria-label={hot ? `Unstar ${name}` : `Star ${name}`}
      title={hot ? "Starred: always on top of Today" : "Star: keep on top of Today"}
      onClick={() => void toggleHot(id, hot)}
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-full transition duration-150 active:scale-90 sm:size-8",
        hot ? "bg-warn-soft text-warn" : "text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      <Icon name="star" filled={hot} />
    </button>
  );
}

/**
 * The top of a merchant: who they are, how to reach them, where they sit (stage, bucket, owner), and everything a rep
 * does to the record itself. Call, text and email sit beside the name on a wide screen; on a phone they ride in the
 * glass bar at the bottom (MobileActionBar).
 */
export function ClientHero({ detail, className }: { detail: ClientDetail; className?: string }) {
  const { card, bringIn } = detail;
  const { today, timezone } = useApp();
  const { requestMove, dialogs } = useStageMove();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const current = foldStage(card.stage);

  async function move(stage: string) {
    const def = STAGES.find((s) => s.key === stage);
    if (!def || def.key === current) return;
    setMoving(true);
    await requestMove(card, def.key);
    setMoving(false);
  }

  const addChip = (what: string, icon: IconName) => (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={cn(
        CHIP,
        "border-dashed border-border-strong text-muted transition duration-150 hover:border-accent/50 hover:text-accent active:scale-[0.97]",
      )}
    >
      <Icon name={icon} className="size-3.5" />
      Add {what}
    </button>
  );
  const facts = [
    card.dba ? `dba ${card.dba}` : "",
    card.industry,
    card.state,
    card.monthly_revenue_cents !== null
      ? `${formatMoney(card.monthly_revenue_cents)}/mo revenue`
      : "",
    card.time_in_business_months !== null ? `${card.time_in_business_months} mo in business` : "",
    card.source ? `Source: ${card.source}` : "",
  ].filter(Boolean);
  const tone = card.next_due_on ? dueTone(card.next_due_on, today) : "later";

  return (
    <header
      className={cn(
        "ring-brand relative overflow-hidden rounded-3xl border border-border bg-surface",
        className,
      )}
    >
      <div
        aria-hidden
        className="bg-brand-soft pointer-events-none absolute inset-x-0 top-0 h-32 [mask-image:linear-gradient(to_bottom,black,transparent)]"
      />
      <div className="relative p-4 sm:p-6">
        <div className="flex flex-wrap items-start gap-x-5 gap-y-4">
          <Avatar
            name={card.business_name}
            size={60}
            className="rounded-2xl shadow-card max-sm:!size-12 max-sm:!text-base"
          />
          <div className="min-w-0 flex-1 basis-64">
            <Link
              href="/clients"
              className="eyebrow mb-1.5 inline-flex items-center gap-1.5 transition hover:text-text max-sm:-mt-3 max-sm:mb-0 max-sm:h-10"
            >
              <Icon name="arrowLeft" className="size-3" />
              Merchants
            </Link>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h1 className="min-w-0 text-[26px] leading-[1.1] font-semibold tracking-[-0.03em] break-words sm:text-[30px]">
                {card.business_name}
              </h1>
              <StarToggle id={card.id} name={card.business_name} />
              <StageBadge stage={card.stage} />
              {bringIn.brought_in_at ? (
                <Badge tone="good">
                  <Icon name="check" className="size-3" />
                  Brought in
                </Badge>
              ) : null}
            </div>
            <p className="mt-1.5 text-sm text-text-2">
              {card.contact_name ? (
                <span className="font-medium text-text">{card.contact_name}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="text-muted underline decoration-dotted underline-offset-4 transition hover:text-accent"
                >
                  Add the merchant&apos;s name
                </button>
              )}
              {facts.length > 0 ? <span className="text-muted"> · {facts.join(" · ")}</span> : null}
            </p>
          </div>
          <div className="max-sm:hidden">
            <ContactActions client={card} size="md" explain="always" />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {card.phone ? (
            <CopyChip icon="phone" value={card.phone} shown={formatUS(card.phone)} label="phone" />
          ) : (
            addChip("phone", "phone")
          )}
          {card.email ? (
            <CopyChip icon="mail" value={card.email} shown={card.email} label="email" />
          ) : (
            addChip("email", "mail")
          )}
          <span className={CHIP} title="The bucket this merchant is in">
            <Icon name="layers" className="size-3.5 text-muted" />
            <span className="truncate">{bringIn.bucket_name ?? "No bucket"}</span>
          </span>
          {bringIn.owner_name ? (
            <span className={cn(CHIP, "pl-1.5")} title="Whose merchant this is">
              <Avatar name={bringIn.owner_name} size={20} />
              <span className="truncate">{bringIn.owner_name}</span>
            </span>
          ) : null}
          <span className={cn(CHIP, "border-transparent bg-transparent px-1 text-muted")}>
            Since {formatDate(dateInTz(card.created_at, timezone), today)}
          </span>
        </div>
      </div>

      <div className="relative flex flex-wrap items-center gap-x-4 gap-y-2.5 border-t border-border bg-surface-3/50 px-4 py-3 sm:px-6">
        <p
          className={cn(
            "flex min-w-0 flex-1 basis-56 items-center gap-2 text-[13px]",
            tone === "overdue" ? "font-semibold text-bad" : "text-muted",
          )}
        >
          <Dot
            className={
              tone === "overdue" ? "text-bad" : tone === "today" ? "text-warn" : "text-good"
            }
          />
          {card.next_due_on && card.next_due_kind ? (
            <span className="truncate">
              Next: {timerLabel(card.next_due_kind).toLowerCase()}{" "}
              <span className={cn("font-medium", tone === "overdue" ? "" : "text-text")}>
                {formatDate(card.next_due_on, today)}
              </span>{" "}
              · {relativeDay(card.next_due_on, today)}
            </span>
          ) : bringIn.brought_in_at ? (
            "Handed off. Nothing left to chase."
          ) : (
            "No follow-up set"
          )}
        </p>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
          <div className="relative w-full sm:w-auto">
            <select
              aria-label="Move to stage"
              value=""
              disabled={moving}
              onChange={(e) => void move(e.target.value)}
              className="h-10 w-full cursor-pointer appearance-none rounded-full border border-border bg-surface pr-8 pl-3.5 text-sm font-medium text-text shadow-card transition duration-150 hover:border-border-strong hover:bg-surface-3 focus:border-accent focus:ring-[3px] focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:w-40 sm:text-[13px]"
            >
              <option value="">Move to…</option>
              {STAGE_GROUPS.map((g) => (
                <optgroup key={g.key} label={g.label}>
                  {CORE_STAGES.filter((s) => s.group === g.key).map((s) => (
                    <option key={s.key} value={s.key} disabled={s.key === current}>
                      {s.label}
                      {s.key === current ? " (current)" : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <Icon
              name="chevronDown"
              className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted"
            />
          </div>
          <AskButton
            size="sm"
            text="Next step"
            label={`Next step for ${card.business_name}`}
            prompt={merchantBrief(card.business_name, card.id)}
          />
          <Button size="sm" onClick={() => setEditing(true)}>
            <Icon name="note" className="size-3.5 text-muted" />
            Edit details
          </Button>
          <ContactStatusButton card={card} />
          <Button
            size="sm"
            variant="ghost"
            className="hover:bg-bad-soft hover:text-bad"
            onClick={() => setDeleting(true)}
          >
            <Icon name="trash" className="size-3.5" />
            Move to trash
          </Button>
        </div>
      </div>
      {dialogs}
      {editing ? <EditClientDialog card={card} onClose={() => setEditing(false)} /> : null}
      {deleting ? <DeleteClientDialog detail={detail} onClose={() => setDeleting(false)} /> : null}
    </header>
  );
}

/** Call, text and email, always under the thumb on a phone: a glass bar pinned to the bottom of the screen. */
export function MobileActionBar({ card }: { card: ClientDetail["card"] }) {
  return (
    <div className="glass-strong fixed inset-x-0 bottom-0 z-30 border-t border-border px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:hidden">
      <ContactActions client={card} size="md" bar />
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
              ? "Not a usable phone number yet. Call and Text stay off until it has 10 digits."
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
          className="space-y-2 rounded-xl border border-warn/40 bg-warn-soft p-3 text-sm"
        >
          <p className="font-semibold text-warn">This looks like someone you already have:</p>
          <ul className="space-y-2">
            {dupes.map((d) => (
              <li key={d.id} className="space-y-1">
                <a href={`/clients/${d.id}`} className="font-medium text-accent underline">
                  {d.business_name}
                </a>{" "}
                <span className="text-muted">
                  ({stageDef(d.stage).label}), {d.reason}
                  {d.trashed ? ". Removed, but marked do-not-contact." : ""}
                </span>
                {d.trashed ? null : merging?.id === d.id ? (
                  <div className="space-y-2 rounded-xl border border-border bg-surface p-3">
                    <p>
                      This moves every note, stip and document from{" "}
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
                      Same merchant: merge into this card
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
    count(detail.stips.length, "stip", "stips"),
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
        it any time from <em>Merchants, Trash</em>.
      </p>
      <p className="rounded-xl border border-border bg-surface-2 p-3 text-sm text-muted">
        Not ready to lose the notes? Close this and use <em>Move to…</em>, Not interested, instead.
        The client stays on your follow-up list and comes back when the timer is due.
      </p>
    </FormDialog>
  );
}

function count(n: number, one: string, many: string): string {
  return n === 0 ? "" : `${n} ${n === 1 ? one : many}`;
}
