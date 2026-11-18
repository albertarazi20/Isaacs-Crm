"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { loadStockDesignsAction } from "@/app/approval-actions";
import {
  loadButtonLabel,
  slotsAreEmpty,
  slotsInUse,
  STOCK_DESIGNS,
  stockIsLoaded,
  stockTiming,
  type StockSlotState,
} from "@/lib/approvals/stock";
import { emailName } from "../settings/approvalCadence";
import { ApprovalPreview } from "../settings/ApprovalPreview";
import { SettingsCard, StatusChip } from "../settings/primitives";
import { Dialog, useCall, useToast } from "../overlay";
import { Button } from "../ui";

/** "Email 1", "Email 1 and Follow-up 2", "Email 1, Follow-up 1 and Follow-up 3". */
const slotNames = (steps: readonly number[]) => {
  const names = steps.map(emailName);
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

/**
 * Settings → Approval emails: loads the Selective Capital designs (the approval email and three follow-ups, with their
 * subject lines and waits) into the first four slots. A confirmation shows each design, says what it replaces and when
 * each email goes; the save runs on the server through the same path as a design saved by hand.
 */
export function StockDesignsPanel({ slots }: { slots: StockSlotState[] }) {
  const call = useCall();
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const empty = slotsAreEmpty(slots);
  const loaded = stockIsLoaded(slots);
  const inUse = slotsInUse(slots);
  const label = loadButtonLabel(slots);
  const extra = slots.filter((s) => s.step > STOCK_DESIGNS.length).length;

  async function load() {
    setBusy(true);
    const res = await call(loadStockDesignsAction());
    setBusy(false);
    if (!res) return;
    setOpen(false);
    toast({
      message:
        res.replaced.length === 0 && res.delays.length === 0 && res.added.length === 0
          ? "The Selective Capital designs were already in place"
          : "The Selective Capital designs are loaded",
      tone: "success",
    });
    router.refresh();
  }

  return (
    <SettingsCard
      id="approval-stock"
      title="Selective Capital designs"
      description="The four ready-made emails: the approval email and three follow-ups, each with its subject line and when it goes. You can still change any design, subject or wait afterwards."
      aside={loaded ? <StatusChip tone="good">In place</StatusChip> : null}
      footer={
        <Button size="sm" variant={empty ? "primary" : "secondary"} onClick={() => setOpen(true)}>
          {label}
        </Button>
      }
    >
      <ol className="divide-y divide-border text-[13px]">
        {STOCK_DESIGNS.map((d) => (
          <li key={d.step} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
            <span className="w-24 shrink-0 font-semibold text-text">{d.name}</span>
            <span className="min-w-0 flex-1 basis-48 text-text-2">{d.subject}</span>
            <span className="text-xs text-muted">{stockTiming(d.step)}</span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-muted">
        Each follow-up is sent its wait after the email before it went out, and only if the merchant
        has not replied.
      </p>

      <Dialog
        open={open}
        onClose={() => (busy ? undefined : setOpen(false))}
        title={
          empty
            ? "Load the Selective Capital designs?"
            : "Replace with the Selective Capital designs?"
        }
        wide
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void load()}>
              {busy ? "Loading…" : empty ? "Load the designs" : "Replace them"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {empty ? (
            <p className="text-sm leading-relaxed text-text-2">
              These four go into Email 1 and Follow-up 1 to 3, with their subject lines and waits.
            </p>
          ) : (
            <p
              role="status"
              className="rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-warn"
            >
              This replaces what is in {slotNames(inUse)}: the design, the subject line and the wait
              before it. Nothing is kept of what is there now.
              {extra > 0 ? " Emails past Follow-up 3 are left as they are." : ""}
            </p>
          )}
          <ul className="flex flex-wrap gap-4">
            {STOCK_DESIGNS.map((d) => (
              <li key={d.step} className="w-44 text-xs">
                <ApprovalPreview html={d.html} subject={d.subject} name={d.name} unsaved />
                <p className="mt-1.5 font-semibold text-text">{d.name}</p>
                <p className="text-muted">{d.subject}</p>
              </li>
            ))}
          </ul>
          <div className="space-y-1.5 text-[13px] leading-relaxed text-text-2">
            <p className="font-semibold text-text">When they go</p>
            <ul className="list-disc space-y-0.5 pl-5">
              <li>The approval email goes right away, when an approval is marked.</li>
              {STOCK_DESIGNS.filter((d) => d.step > 1).map((d) => (
                <li key={d.step}>
                  {d.name} is sent {stockTiming(d.step)}, only if the merchant has not replied.
                </li>
              ))}
            </ul>
            <p className="text-muted">
              That is about 1, 3 and 5 days after the approval email. You can change any wait under
              The sequence.
            </p>
          </div>
          <p className="text-[13px] leading-relaxed text-muted">
            Approvals already running use the new designs for the emails they have not sent yet.
            Whether the emails are on, and the hours they go in, stay as they are.
          </p>
        </div>
      </Dialog>
    </SettingsCard>
  );
}
