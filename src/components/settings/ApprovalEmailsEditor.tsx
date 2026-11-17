"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { setApprovalSettingsAction } from "@/app/approval-actions";
import { APPROVAL_FIELD_HELP, APPROVAL_FIELDS, SAMPLE_VALUES } from "@/lib/approvals/html";
import { useCall, useToast } from "../overlay";
import { Badge, Button, Field, Select } from "../ui";
import {
  hourLabel,
  windowSummary,
  type ApprovalEmailView,
  type ApprovalWindowView,
} from "./approvalCadence";
import { ApprovalEmailCard } from "./ApprovalEmailCard";
import { ApprovalSequence } from "./ApprovalSequence";
import { CopyButton } from "./CopyButton";
import { SettingsCard, StatusChip } from "./primitives";
import { Toggle } from "./Toggle";

const START_HOURS = Array.from({ length: 24 }, (_, h) => h);
const END_HOURS = Array.from({ length: 24 }, (_, h) => h + 1);

/** On or off, and the daytime the emails may go in: saved together. */
function ApprovalWindowCard({ initial }: { initial: ApprovalWindowView }) {
  const call = useCall();
  const toast = useToast();
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(v) !== JSON.stringify(saved);
  const invalid = v.windowStart >= v.windowEnd;
  const set = <K extends keyof ApprovalWindowView>(k: K, value: ApprovalWindowView[K]) =>
    setV((cur) => ({ ...cur, [k]: value }));

  async function save() {
    if (!dirty || invalid) return;
    const next = v;
    setBusy(true);
    const ok = await call(
      setApprovalSettingsAction(next).then((r) => (r.ok ? { ok: true as const, data: true } : r)),
    );
    setBusy(false);
    if (!ok) return;
    setSaved(next);
    toast({
      message: next.on ? "Approval emails: saved" : "Approval emails are switched off",
      tone: "success",
    });
    router.refresh();
  }

  return (
    <SettingsCard
      id="approval-when"
      title="When they go"
      description="Only in the merchant's daytime: an email that comes due at night waits for the morning. US holidays follow the rule on the Email page."
      aside={
        saved.on ? (
          <StatusChip tone="good">On</StatusChip>
        ) : (
          <StatusChip tone="warn">Off</StatusChip>
        )
      }
      flush
      footer={
        <>
          {dirty ? (
            <span className="mr-auto text-xs font-medium text-accent">Unsaved changes</span>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={!dirty || invalid || busy}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="px-4 py-2 sm:px-5">
        <Toggle
          label="Send approval emails"
          hint="Off: nothing goes out. Approvals keep their place and carry on when it is back on."
          checked={v.on}
          onChange={(x) => set("on", x)}
        />
      </div>
      <div className="grid gap-3 border-t border-border p-4 sm:grid-cols-2 sm:p-5">
        <Field label="Earliest" hint="The merchant's own local time.">
          <Select
            value={String(v.windowStart)}
            aria-invalid={invalid || undefined}
            onChange={(e) => set("windowStart", Number(e.target.value))}
          >
            {START_HOURS.map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Latest" hint="Nothing goes out from this hour on.">
          <Select
            value={String(v.windowEnd)}
            aria-invalid={invalid || undefined}
            onChange={(e) => set("windowEnd", Number(e.target.value))}
          >
            {END_HOURS.map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </Select>
        </Field>
        {invalid ? (
          <p role="alert" className="text-xs font-medium text-bad sm:col-span-2">
            The day has to start before it ends.
          </p>
        ) : null}
      </div>
      <div className="border-t border-border px-4 py-2 sm:px-5">
        <Toggle
          label="Weekends too"
          hint="Off: Saturday and Sunday are skipped, and Monday morning picks up."
          checked={v.weekends}
          onChange={(x) => set("weekends", x)}
        />
      </div>
      <p className="border-t border-border px-4 py-3 text-xs text-muted sm:px-5">
        {invalid
          ? "Pick a start before the end."
          : windowSummary(v.windowStart, v.windowEnd, v.weekends)}
      </p>
    </SettingsCard>
  );
}

/** Every field a design may use, with what it fills in and a copy button. */
function ApprovalFieldsCard() {
  return (
    <SettingsCard
      id="approval-fields"
      title="Fields you can use"
      description="Type these into the design, or the subject line, where the merchant's details go. A field with no value (a rep with no phone on My account, say) holds that merchant's email until it has one."
      flush
    >
      <ul className="divide-y divide-border">
        {APPROVAL_FIELDS.map((f) => (
          <li
            key={f}
            className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 sm:px-5"
          >
            <code className="shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 font-mono text-[12.5px] text-accent">
              {`{{${f}}}`}
            </code>
            {f === "unsubscribe_link" ? <Badge tone="warn">Required</Badge> : null}
            <span className="min-w-0 flex-1 basis-40 text-[13px] text-muted">
              {APPROVAL_FIELD_HELP[f]}
              <span className="hidden text-text-2 sm:inline">
                {f === "unsubscribe_link" ? "" : ` · ${SAMPLE_VALUES[f]}`}
              </span>
            </span>
            <CopyButton value={`{{${f}}}`} label={`{{${f}}}`} />
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}

/**
 * Settings → Approval emails: the sequence, when it may send, one card per email and the fields. Server actions
 * revalidate the page, so the warnings over it and the timeline follow every save.
 */
export function ApprovalEmailsEditor({
  emails,
  sending,
}: {
  emails: ApprovalEmailView[];
  /** On or off, and the daytime window. */
  sending: ApprovalWindowView;
}) {
  // a follow-up just added: bring its card into view once the refreshed page draws it
  const scrollTo = useRef<number | null>(null);
  useEffect(() => {
    const step = scrollTo.current;
    if (step === null) return;
    const el = document.getElementById(`approval-email-${step}`);
    if (!el) return;
    scrollTo.current = null;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [emails]);
  return (
    <>
      <ApprovalSequence
        emails={emails}
        onAdded={(step) => {
          scrollTo.current = step;
        }}
      />
      <ApprovalWindowCard initial={sending} />
      {emails.map((e) => (
        <ApprovalEmailCard key={e.step} email={e} />
      ))}
      <ApprovalFieldsCard />
    </>
  );
}
