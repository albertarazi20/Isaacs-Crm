"use client";

import { useEffect, useMemo, useState } from "react";
import { createApprovalAction, editApprovalAction } from "@/app/approval-actions";
import { loadDirectoryAction } from "@/app/power-actions";
import type { ApprovalRow } from "@/lib/approvals/queries";
import { advanceWords, offerMoney, stepName, type CadenceStep } from "@/lib/approvals/words";
import type { DirectoryRow } from "@/lib/data/overdue";
import { parseMoney } from "@/lib/money";
import { useApp } from "../app-context";
import { Dialog, useCall, useToast } from "../overlay";
import { searchDirectory } from "../power/search";
import { Avatar, Button, Field, Input, Textarea } from "../ui";
import { followUpHint, localInputValue } from "./RecordFirstEmail";

/**
 * Mark a merchant approved (from their page, or from Open approvals with a merchant picker), or change an open
 * approval's numbers. The first email goes as soon as it is saved, unless the rep holds the emails.
 */
export function ApprovalForm({
  open,
  onClose,
  merchant,
  editing,
  cadence,
  fmt,
}: {
  open: boolean;
  onClose: () => void;
  /** Marking from the merchant's page: no picker. */
  merchant?: { id: string; name: string };
  /** Changing an open approval. */
  editing?: ApprovalRow;
  cadence: readonly CadenceStep[];
  fmt: (iso: string) => string;
}) {
  const { today } = useApp();
  const call = useCall();
  const toast = useToast();
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(merchant ?? null);
  const [query, setQuery] = useState("");
  const [directory, setDirectory] = useState<DirectoryRow[] | null>(null);
  const [amount, setAmount] = useState(editing ? String(editing.amount_cents / 100) : "");
  // empty until the rep types the funder's real date: a guessed one would go in the emails and stop them on that day
  const [holdUntil, setHoldUntil] = useState(editing?.hold_until ?? "");
  const [funder, setFunder] = useState(editing?.funder ?? "");
  const [note, setNote] = useState(editing?.note ?? "");
  // the first email is always the rep's own, from their own mail: sent already, or still to send
  const [firstEmail, setFirstEmail] = useState<"mine" | "later">("mine");
  const [now] = useState(() => new Date());
  const [sentAt, setSentAt] = useState(() => localInputValue(now));
  const [busy, setBusy] = useState(false);

  // the merchant list for the picker, read once when the dialog opens without a merchant
  useEffect(() => {
    if (!open || merchant || editing || directory) return;
    let live = true;
    void loadDirectoryAction().then((r) => {
      if (live && r.ok) setDirectory(r.data);
    });
    return () => {
      live = false;
    };
  }, [open, merchant, editing, directory]);

  const matches = useMemo(
    () => (directory && query.trim() ? searchDirectory(directory, query, 6).matches : []),
    [directory, query],
  );
  const target = editing ? { id: editing.client_id, name: editing.business_name } : picked;

  async function save() {
    if (!target) return;
    setBusy(true);
    if (editing) {
      const res = await call(
        editApprovalAction({
          approvalId: editing.id,
          amount,
          holdUntil: holdUntil || null,
          funder,
          note,
        }),
        "Approval updated",
      );
      setBusy(false);
      if (res) onClose();
      return;
    }
    const res = await call(
      createApprovalAction({
        clientId: target.id,
        amount,
        holdUntil: holdUntil || null,
        funder,
        note,
        firstEmail,
        sentAt: firstEmail === "mine" && sentAt ? new Date(sentAt).toISOString() : null,
      }),
    );
    setBusy(false);
    if (!res) return;
    toast({
      message: res.emailsStopped
        ? `${target.name} is on Open approvals. Their emails are stopped for good, so none go out.`
        : `${target.name} is on Open approvals. ${
            firstEmail === "mine"
              ? `First email recorded as sent. ${advanceWords(res.first, fmt)}`
              : 'Send the approval email from your own mail, then tap "I sent the first email": the follow-ups start after it.'
          }`,
      tone: "success",
    });
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Change the approval: ${editing.business_name}` : "Got an approval"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={busy || !target || amount.trim() === ""}
          >
            {busy ? "Saving…" : editing ? "Save" : "Mark approved"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {editing || merchant ? (
          <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface-3/50 px-3.5 py-3">
            <Avatar name={target?.name ?? ""} size={34} />
            <div className="min-w-0">
              <p className="eyebrow">Merchant</p>
              <p className="truncate text-sm font-semibold">{target?.name}</p>
            </div>
          </div>
        ) : picked ? (
          <div className="flex items-center gap-3 rounded-2xl border border-accent/30 bg-accent-soft/40 px-3.5 py-3">
            <Avatar name={picked.name} size={34} />
            <div className="min-w-0 flex-1">
              <p className="eyebrow">Merchant</p>
              <p className="truncate text-sm font-semibold">{picked.name}</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
              Change
            </Button>
          </div>
        ) : (
          <div>
            <Field label="Merchant">
              <Input
                autoFocus
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={directory ? "Business, owner, phone or email" : "Loading merchants…"}
                aria-controls="approval-merchant-results"
                autoComplete="off"
              />
            </Field>
            {matches.length > 0 ? (
              <ul
                id="approval-merchant-results"
                aria-label="Matching merchants"
                className="mt-2 overflow-hidden rounded-2xl border border-border bg-surface"
              >
                {matches.map((m) => (
                  <li key={m.id} className="border-b border-border last:border-0">
                    <button
                      type="button"
                      onClick={() => {
                        setPicked({ id: m.id, name: m.business_name || m.contact_name });
                        setQuery("");
                      }}
                      className="flex min-h-11 w-full items-center gap-3 px-3.5 py-2 text-left transition hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                    >
                      <Avatar name={m.business_name || m.contact_name} size={28} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {m.business_name || m.contact_name}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {[m.contact_name, m.email].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : query.trim() && directory ? (
              <p className="mt-2 text-xs text-muted">No merchant matches that.</p>
            ) : null}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Approved amount">
            <div className="relative">
              <span
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted"
              >
                $
              </span>
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="85,000"
                className="pl-6 tabular-nums"
                aria-describedby="approval-amount-hint"
              />
            </div>
          </Field>
          <Field
            label="Funder holds it until"
            hint={
              holdUntil || !cadence.some((s) => s.uses_expiry)
                ? "Leave empty if there's no date."
                : `${cadence
                    .filter((s) => s.uses_expiry)
                    .map((s) => stepName(s.step))
                    .join(
                      " and ",
                    )} say${cadence.filter((s) => s.uses_expiry).length === 1 ? "s" : ""} a week after ${cadence.filter((s) => s.uses_expiry).length === 1 ? "it goes" : "they go"} out (the Monday if that is a weekend), unless you type the funder's date.`
            }
          >
            <Input
              type="date"
              value={holdUntil}
              min={editing ? undefined : today}
              onChange={(e) => setHoldUntil(e.target.value)}
            />
          </Field>
        </div>
        <p id="approval-amount-hint" className="-mt-2 text-xs text-muted">
          {amount.trim()
            ? parseMoney(amount)
              ? `Goes in the emails as ${offerMoney(parseMoney(amount))}.`
              : "That doesn't look like an amount."
            : "Type it any way: 85000, 85k or $85,000."}
        </p>
        <Field label="Funder" hint="For you only: never goes in an email.">
          <Input value={funder} onChange={(e) => setFunder(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Note">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            className="min-h-20"
            placeholder="Terms, what they need to hear, anything for the pitch"
          />
        </Field>

        {editing ? null : (
          <fieldset className="rounded-2xl border border-border bg-surface-3/40 px-4 py-3">
            <legend className="px-1 text-[12px] font-medium text-text-2">First email</legend>
            <div className="space-y-2.5">
              {(
                [
                  {
                    value: "mine",
                    label: "I sent it already",
                    hint: `You sent the approval email from your own mail. ${followUpHint(cadence)}`,
                  },
                  {
                    value: "later",
                    label: "I'll send it myself",
                    hint: 'You send the approval email from your own mail, then tap "I sent the first email" on the approval. The follow-ups start after it.',
                  },
                ] as const
              ).map((o) => (
                <label key={o.value} className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="radio"
                    name="approval-first-email"
                    value={o.value}
                    checked={firstEmail === o.value}
                    onChange={() => setFirstEmail(o.value)}
                    className="mt-1 size-4 accent-accent"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{o.label}</span>
                    <span className="block text-xs text-muted">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            {firstEmail === "mine" ? (
              <div className="mt-3">
                <Field label="When did you send it?">
                  <Input
                    type="datetime-local"
                    value={sentAt}
                    max={localInputValue(now)}
                    onChange={(e) => setSentAt(e.target.value)}
                  />
                </Field>
              </div>
            ) : null}
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}
