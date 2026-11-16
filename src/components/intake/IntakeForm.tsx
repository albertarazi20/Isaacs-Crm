"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { findDuplicatesAction } from "@/app/actions";
import { intakeLeadAction, type IntakeOutcome } from "@/app/intake-actions";
import { lookupSheetRowAction } from "@/app/sheets-actions";
import { useFormState } from "@/components/client/parts";
import { useToast } from "@/components/overlay";
import { Button, Card, Field, Input, Select, Textarea, cn } from "@/components/ui";
import type { BucketRow } from "@/lib/buckets/queries";
import { stageDef } from "@/lib/mca/stages";

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
}: {
  buckets: BucketRow[];
  defaultBucketId: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const { v, bind, set } = useFormState(() => ({ ...blank(), bucketId: defaultBucketId ?? "" }));
  const [lookup, setLookup] = useState<Lookup>(null);
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<IntakeOutcome | null>(null);
  const bucket = buckets.find((b) => b.id === v.bucketId) ?? null;

  async function onPhoneBlur() {
    const digits = v.phone.replace(/\D/g, "");
    if (digits.length < 7) return;
    setLooking(true);
    const [dup, sheet] = await Promise.all([
      findDuplicatesAction({ phone: v.phone }),
      lookupSheetRowAction({ phone: v.phone }),
    ]);
    setLooking(false);
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
      if (!v.firstName && first) set("firstName", first);
      if (!v.lastName && rest.length) set("lastName", rest.join(" "));
      if (!v.businessName) set("businessName", r.business_name);
      if (!v.email) set("email", r.email);
      if (!v.phone2) set("phone2", r.phone2);
      if (!v.email2) set("email2", r.email2);
      if (!v.industry) set("industry", r.industry);
      if (!v.state) set("state", r.state);
      if (!v.lookingFor) set("lookingFor", r.wanted);
      setLookup({ kind: "sheet", rowId: r.id, source: r.source_name });
    } else {
      setLookup(null);
    }
  }

  async function submit() {
    setBusy(true);
    const r = await intakeLeadAction({
      ...v,
      wantedAmount: v.wantedAmount || null,
      bucketId: v.bucketId || null,
      sheetRowId: lookup?.kind === "sheet" ? lookup.rowId : null,
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
    setDone(null);
  }

  if (done) {
    return (
      <Card className="space-y-3">
        <p className="text-lg font-semibold">
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
        <div className="flex gap-2">
          <Link
            href={`/clients/${done.clientId}`}
            className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg"
          >
            Open {done.businessName}
          </Link>
          <Button onClick={reset}>Add another</Button>
        </div>
      </Card>
    );
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void submit();
      }}
    >
      <Card className="space-y-4">
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
              onBlur={onPhoneBlur}
              placeholder="(305) 555-0100"
              inputMode="tel"
              autoFocus
              required
            />
          </Field>
          <Field label="Email">
            <Input {...bind("email")} type="email" placeholder="owner@business.com" />
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
        {lookup?.kind === "crm" ? (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
            This number is already in the CRM as{" "}
            <Link href={`/clients/${lookup.id}`} className="font-semibold underline">
              {lookup.name}
            </Link>{" "}
            — {whose(lookup.owner, lookup.place)}. Submitting will not make a second merchant.
          </p>
        ) : null}
      </Card>

      <Card className="flex flex-wrap items-end justify-between gap-3">
        <Field
          label="Bucket"
          hint="The bucket's first email goes out on submit; its reminders follow"
        >
          <Select {...bind("bucketId")} className="min-w-56">
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
          disabled={busy || looking}
          className={cn(bucket && "min-w-48")}
        >
          {busy ? "Submitting…" : bucket ? `Submit to ${bucket.name}` : "Add lead"}
        </Button>
      </Card>
    </form>
  );
}
