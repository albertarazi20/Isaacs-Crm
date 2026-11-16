"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { findDuplicatesAction } from "@/app/actions";
import {
  intakeLeadAction,
  leadOwnerAction,
  type IntakeOutcome,
  type LeadOwnerInfo,
} from "@/app/intake-actions";
import { lookupSheetRowAction } from "@/app/sheets-actions";
import { useFormState } from "@/components/client/parts";
import { useToast } from "@/components/overlay";
import { Button, buttonClass, Card, Field, Input, Select, Textarea, cn } from "@/components/ui";
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

/** "Mike's lead, in Missing statements" — whose merchant it is and where it sits. */
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
    const r = await leadOwnerAction({ phone, email });
    if (!r.ok) return;
    setCanOverride(r.data.canOverride);
    setOwner(r.data.owner);
    if (!r.data.owner) setOverride(false);
  }

  async function lookUp(have: typeof v) {
    const digits = have.phone.replace(/\D/g, "");
    if (digits.length < 7) return;
    setLooking(true);
    const [dup, sheet, own] = await Promise.all([
      findDuplicatesAction({ phone: have.phone }),
      lookupSheetRowAction({ phone: have.phone }),
      leadOwnerAction({ phone: have.phone, email: have.email }),
    ]);
    setLooking(false);
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
    const r = await intakeLeadAction({
      ...v,
      wantedAmount: v.wantedAmount || null,
      bucketId: v.bucketId || null,
      sheetRowId: lookup?.kind === "sheet" ? lookup.rowId : null,
      override: owner !== null && canOverride && override,
    });
    setBusy(false);
    if (!r.ok) return toast({ message: r.error, tone: "error" });
    setDone(r.data);
    if (r.data.result === "duplicate")
      toast({
        message: `${r.data.businessName} is already in the CRM${r.data.existing ? ` — ${whose(r.data.existing.ownerName, r.data.existing.place)}` : ""}`,
        tone: "info",
      });
    else
      toast({
        message: r.data.welcomeSent
          ? `Lead in — the ${r.data.bucketName} email is on its way`
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
    return (
      <Card className="space-y-3 p-4 sm:p-5">
        <p className="text-base font-semibold tracking-tight">
          {done.result === "duplicate"
            ? `${done.businessName} was already here`
            : `${done.businessName} is in`}
        </p>
        <p className="text-sm text-muted">
          {done.result === "duplicate"
            ? `${done.existing ? `Already in the system: ${whose(done.existing.ownerName, done.existing.place)}. ` : ""}No second merchant was made. Open the existing one and log the call.`
            : done.welcomeSent
              ? `Filed to ${done.bucketName}. The first email is queued and the reminders follow until they reply, upload or sign.`
              : done.bucketName
                ? `Filed to ${done.bucketName}. No email went out — that bucket has no approved first-step template yet.`
                : "No bucket chosen, so no emails will go out until you move them."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href={`/clients/${done.clientId}`} className={buttonClass("primary", "md")}>
            Open {done.businessName}
          </Link>
          <Button onClick={reset}>Add another</Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <PasteLeadBox assistant={assistant} onSplit={onSplit} summary={pasted} />
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !blocked) void submit();
        }}
      >
        <Card className="space-y-4 p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Phone"
              hint={
                looking
                  ? "Looking it up…"
                  : lookup?.kind === "sheet"
                    ? `Found on ${lookup.source} — filled in`
                    : undefined
              }
            >
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
              />
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
            <Field label="First name">
              <Input {...bind("firstName")} placeholder="Mike" />
            </Field>
            <Field label="Last name">
              <Input {...bind("lastName")} placeholder="Ross" />
            </Field>
            <Field label="Business">
              <Input {...bind("businessName")} placeholder="Mike's Pizza" />
            </Field>
            <Field label="Industry">
              <Input {...bind("industry")} placeholder="Restaurant" />
            </Field>
            <Field label="Second phone">
              <Input {...bind("phone2")} inputMode="tel" />
            </Field>
            <Field label="Second email">
              <Input {...bind("email2")} type="email" />
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
          {owner ? (
            <div
              role="alert"
              className={cn(
                "space-y-2 rounded-lg border px-3 py-2 text-sm",
                canOverride
                  ? "border-warn/30 bg-warn-soft text-warn"
                  : "border-bad/30 bg-bad-soft text-bad",
              )}
            >
              <p className="font-semibold">{owner.line}</p>
              {canOverride ? (
                <>
                  {owner.clientId ? (
                    <p>
                      <Link href={`/clients/${owner.clientId}`} className="font-semibold underline">
                        Open {owner.businessName || "their lead"}
                      </Link>{" "}
                      — or add it to your own book anyway.
                    </p>
                  ) : null}
                  <label className="flex items-center gap-2 font-medium">
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
            </div>
          ) : null}
          {lookup?.kind === "crm" && !(owner && owner.clientId === lookup.id) ? (
            <p className="rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">
              This number is already in the CRM as{" "}
              <Link href={`/clients/${lookup.id}`} className="font-semibold underline">
                {lookup.name}
              </Link>{" "}
              — {whose(lookup.owner, lookup.place)}. Submitting will not make a second merchant.
            </p>
          ) : null}
        </Card>

        <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end sm:justify-between sm:p-5">
          <Field
            label="Bucket"
            hint="The bucket's first email goes out on submit; its reminders follow"
            className="min-w-0 sm:max-w-sm sm:flex-1"
          >
            <Select {...bind("bucketId")}>
              <option value="">No bucket — just add the lead</option>
              {buckets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.owner_id ? " (mine)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || looking || blocked}
            className={cn("shrink-0", bucket && "sm:min-w-48")}
          >
            {busy ? "Submitting…" : bucket ? `Submit to ${bucket.name}` : "Add lead"}
          </Button>
        </Card>
      </form>
    </div>
  );
}
