"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { submitToOpsAction } from "@/app/deals-actions";
import { FormDialog, Muted, useFormState, useRun } from "@/components/client/parts";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { DEAL_KIND_LABELS, DEAL_KINDS } from "@/lib/deals/types";

/** The note fields are single-line in the database; a typed line break becomes a separator, not a refusal. */
export const oneLine = (s: string): string =>
  s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" · ");

/** 5_000_000 cents → "50000", the way the amount boxes take it. */
const dollars = (cents: number | null): string => (cents === null ? "" : String(cents / 100));

/**
 * The rep hands the file to ops: what kind of deal, how much the merchant asked for (pre-filled from the
 * ask), what the money is for, and a note. Ops reviews it, then sends it to lenders or kicks it back.
 */
export function SubmitToOpsButton({
  clientId,
  businessName,
  wantedAmountCents,
  size = "md",
  afterSubmit = "refresh",
}: {
  clientId: string;
  businessName: string;
  /** The merchant's current ask, to pre-fill the requested amount. */
  wantedAmountCents: number | null;
  size?: "sm" | "md";
  /** Stay on this page (refresh) or open the new deal. */
  afterSubmit?: "refresh" | "open_deal";
}) {
  const run = useRun();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { v, bind } = useFormState(() => ({
    kind: "new",
    requested: dollars(wantedAmountCents),
    useOfFunds: "",
    note: "",
  }));

  async function submit() {
    setBusy(true);
    const r = await submitToOpsAction({
      clientId,
      kind: v.kind,
      requested: v.requested.trim() === "" ? undefined : v.requested,
      useOfFunds: oneLine(v.useOfFunds),
      note: oneLine(v.note),
    });
    setBusy(false);
    const ok = await run(
      Promise.resolve(r),
      "Submitted to ops — they review it within a business day",
    );
    if (!ok || !r.ok) return;
    setOpen(false);
    if (afterSubmit === "open_deal") router.push(`/deals/${r.data.id}`);
    else router.refresh();
  }

  return (
    <>
      <Button size={size} variant="primary" onClick={() => setOpen(true)}>
        Submit to ops
      </Button>
      {open ? (
        <FormDialog
          title={`Submit ${businessName} to ops`}
          onClose={() => setOpen(false)}
          onSubmit={() => void submit()}
          busy={busy}
          submitLabel="Submit to ops"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="What kind of deal">
              <Select {...bind("kind")} autoFocus>
                {DEAL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {DEAL_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Requested amount" hint="From the ask — change it if the number moved">
              <Input {...bind("requested")} inputMode="decimal" placeholder="50,000" />
            </Field>
          </div>
          <Field label="Use of funds">
            <Input {...bind("useOfFunds")} placeholder="Payroll, inventory, a second truck…" />
          </Field>
          <Field label="Note to ops" hint="What they should know before they send it out">
            <Textarea {...bind("note")} rows={3} />
          </Field>
          <Muted>
            Ops checks the file (signed application, newest statements, ID) and sends it to lenders,
            or kicks it back here with what is missing.
          </Muted>
        </FormDialog>
      ) : null}
    </>
  );
}

/**
 * A kicked-back file goes back into the queue once the rep has fixed it. Same action as Submit: the
 * database sees the open kicked-back deal and re-queues it instead of opening a second one.
 */
export function ResubmitToOpsButton({
  clientId,
  kind,
  size = "md",
}: {
  clientId: string;
  /** The deal's kind — kept as it was. */
  kind: string;
  size?: "sm" | "md";
}) {
  const run = useRun();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function submit() {
    setBusy(true);
    const ok = await run(
      submitToOpsAction({ clientId, kind, note: oneLine(note) }),
      "Resubmitted to ops — it is back in their queue",
    );
    setBusy(false);
    if (ok) {
      setOpen(false);
      router.refresh();
    }
  }

  return (
    <>
      <Button size={size} variant="primary" onClick={() => setOpen(true)}>
        Resubmit to ops
      </Button>
      {open ? (
        <FormDialog
          title="Resubmit to ops"
          onClose={() => setOpen(false)}
          onSubmit={() => void submit()}
          busy={busy}
          submitLabel="Resubmit"
        >
          <Field label="What you fixed" hint="Goes on the deal as your note, so ops sees it first">
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              autoFocus
              placeholder="Added the October statement and the signed page 2"
            />
          </Field>
        </FormDialog>
      ) : null}
    </>
  );
}
