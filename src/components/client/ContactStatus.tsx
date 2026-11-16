"use client";

import { useState } from "react";
import { setContactStatusAction } from "@/app/actions";
import type { ClientCard } from "@/lib/data/types";
import { CONTACT_STATUS_LABELS, CONTACT_STATUSES, type ContactStatus } from "@/lib/mca/contact";
import { formatDate } from "@/lib/format";
import { useApp } from "../app-context";
import { Dialog } from "../overlay";
import { Button, cn, Field, Textarea } from "../ui";
import { useRun } from "./parts";

const HELP: Record<ContactStatus, string> = {
  ok: "Normal. Buttons are live and reminders include them.",
  no_text: "Asked not to be texted. The Text button is disabled.",
  no_call: "Asked not to be called. The Call button is disabled.",
  no_email: "Asked not to be emailed. The Email button is disabled.",
  dnc: "Stop everything: every timer is cancelled, the Call/Text/Email buttons are disabled, and they never appear on Today or in the morning email. One review reminder is left 36 months out.",
};

/** "Asked us to stop" — the switch that makes stop mean stop. */
export function ContactStatusButton({ card }: { card: ClientCard }) {
  const [open, setOpen] = useState(false);
  const status = card.contact_status;
  return (
    <>
      <Button
        size="sm"
        variant={status === "ok" ? "secondary" : "danger"}
        onClick={() => setOpen(true)}
        aria-label="Contact status"
      >
        {status === "ok" ? "Contact: OK" : CONTACT_STATUS_LABELS[status]}
      </Button>
      {open ? <ContactStatusDialog card={card} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ContactStatusDialog({ card, onClose }: { card: ClientCard; onClose: () => void }) {
  const { today, timezone } = useApp();
  const run = useRun();
  const [status, setStatus] = useState<ContactStatus>(card.contact_status);
  const [note, setNote] = useState(card.contact_status_note);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const ok = await run(
      setContactStatusAction({ clientId: card.id, status, note }),
      status === "dnc" ? "Marked do-not-contact — all reminders cancelled" : "Contact status saved",
    );
    setBusy(false);
    if (ok) onClose();
  }

  const since = card.contact_status_at
    ? formatDate(
        new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
          new Date(card.contact_status_at),
        ),
        today,
      )
    : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`How can ${card.business_name} be contacted?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={status === "dnc" ? "danger" : "primary"}
            disabled={busy || (status === card.contact_status && note === card.contact_status_note)}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <fieldset className="space-y-2">
        <legend className="sr-only">Contact status</legend>
        {CONTACT_STATUSES.map((s) => (
          <label
            key={s}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition",
              status === s
                ? "border-accent/40 bg-accent-soft"
                : "border-border hover:border-border-strong hover:bg-surface-3",
            )}
          >
            <input
              type="radio"
              name="contact-status"
              className="mt-0.5 size-4 accent-accent"
              checked={status === s}
              onChange={() => setStatus(s)}
            />
            <span>
              <span className="block text-sm font-semibold">{CONTACT_STATUS_LABELS[s]}</span>
              <span className="block text-xs text-muted">{HELP[s]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Field label="What they said (kept on the record)" className="mt-3">
        <Textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Called on Oct 3, asked us to remove his number."
        />
      </Field>
      {since && card.contact_status !== "ok" ? (
        <p className="mt-2 text-xs text-muted">Current status set {since}.</p>
      ) : null}
    </Dialog>
  );
}
