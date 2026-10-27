"use client";

import { useState } from "react";
import Link from "next/link";
import { addClientAction, findDuplicatesAction } from "@/app/actions";
import type { DuplicateMatch } from "@/lib/data/queries";
import { formatDate } from "@/lib/format";
import { CORE_STAGES, defaultTimers, stageDef, type StageKey } from "@/lib/mca/stages";
import type { ISODate } from "@/lib/mca/dates";
import { useApp } from "./app-context";
import { Dialog, useCall, useToast } from "./overlay";
import { SourceInput } from "./SourceInput";
import { TimerPicker } from "./TimerPicker";
import { Button, Field, Input, Select } from "./ui";

const START_STAGES = CORE_STAGES.filter(
  (s) => s.group === "prospecting" || s.group === "underwriting",
);

const stageDue = (stage: StageKey, today: ISODate): ISODate =>
  defaultTimers(stage, { today })[0]?.dueOn ?? today;

const SOURCE_KEY = "isaac:lastSource";
const SOURCE_FRESH_MS = 30 * 60_000;
/**
 * Entering a batch from one list? The last source is already filled in — but only for half an hour, so a
 * walk-in added after lunch isn't silently credited to the morning's lead vendor. Storage may be blocked.
 */
function lastSource(): string {
  try {
    const saved = JSON.parse(localStorage.getItem(SOURCE_KEY) ?? "null") as {
      v?: unknown;
      at?: unknown;
    } | null;
    return typeof saved?.v === "string" &&
      typeof saved.at === "number" &&
      Date.now() - saved.at < SOURCE_FRESH_MS
      ? saved.v
      : "";
  } catch {
    return "";
  }
}
function rememberSource(source: string): void {
  try {
    if (source.trim())
      localStorage.setItem(SOURCE_KEY, JSON.stringify({ v: source.trim(), at: Date.now() }));
  } catch {
    /* storage blocked — nothing to remember */
  }
}

/** Add a client in five seconds: a name and a number is enough. */
export function QuickAdd() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        + Add client
      </Button>
      {open ? <QuickAddDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function QuickAddDialog({ onClose }: { onClose: () => void }) {
  const { today } = useApp();
  const call = useCall();
  const toast = useToast();
  const [stage, setStage] = useState<StageKey>("name_in");
  const [dueOn, setDueOn] = useState<ISODate>(() => stageDue("name_in", today));
  const [pickedDate, setPickedDate] = useState(false);
  const [busy, setBusy] = useState(false);

  const [dupes, setDupes] = useState<DuplicateMatch[] | null>(null);
  const [pending, setPending] = useState<Record<string, FormDataEntryValue | null> | null>(null);

  async function create(values: Record<string, FormDataEntryValue | null>) {
    setBusy(true);
    const card = await call(
      addClientAction({
        businessName: values.businessName,
        contactName: values.contactName,
        phone: values.phone,
        email: values.email,
        wantedAmount: values.wantedAmount,
        source: values.source,
        stage,
        followUpOn: dueOn,
      }),
    );
    setBusy(false);
    if (!card) return;
    rememberSource(String(values.source ?? ""));
    onClose();
    toast({
      message: `Added ${card.business_name} — follow up ${formatDate(dueOn, today)}`,
      tone: "success",
    });
  }

  async function submit(form: HTMLFormElement) {
    const f = new FormData(form);
    const values = {
      businessName: f.get("businessName"),
      contactName: f.get("contactName"),
      phone: f.get("phone"),
      email: f.get("email"),
      wantedAmount: f.get("wantedAmount"),
      source: f.get("source"),
    };
    setBusy(true);
    const found = await call(
      findDuplicatesAction({
        phone: String(values.phone ?? ""),
        businessName: String(values.businessName ?? ""),
      }),
    );
    setBusy(false);
    if (found && found.length > 0) {
      setPending(values);
      setDupes(found);
      return;
    }
    await create(values);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a client"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="quick-add-form" disabled={busy}>
            {busy ? "Adding…" : "Add client"}
          </Button>
        </>
      }
    >
      <form
        id="quick-add-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(e.currentTarget);
        }}
      >
        <Field label="Business name *">
          <Input name="businessName" required autoFocus placeholder="Mike's Pizza" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Merchant's name">
            <Input name="contactName" placeholder="Mike Ross" />
          </Field>
          <Field label="Phone">
            <Input name="phone" type="tel" placeholder="(555) 123-4567" />
          </Field>
          <Field label="Email">
            <Input name="email" type="email" />
          </Field>
          <Field label="Funding they want">
            <Input name="wantedAmount" placeholder="50k" />
          </Field>
          <Field label="Where they came from">
            <SourceInput
              name="source"
              defaultValue={lastSource()}
              placeholder="Referral"
              onFocus={(e) => e.currentTarget.select()}
            />
          </Field>
        </div>
        <Field label="Stage">
          <Select
            value={stage}
            onChange={(e) => {
              const next = e.target.value as StageKey;
              setStage(next);
              if (!pickedDate) setDueOn(stageDue(next, today));
            }}
          >
            {START_STAGES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Follow up">
          <TimerPicker
            value={dueOn}
            today={today}
            onChange={(d) => {
              setDueOn(d);
              setPickedDate(true);
            }}
          />
        </Field>
        {dupes && pending ? (
          <div
            role="alert"
            className="space-y-2 rounded-lg border border-warn bg-warn-soft p-3 text-sm"
          >
            <p className="font-semibold text-warn">This looks like someone you already have:</p>
            <ul className="space-y-1">
              {dupes.map((d) => (
                <li key={d.id}>
                  <Link
                    href={`/clients/${d.id}`}
                    className="font-medium text-accent underline"
                    onClick={onClose}
                  >
                    {d.business_name}
                  </Link>{" "}
                  <span className="text-muted">
                    ({stageDef(d.stage).label}) — {d.reason}
                    {d.trashed
                      ? " — removed, but marked do-not-contact. Check before adding them again."
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
            <Button size="sm" disabled={busy} onClick={() => void create(pending)}>
              Add as a new client anyway
            </Button>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
