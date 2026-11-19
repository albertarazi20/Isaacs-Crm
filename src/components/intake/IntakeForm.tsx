"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { findDuplicatesAction } from "@/app/actions";
import {
  intakeLeadAction,
  leadOwnerAction,
  type IntakeOutcome,
  type LeadOwnerInfo,
} from "@/app/intake-actions";
import { lookupSheetRowAction } from "@/app/sheets-actions";
import { useFormState } from "@/components/client/parts";
import { NETWORK_ERROR, useToast } from "@/components/overlay";
import { Glyph, type GlyphName } from "@/components/shell/icons";
import { Badge, Button, buttonClass, Field, Input, Textarea, cn } from "@/components/ui";
import type { SplitResult } from "@/lib/ai/splitLeadLine";
import type { BucketRow } from "@/lib/buckets/queries";
import type { AssistantState } from "@/lib/leads/assistant";
import { applySplit, type PasteKey } from "@/lib/leads/paste";
import { stageDef } from "@/lib/mca/stages";
import { PasteLeadBox, type PasteSummary } from "./PasteLeadBox";

type Lookup =
  | { kind: "sheet"; rowId: string; source: string }
  | { kind: "crm"; id: string; name: string; owner: string; place: string }
  | null;

/** "Mike's lead, in Missing statements": whose merchant it is and where it sits. */
const whose = (owner: string, place: string) =>
  `${owner ? `${owner}'s lead` : "already a lead"}, in ${place}`;

const blank = () => ({
  firstName: "",
  lastName: "",
  businessName: "",
  phone: "",
  email: "",
  phone2: "",
  email2: "",
  industry: "",
  state: "",
  lookingFor: "",
  wantedAmount: "",
  bucketId: "",
});

/** A group of fields under one small-caps label. */
function Section({
  label,
  aside,
  children,
}: {
  label: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="eyebrow">{label}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

const CALLOUT = {
  good: "border-good/25 bg-good-soft text-good",
  warn: "border-warn/30 bg-warn-soft text-warn",
  bad: "border-bad/30 bg-bad-soft text-bad",
} as const;

/** What a lookup found, said right where the number was typed. */
function Callout({
  tone,
  icon,
  role,
  children,
}: {
  tone: keyof typeof CALLOUT;
  icon: GlyphName;
  role?: "alert" | "status";
  children: ReactNode;
}) {
  return (
    <div
      role={role}
      className={cn(
        "flex animate-pop items-start gap-2.5 rounded-2xl border px-3.5 py-3 text-[13px] leading-snug",
        CALLOUT[tone],
      )}
    >
      <Glyph name={icon} className="mt-px size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">{children}</div>
    </div>
  );
}

/** What choosing this bucket sets in motion, from the steps it holds. */
function sends(b: BucketRow): string {
  if (b.steps === 0) return "No emails set up yet";
  if (b.steps === 1) return "One email on submit";
  return `First email on submit, then ${b.steps - 1} reminder${b.steps === 2 ? "" : "s"}`;
}

function BucketOption({
  checked,
  onPick,
  title,
  mine,
  line,
}: {
  checked: boolean;
  onPick: () => void;
  title: string;
  mine?: boolean;
  line: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onPick}
      className={cn(
        "relative flex min-h-[68px] flex-col justify-center rounded-2xl border px-3.5 py-2.5 text-left transition duration-150 active:scale-[0.98]",
        checked
          ? "bg-brand-soft border-accent/60 shadow-card ring-1 ring-accent/40"
          : "border-border bg-surface-3/60 hover:border-border-strong hover:bg-surface-2/50",
      )}
    >
      <span className="flex items-center gap-1.5 pr-6">
        <span className="min-w-0 truncate text-[13px] font-semibold">{title}</span>
        {mine ? <Badge tone="accent">mine</Badge> : null}
      </span>
      <span className="mt-0.5 text-xs text-muted">{line}</span>
      <span
        aria-hidden
        className={cn(
          "absolute top-2.5 right-2.5 flex size-[18px] items-center justify-center rounded-full transition duration-150",
          checked ? "bg-brand text-white shadow-glow" : "border-[1.5px] border-border-strong",
        )}
      >
        {checked ? <Glyph name="check" className="size-2.5" strokeWidth={3.2} /> : null}
      </span>
    </button>
  );
}

/**
 * The intake form. Phone first: on blur it looks the number up on the connected Google Sheets (autofill, no AI)
 * and in the CRM (a duplicate is a warning, not a second merchant). Submit files the lead into the bucket and the
 * bucket's first email goes out right away.
 */
export function IntakeForm({
  buckets,
  defaultBucketId,
  assistant,
}: {
  buckets: BucketRow[];
  defaultBucketId: string | null;
  /** Whether "paste a lead line" can run on this server right now (key, switch, budget). */
  assistant: AssistantState;
}) {
  const router = useRouter();
  const toast = useToast();
  const { v, bind, set } = useFormState(() => ({ ...blank(), bucketId: defaultBucketId ?? "" }));
  const [lookup, setLookup] = useState<Lookup>(null);
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<IntakeOutcome | null>(null);
  // another rep's merchant behind this phone or email (S1-3), and a manager's choice to add the lead anyway
  const [owner, setOwner] = useState<LeadOwnerInfo | null>(null);
  const [override, setOverride] = useState(false);
  const [canOverride, setCanOverride] = useState(false);
  const [pasted, setPasted] = useState<PasteSummary | null>(null);
  const bucket = buckets.find((b) => b.id === v.bucketId) ?? null;
  // a rep cannot add another rep's merchant; a manager can once the override is ticked
  const blocked = owner !== null && !(canOverride && override);

  /** Ask across the shop whose merchant this is (the answer is the server's own line); a manager may override. */
  async function checkOwner(phone: string, email: string) {
    if (phone.replace(/\D/g, "").length < 7 && email.trim() === "") return setOwner(null);
    let r: Awaited<ReturnType<typeof leadOwnerAction>>;
    try {
      r = await leadOwnerAction({ phone, email });
    } catch {
      return toast({ message: NETWORK_ERROR, tone: "error" });
    }
    if (!r.ok) return;
    setCanOverride(r.data.canOverride);
    setOwner(r.data.owner);
    if (!r.data.owner) setOverride(false);
  }

  async function lookUp(have: typeof v) {
    const digits = have.phone.replace(/\D/g, "");
    if (digits.length < 7) return;
    setLooking(true);
    let found: [
      Awaited<ReturnType<typeof findDuplicatesAction>>,
      Awaited<ReturnType<typeof lookupSheetRowAction>>,
      Awaited<ReturnType<typeof leadOwnerAction>>,
    ];
    try {
      found = await Promise.all([
        findDuplicatesAction({ phone: have.phone }),
        lookupSheetRowAction({ phone: have.phone }),
        leadOwnerAction({ phone: have.phone, email: have.email }),
      ]);
    } catch {
      // a lookup that can't reach the server must not leave the form looking busy, or throw into the blur handler
      return toast({ message: NETWORK_ERROR, tone: "error" });
    } finally {
      setLooking(false);
    }
    const [dup, sheet, own] = found;
    if (own.ok) {
      setCanOverride(own.data.canOverride);
      setOwner(own.data.owner);
      if (!own.data.owner) setOverride(false);
    }
    if (dup.ok && dup.data[0]) {
      const d = dup.data[0];
      setLookup({
        kind: "crm",
        id: d.id,
        name: d.business_name,
        owner: d.owner_name,
        place: d.bucket_name ?? stageDef(d.stage).label,
      });
      return;
    }
    if (sheet.ok && sheet.data) {
      const r = sheet.data;
      const [first = "", ...rest] = r.contact_name.trim().split(/\s+/);
      if (!have.firstName && first) set("firstName", first);
      if (!have.lastName && rest.length) set("lastName", rest.join(" "));
      if (!have.businessName) set("businessName", r.business_name);
      if (!have.email) set("email", r.email);
      if (!have.phone2) set("phone2", r.phone2);
      if (!have.email2) set("email2", r.email2);
      if (!have.industry) set("industry", r.industry);
      if (!have.state) set("state", r.state);
      if (!have.lookingFor) set("lookingFor", r.wanted);
      setLookup({ kind: "sheet", rowId: r.id, source: r.source_name });
    } else {
      setLookup(null);
    }
  }

  /** The pasted line's fields go into the inputs; the lookups run again on the new phone and email. */
  async function onSplit(fields: SplitResult): Promise<PasteSummary> {
    const { next, filled, warning } = applySplit(v, fields);
    for (const k of Object.keys(next) as PasteKey[]) if (next[k] !== v[k]) set(k, next[k]);
    const summary = { filled, warning };
    setPasted(summary);
    setLookup(null);
    setOwner(null);
    setOverride(false);
    if (next.phone.replace(/\D/g, "").length >= 7) await lookUp(next);
    else await checkOwner(next.phone, next.email);
    return summary;
  }

  /** Typing a new phone or email drops the old answer; the blur asks again. */
  const forgetOwner = () => {
    setOwner(null);
    setOverride(false);
  };

  async function submit() {
    setBusy(true);
    let r: Awaited<ReturnType<typeof intakeLeadAction>>;
    try {
      r = await intakeLeadAction({
        ...v,
        wantedAmount: v.wantedAmount || null,
        bucketId: v.bucketId || null,
        sheetRowId: lookup?.kind === "sheet" ? lookup.rowId : null,
        override: owner !== null && canOverride && override,
      });
    } catch {
      // the typed lead stays in the form, so a dropped connection costs a retry, not the lead
      return toast({ message: NETWORK_ERROR, tone: "error" });
    } finally {
      setBusy(false);
    }
    if (!r.ok) return toast({ message: r.error, tone: "error" });
    setDone(r.data);
    if (r.data.result === "duplicate")
      toast({
        message: `${r.data.businessName} is already in the CRM${r.data.existing ? `: ${whose(r.data.existing.ownerName, r.data.existing.place)}` : ""}`,
        tone: "info",
      });
    else
      toast({
        message: r.data.welcomeSent
          ? `Lead in. The ${r.data.bucketName} email is on its way`
          : "Lead in",
        tone: "success",
      });
    router.refresh();
  }

  function reset() {
    const next = { ...blank(), bucketId: v.bucketId };
    for (const [k, val] of Object.entries(next)) set(k as keyof typeof next, val);
    setLookup(null);
    setOwner(null);
    setOverride(false);
    setPasted(null);
    setDone(null);
  }

  if (done) {
    const dup = done.result === "duplicate";
    return (
      <div className="animate-rise px-1 py-8 text-center" role="status">
        <span
          aria-hidden
          className={cn(
            "mx-auto flex size-[72px] animate-pop items-center justify-center rounded-full",
            dup ? "bg-warn-soft text-warn ring-1 ring-warn/30" : "bg-brand text-white shadow-glow",
          )}
        >
          <Glyph name={dup ? "user" : "check"} className="size-8" strokeWidth={2.2} />
        </span>
        <p className="eyebrow mt-6">{dup ? "No second merchant made" : "Lead added"}</p>
        <p className="mt-1.5 text-[26px] leading-tight font-semibold tracking-[-0.03em] text-balance">
          {dup ? `${done.businessName} was already here` : `${done.businessName} is in`}
        </p>
        <p className="mx-auto mt-2.5 max-w-sm text-sm leading-relaxed text-pretty text-muted">
          {dup
            ? `${done.existing ? `Already in the system: ${whose(done.existing.ownerName, done.existing.place)}. ` : ""}No second merchant was made. Open the existing one and log the call.`
            : done.welcomeSent
              ? `Filed to ${done.bucketName}. The first email is queued and the reminders follow until they reply, upload or sign.`
              : done.bucketName
                ? `Filed to ${done.bucketName}. No email went out. That bucket has no approved first-step template yet.`
                : "No bucket chosen, so no emails will go out until you move them."}
        </p>
        {dup ? null : (
          <dl className="mx-auto mt-6 grid max-w-sm grid-cols-2 gap-2 text-left">
            <div className="rounded-2xl border border-border bg-surface-3/60 px-3.5 py-2.5">
              <dt className="eyebrow">Bucket</dt>
              <dd className="mt-1 truncate text-[13px] font-semibold">
                {done.bucketName || "None"}
              </dd>
            </div>
            <div className="rounded-2xl border border-border bg-surface-3/60 px-3.5 py-2.5">
              <dt className="eyebrow">First email</dt>
              <dd
                className={cn(
                  "mt-1 flex items-center gap-1.5 text-[13px] font-semibold",
                  done.welcomeSent ? "text-good" : "text-text-2",
                )}
              >
                {done.welcomeSent ? <span className="live-dot" aria-hidden /> : null}
                {done.welcomeSent ? "Queued" : "Not sent"}
              </dd>
            </div>
          </dl>
        )}
        <div className="mt-7 flex flex-col justify-center gap-2 sm:flex-row">
          <Link
            href={`/clients/${done.clientId}`}
            className={buttonClass("primary", "lg", "sm:min-w-44")}
          >
            Open {done.businessName}
            <Glyph name="arrowRight" className="size-4" strokeWidth={2.2} />
          </Link>
          <Button size="lg" onClick={reset}>
            <Glyph name="plus" className="size-4" strokeWidth={2.2} />
            Add another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="-mb-5 space-y-6">
      <PasteLeadBox assistant={assistant} onSplit={onSplit} summary={pasted} />
      <form
        className="space-y-7"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !blocked) void submit();
        }}
      >
        <Section
          label="Contact"
          aside={
            looking ? (
              <span className="flex items-center gap-2 text-xs text-accent" role="status">
                <span className="live-dot" aria-hidden />
                Looking it up…
              </span>
            ) : null
          }
        >
          <Field label="Phone">
            <div className="relative">
              <Glyph
                name="phone"
                className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-muted"
              />
              <Input
                {...bind("phone")}
                onChange={(e) => {
                  bind("phone").onChange(e);
                  forgetOwner();
                }}
                onBlur={() => void lookUp(v)}
                placeholder="(305) 555-0100"
                inputMode="tel"
                autoFocus
                required
                className="h-12 pl-10 text-base font-medium tracking-wide tabular-nums sm:h-12"
              />
            </div>
          </Field>
          <Field label="Email">
            <Input
              {...bind("email")}
              onChange={(e) => {
                bind("email").onChange(e);
                forgetOwner();
              }}
              onBlur={() => void checkOwner(v.phone, v.email)}
              type="email"
              placeholder="owner@business.com"
            />
          </Field>
          {lookup?.kind === "sheet" ? (
            <Callout tone="good" icon="sheet" role="status">
              <p>
                <span className="font-semibold">Found on {lookup.source}.</span> Filled in from the
                sheet. Check it over before you submit.
              </p>
            </Callout>
          ) : null}
          {owner ? (
            <Callout tone={canOverride ? "warn" : "bad"} icon="alert" role="alert">
              <p className="font-semibold">{owner.line}</p>
              {canOverride ? (
                <>
                  {owner.clientId ? (
                    <p>
                      <Link href={`/clients/${owner.clientId}`} className="font-semibold underline">
                        Open {owner.businessName || "their lead"}
                      </Link>
                      , or add it to your own book anyway.
                    </p>
                  ) : null}
                  <label className="flex min-h-8 cursor-pointer items-center gap-2 font-medium">
                    <input
                      type="checkbox"
                      className="size-4 accent-accent"
                      checked={override}
                      onChange={(e) => setOverride(e.target.checked)}
                    />
                    Add it anyway (manager override)
                  </label>
                </>
              ) : (
                <p>A rep cannot add a lead another rep has. Ask a manager if it should move.</p>
              )}
            </Callout>
          ) : null}
          {lookup?.kind === "crm" && !(owner && owner.clientId === lookup.id) ? (
            <Callout tone="warn" icon="user" role="status">
              <p>
                This number is already in the CRM as{" "}
                <Link href={`/clients/${lookup.id}`} className="font-semibold underline">
                  {lookup.name}
                </Link>
                : {whose(lookup.owner, lookup.place)}. Submitting will not make a second merchant.
              </p>
            </Callout>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First name">
              <Input {...bind("firstName")} placeholder="Mike" />
            </Field>
            <Field label="Last name">
              <Input {...bind("lastName")} placeholder="Ross" />
            </Field>
          </div>
        </Section>

        <Section label="Business">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Business">
              <Input {...bind("businessName")} placeholder="Mike's Pizza" />
            </Field>
            <Field label="Industry">
              <Input {...bind("industry")} placeholder="Restaurant" />
            </Field>
            <Field label="State">
              <Input {...bind("state")} placeholder="FL" maxLength={2} className="uppercase" />
            </Field>
            <Field label="Amount they want">
              <Input {...bind("wantedAmount")} placeholder="50k" inputMode="decimal" />
            </Field>
          </div>
          <Field label="What are they looking for">
            <Textarea
              {...bind("lookingFor")}
              rows={3}
              placeholder="Working capital for a second truck; wants it by Friday; already has one position"
            />
          </Field>
        </Section>

        <Section label="Other ways to reach them">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Second phone">
              <Input {...bind("phone2")} inputMode="tel" />
            </Field>
            <Field label="Second email">
              <Input {...bind("email2")} type="email" />
            </Field>
          </div>
        </Section>

        <Section
          label="Bucket"
          aside={<span className="text-[11px] text-muted">Decides what gets sent</span>}
        >
          <div role="radiogroup" aria-label="Bucket" className="grid gap-2 sm:grid-cols-2">
            {buckets.map((b) => (
              <BucketOption
                key={b.id}
                checked={v.bucketId === b.id}
                onPick={() => set("bucketId", b.id)}
                title={b.name}
                mine={b.owner_id !== null}
                line={sends(b)}
              />
            ))}
            <BucketOption
              checked={v.bucketId === ""}
              onPick={() => set("bucketId", "")}
              title="No bucket"
              line="Just add the lead. Nothing sends."
            />
          </div>
        </Section>

        <div className="glass-strong sticky -bottom-5 z-10 -mx-5 flex items-center justify-between gap-3 border-t border-border px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:-mx-7 sm:px-7">
          <p className="min-w-0 text-xs leading-snug text-muted max-sm:hidden">
            {blocked ? (
              "Another rep has this merchant."
            ) : bucket ? (
              <>
                Goes to <span className="font-semibold text-text">{bucket.name}</span>.{" "}
                {bucket.steps > 0 ? "Its first email sends on submit." : "No email will go out."}
              </>
            ) : (
              "No bucket. Nothing is sent until you move them."
            )}
          </p>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            disabled={busy || looking || blocked}
            className="h-11 shrink-0 max-sm:flex-1 sm:min-w-48"
          >
            {busy ? "Submitting…" : bucket ? `Submit to ${bucket.name}` : "Add lead"}
          </Button>
        </div>
      </form>
    </div>
  );
}
