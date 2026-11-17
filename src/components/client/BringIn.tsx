"use client";

import { useState, type ReactNode } from "react";
import { handOffAction, undoHandOffAction } from "@/app/followup-actions";
import type { ClientDetail } from "@/lib/data/types";
import type { DocumentRow } from "@/lib/docs/upload";
import { formatDate, timeAgo } from "@/lib/format";
import type { MerchantApplication } from "@/lib/leads/application";
import { useApp } from "../app-context";
import { Dialog, useCall, useToast } from "../overlay";
import { Button, cn, ProgressRing } from "../ui";
import { Icon, type IconName } from "./icons";
import { dateInTz, fullDateTime, rollupOf } from "./logic";
import { useNowMs } from "./parts";

/** One milestone on the way in: a mark that fills when it is done, its name, and one line of where it stands. */
function Step({
  done,
  icon,
  visual,
  title,
  children,
}: {
  done: boolean;
  icon: IconName;
  /** Replaces the icon mark (the documents step shows a ring). */
  visual?: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex min-w-0 items-center gap-3 px-1 py-3 sm:px-4 sm:py-0 sm:first:pl-0">
      {visual ?? (
        <span
          aria-hidden
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
            done ? "bg-good-soft text-good ring-good/25" : "bg-surface-2 text-muted ring-border",
          )}
        >
          <Icon name={done ? "check" : icon} className="size-[18px]" />
        </span>
      )}
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-[13px] font-semibold">
          {title}
          <span className="sr-only">{done ? "(done)" : "(not yet)"}</span>
        </p>
        <p
          className="truncate text-xs text-muted"
          title={typeof children === "string" ? children : undefined}
        >
          {children}
        </p>
      </div>
    </li>
  );
}

/**
 * "Bringing them in": the three things a rep collects (application, documents, a reply) and the finish line. Hand off
 * marks the merchant as brought in, stops the chase and tells the managers once; Undo takes it back.
 */
export function BringInStrip({
  detail,
  application,
  documents,
  className,
}: {
  detail: ClientDetail;
  application?: MerchantApplication | null;
  documents: DocumentRow[];
  className?: string;
}) {
  const { card, bringIn, stips } = detail;
  const { today, timezone } = useApp();
  const nowMs = useNowMs();
  const call = useCall();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const signed = application?.latest ?? null;
  const appStip = stips.find((s) => s.kind === "signed_application" && s.received_at !== null);
  const appIn = signed !== null || card.application_received_on !== null || appStip !== undefined;
  const roll = rollupOf(stips);
  const requested = roll.requiredTotal;
  const received = roll.requiredReceived;
  const docsDone = requested > 0 ? roll.ready : documents.length > 0;
  const replied = bringIn.replied_at !== null;
  const doneCount = [appIn, docsDone, replied].filter(Boolean).length;
  const ready = appIn && docsDone;
  const broughtInAt = bringIn.brought_in_at;
  const missing = [
    appIn ? "" : "the application",
    docsDone
      ? ""
      : requested > 0
        ? `${requested - received} of ${requested} documents`
        : "any documents",
  ].filter(Boolean);

  async function handOff() {
    setBusy(true);
    const res = await call(
      handOffAction({ clientId: card.id }),
      `${card.business_name} handed off`,
    );
    setBusy(false);
    if (res) setConfirming(false);
  }

  // Undo puts the merchant back in the bucket the hand-off took them out of, at the same step; with no bucket to go
  // back to, a follow-up for tomorrow is set instead. The toast says which happened.
  async function undo() {
    setBusy(true);
    const res = await call(undoHandOffAction({ clientId: card.id }));
    setBusy(false);
    if (!res?.undone) return;
    toast({
      message: res.bucket
        ? `Hand-off undone. ${card.business_name} is back in ${res.bucket}, at the step it stopped on.`
        : "Hand-off undone. There was no bucket to go back to, so a follow-up is set for tomorrow.",
      tone: "success",
    });
  }

  return (
    <section
      aria-label="Bringing them in"
      className={cn(
        "rounded-2xl border bg-surface p-4 sm:p-5",
        broughtInAt ? "border-good/30" : "border-border",
        className,
      )}
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:gap-6">
        <div className="flex shrink-0 items-center gap-3 xl:w-60">
          {broughtInAt ? (
            <span
              aria-hidden
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-good-soft text-good ring-1 ring-good/25 ring-inset"
            >
              <Icon name="check" className="size-5" />
            </span>
          ) : null}
          <div className="min-w-0">
            <p className="eyebrow">{broughtInAt ? "Finished" : "Bringing them in"}</p>
            {broughtInAt ? (
              <>
                <p className="mt-0.5 text-lg leading-tight font-semibold tracking-[-0.02em] text-good">
                  Brought in
                </p>
                <p
                  className="mt-0.5 text-xs text-muted"
                  title={fullDateTime(broughtInAt, timezone)}
                >
                  {formatDate(dateInTz(broughtInAt, timezone), today)}
                  {bringIn.brought_in_by_name ? ` by ${bringIn.brought_in_by_name}` : ""} ·{" "}
                  {timeAgo(broughtInAt, new Date(nowMs))}
                </p>
              </>
            ) : (
              <>
                <p className="mt-0.5 text-lg leading-tight font-semibold tracking-[-0.02em]">
                  {ready ? "Ready to hand off" : `${doneCount} of 3 in`}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {ready ? "The file is complete." : `Still waiting on ${missing.join(" and ")}.`}
                </p>
              </>
            )}
          </div>
        </div>

        <ol className="grid min-w-0 flex-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <Step done={appIn} icon="file" title="Application">
            {signed
              ? `Signed ${formatDate(dateInTz(signed.signed_at, timezone), today)} by ${signed.signer_name}`
              : card.application_received_on
                ? `In since ${formatDate(card.application_received_on, today)}`
                : appStip
                  ? "Signed copy received"
                  : "Not in yet"}
          </Step>
          <Step
            done={docsDone}
            icon="upload"
            title="Documents"
            visual={
              requested > 0 ? (
                <ProgressRing value={received / requested} size={44} stroke={4}>
                  {received}/{requested}
                </ProgressRing>
              ) : undefined
            }
          >
            {requested > 0
              ? roll.ready
                ? "All requested are in"
                : `Missing: ${roll.missing.join(", ")}`
              : documents.length > 0
                ? `${documents.length} file${documents.length === 1 ? "" : "s"} in`
                : "Nothing received yet"}
          </Step>
          <Step done={replied} icon="reply" title="Replied">
            {bringIn.reply_waiting_since ? (
              <span className="font-medium text-warn">
                Wrote {timeAgo(bringIn.reply_waiting_since, new Date(nowMs))}, waiting on you
              </span>
            ) : bringIn.replied_at ? (
              `Last wrote back ${timeAgo(bringIn.replied_at, new Date(nowMs))}`
            ) : (
              "No reply yet"
            )}
          </Step>
        </ol>

        <div className="flex shrink-0 items-center gap-2 max-sm:w-full">
          {broughtInAt ? (
            <Button disabled={busy} onClick={() => void undo()} className="max-sm:w-full">
              <Icon name="undo" className="size-3.5 text-muted" />
              {busy ? "Undoing…" : "Undo hand-off"}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="lg"
              disabled={busy}
              onClick={() => setConfirming(true)}
              className="max-sm:w-full"
            >
              Hand off
              <Icon name="arrowRight" />
            </Button>
          )}
        </div>
      </div>

      {confirming ? (
        <Dialog
          open
          onClose={() => setConfirming(false)}
          title={`Hand off ${card.business_name}?`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Not yet
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void handOff()}>
                {busy ? "Handing off…" : "Hand off"}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p>
              <strong>{card.business_name}</strong> is marked as brought in. They leave the
              follow-up buckets, every reminder and automated email stops, and the managers are told
              once.
            </p>
            {ready ? (
              <p className="rounded-xl border border-good/30 bg-good-soft p-3 text-good">
                The application and every requested document are in.
              </p>
            ) : (
              <p className="rounded-xl border border-warn/30 bg-warn-soft p-3 text-warn">
                Still missing {missing.join(" and ")}. You can hand off anyway.
              </p>
            )}
            <p className="text-xs text-muted">You can undo a hand-off from this page.</p>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
