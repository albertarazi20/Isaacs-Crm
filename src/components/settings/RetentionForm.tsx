"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { saveDocumentRetentionAction } from "@/app/settings-actions";
import { useFormState, useRun } from "@/components/client/parts";
import { Button, Field, Input } from "@/components/ui";
import { SettingsCard } from "./primitives";

/** How long the paperwork of a dead deal is kept (S3-8). One number, one button. */
export function RetentionForm({ days }: { days: number }) {
  const run = useRun();
  const router = useRouter();
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const { v, bind } = useFormState(() => ({ days: String(days) }));
  return (
    <SettingsCard
      title="Document retention"
      description="Bank statements, IDs and tax returns of a merchant whose deals all ended dead, declined or lost are deleted this many days after the last deal closed. Contracts and offer sheets stay."
      footer={
        <Button type="submit" form={formId} variant="primary" disabled={busy}>
          {busy ? "Saving…" : "Save retention"}
        </Button>
      }
    >
      <form
        id={formId}
        className="max-w-xs"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const ok = await run(saveDocumentRetentionAction({ days: v.days }), "Retention saved");
          setBusy(false);
          if (ok) router.refresh();
        }}
      >
        <Field
          label="Keep documents of dead deals for (days)"
          hint="30 to 3650. The default is 730."
        >
          <Input {...bind("days")} inputMode="numeric" />
        </Field>
      </form>
    </SettingsCard>
  );
}
