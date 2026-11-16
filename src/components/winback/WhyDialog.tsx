"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { setWinbackReasonAction } from "@/app/money-actions";
import { FormDialog, useFormState, useRun } from "@/components/client/parts";
import { Field, Input, Select } from "@/components/ui";

export interface WhyReason {
  key: string;
  label: string;
}

/** The pick-list answer to "why didn't it fund": one reason from the shop's list and an optional short note. */
export function WhyDialog({
  memberId,
  business,
  reasons,
  current,
  note,
  onClose,
}: {
  memberId: string;
  business: string;
  reasons: WhyReason[];
  current: string | null;
  note: string;
  onClose: () => void;
}) {
  const run = useRun();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { v, bind } = useFormState(() => ({ reason: current ?? "", note }));
  return (
    <FormDialog
      title={`Why it did not fund — ${business}`}
      onClose={onClose}
      busy={busy}
      submitLabel="Save reason"
      onSubmit={async () => {
        if (!v.reason) {
          setError("Pick the closest reason");
          return;
        }
        setError("");
        setBusy(true);
        const ok = await run(
          setWinbackReasonAction({ memberId, reason: v.reason, note: v.note }),
          "Reason saved",
        );
        setBusy(false);
        if (ok) {
          onClose();
          router.refresh();
        }
      }}
    >
      <Field label="Reason">
        <Select {...bind("reason")} aria-invalid={error ? true : undefined}>
          <option value="">Pick a reason</option>
          {reasons.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </Select>
        {error ? <span className="block text-xs text-bad">{error}</span> : null}
      </Field>
      <Field label="Note (optional)" hint="One line, 300 characters at most.">
        <Input {...bind("note")} maxLength={300} placeholder="What they told you" />
      </Field>
    </FormDialog>
  );
}
