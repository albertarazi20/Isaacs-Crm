"use client";

import { useState } from "react";
import { addClientAction } from "@/app/actions";
import { formatDate } from "@/lib/format";
import { defaultTimers, STAGES, type StageKey } from "@/lib/mca/stages";
import type { ISODate } from "@/lib/mca/dates";
import { useApp } from "./app-context";
import { Dialog, useCall, useToast } from "./overlay";
import { TimerPicker } from "./TimerPicker";
import { Button, Field, Input, Select } from "./ui";

const START_STAGES = STAGES.filter((s) => s.group === "prospecting" || s.group === "underwriting");

const stageDue = (stage: StageKey, today: ISODate): ISODate =>
  defaultTimers(stage, { today })[0]?.dueOn ?? today;

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

  async function submit(form: HTMLFormElement) {
    const f = new FormData(form);
    setBusy(true);
    const card = await call(
      addClientAction({
        businessName: f.get("businessName"),
        contactName: f.get("contactName"),
        phone: f.get("phone"),
        email: f.get("email"),
        wantedAmount: f.get("wantedAmount"),
        stage,
        followUpOn: dueOn,
      }),
    );
    setBusy(false);
    if (!card) return;
    onClose();
    toast({
      message: `Added ${card.business_name} — follow up ${formatDate(dueOn, today)}`,
      tone: "success",
    });
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
          <Field label="How much they want">
            <Input name="wantedAmount" placeholder="50k" />
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
      </form>
    </Dialog>
  );
}
