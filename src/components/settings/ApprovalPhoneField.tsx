"use client";

import { useId, useState } from "react";
import { setMyPhoneAction } from "@/app/approval-actions";
import { useCall, useToast } from "../overlay";
import { Button, Input } from "../ui";

/** My account → the rep's own phone, the {{rep_phone}} of the approval emails sent for their merchants. */
export function ApprovalPhoneField({ initial }: { initial: string }) {
  const call = useCall();
  const toast = useToast();
  const id = useId();
  const [phone, setPhone] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const typed = phone.trim();
  // the server's rule: empty, or at least ten digits
  const invalid = typed !== "" && typed.replace(/\D/g, "").length < 10;
  const dirty = typed !== saved.trim();

  async function save() {
    if (!dirty || invalid) return;
    setBusy(true);
    const ok = await call(
      setMyPhoneAction({ phone: typed }).then((r) =>
        r.ok ? { ok: true as const, data: true } : r,
      ),
    );
    setBusy(false);
    if (!ok) return;
    setSaved(typed);
    setPhone(typed);
    toast({ message: typed ? "Phone saved" : "Phone removed", tone: "success" });
  }

  return (
    <form
      noValidate
      className="mt-5 border-t border-border pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor={`${id}-phone`} className="text-[12px] font-medium text-text-2">
        Phone
      </label>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <span className="block min-w-0 flex-1 basis-40">
          <Input
            id={`${id}-phone`}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={40}
            value={phone}
            placeholder="(561) 555-0142"
            aria-invalid={invalid || undefined}
            aria-describedby={`${id}-hint${invalid ? ` ${id}-err` : ""}`}
            onChange={(e) => setPhone(e.target.value)}
          />
        </span>
        <Button
          type="submit"
          variant={dirty ? "primary" : "secondary"}
          disabled={!dirty || invalid || busy}
        >
          {busy ? "Saving…" : "Save phone"}
        </Button>
      </div>
      {invalid ? (
        <p id={`${id}-err`} role="alert" className="mt-1.5 text-xs font-medium text-bad">
          Enter the full number, area code included.
        </p>
      ) : null}
      <p id={`${id}-hint`} className="mt-1.5 text-xs text-muted">
        Goes in your approval emails as {"{{rep_phone}}"}. An approval email that uses it waits
        until it is filled in.
      </p>
    </form>
  );
}
