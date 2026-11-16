"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  kickBackDealAction,
  markDealSentAction,
  type SendContext,
  sendContextAction,
} from "@/app/deals-actions";
import { FormDialog, useFormState, useRun } from "@/components/client/parts";
import { SendDialog } from "@/components/funders/SendDialog";
import { Button, Field, Select, Textarea } from "@/components/ui";
import { KICKBACK_LABELS, KICKBACK_REASONS, type DealStatus } from "@/lib/deals/types";

/**
 * What ops does to a file in the queue: send it to lenders (the real picker, which marks the deal sent in the
 * same transaction), note that it already went out another way, or send it back with the reason the rep needs.
 */
export function OpsActions({
  dealId,
  clientId,
  status,
}: {
  dealId: string;
  clientId: string;
  status: DealStatus;
}) {
  const run = useRun();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [send, setSend] = useState<SendContext | null>(null);
  const [busy, setBusy] = useState(false);
  const { v, bind } = useFormState(() => ({ reason: "missing_statement_month", note: "" }));
  const inQueue = status === "working_ops" || status === "kicked_back";
  if (!inQueue) return null;
  return (
    <span className="flex gap-1.5">
      {status === "working_ops" ? (
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await sendContextAction({ clientId });
              setBusy(false);
              if (r.ok) setSend(r.data);
              else void run(Promise.resolve(r));
            }}
          >
            Send to lenders
          </Button>
          <Button
            size="sm"
            disabled={busy}
            title="The file went out another way — just move it along"
            onClick={async () => {
              setBusy(true);
              const ok = await run(markDealSentAction({ dealId }), "Marked sent to lenders");
              setBusy(false);
              if (ok) router.refresh();
            }}
          >
            Already sent
          </Button>
        </>
      ) : null}
      <Button size="sm" variant="danger" disabled={busy} onClick={() => setOpen(true)}>
        {status === "kicked_back" ? "Kick back again" : "Kick back"}
      </Button>
      {open ? (
        <FormDialog
          title="Send the file back"
          onClose={() => setOpen(false)}
          busy={busy}
          submitLabel="Kick back"
          danger
          onSubmit={async () => {
            setBusy(true);
            const ok = await run(
              kickBackDealAction({ dealId, reason: v.reason, note: v.note }),
              "Sent back to the rep",
            );
            setBusy(false);
            if (ok) {
              setOpen(false);
              router.refresh();
            }
          }}
        >
          <Field label="What is wrong">
            <Select {...bind("reason")}>
              {KICKBACK_REASONS.map((r) => (
                <option key={r} value={r}>
                  {KICKBACK_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Note to the rep">
            <Textarea
              {...bind("note")}
              rows={3}
              placeholder="Exactly what is missing, so they fix it in one go"
            />
          </Field>
        </FormDialog>
      ) : null}
      {send ? (
        <SendDialog
          card={send.card}
          funders={send.funders}
          submissions={send.submissions}
          onClose={() => {
            setSend(null);
            router.refresh();
          }}
        />
      ) : null}
    </span>
  );
}
