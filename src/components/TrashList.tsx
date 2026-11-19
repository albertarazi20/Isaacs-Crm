"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { purgeClientAction, restoreClientAction } from "@/app/actions";
import type { TrashedClient } from "@/lib/data/queries";
import { timeAgo } from "@/lib/format";
import { formatUS } from "@/lib/mca/phone";
import { useApp } from "./app-context";
import { useRun } from "./client/parts";
import { Dialog } from "./overlay";
import { Glyph } from "./shell/icons";
import { StageBadge } from "./StageBadge";
import { Avatar, Badge, Button, buttonClass, EmptyState, Input } from "./ui";

export function TrashList({ items }: { items: TrashedClient[] }) {
  const router = useRouter();
  const run = useRun();
  const { nowMs } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<TrashedClient | null>(null);
  const [term, setTerm] = useState("");

  async function act(id: string, go: () => ReturnType<typeof restoreClientAction>, ok: string) {
    setBusy(id);
    // restore and purge return null data on success, which useCall can't tell from a failure
    const done = await run(go(), ok);
    setBusy(null);
    setConfirming(null);
    if (done) router.refresh();
  }

  if (items.length === 0)
    return (
      <EmptyState
        title="The trash is empty"
        action={
          <Link href="/clients" className={buttonClass("secondary", "sm")}>
            Back to merchants
          </Link>
        }
      >
        Merchants you move to the trash show up here, ready to restore.
      </EmptyState>
    );

  const t = term.trim().toLowerCase();
  const digits = t.replace(/\D/g, "");
  const shown = t
    ? items.filter(
        (c) =>
          c.business_name.toLowerCase().includes(t) ||
          c.contact_name.toLowerCase().includes(t) ||
          (digits.length >= 3 && c.phone.replace(/\D/g, "").includes(digits)),
      )
    : items;

  return (
    <div className="space-y-3">
      {items.length > 6 ? (
        <label className="relative block sm:max-w-xs">
          <span className="sr-only">Search the trash</span>
          <Glyph
            name="search"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          />
          <Input
            type="search"
            className="rounded-full pl-9"
            placeholder="Search the trash"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
        </label>
      ) : null}

      <section className="rounded-2xl border border-border bg-surface">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 sm:px-5">
          <p className="eyebrow">Merchant</p>
          <p className="text-xs text-muted tabular-nums" aria-live="polite">
            {shown.length === items.length
              ? `${items.length} in the trash`
              : `${shown.length} of ${items.length}`}
          </p>
        </header>
        {shown.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">Nothing in the trash matches.</p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((c) => (
              <li
                key={c.id}
                // A phone puts the buttons under the name; a desktop keeps the row to one line.
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 transition-colors duration-150 last:rounded-b-2xl hover:bg-surface-2/50 sm:px-5"
              >
                <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-1">
                  <Avatar name={c.business_name} size={32} className="opacity-70 grayscale" />
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold tracking-tight text-text-2">
                      {c.business_name}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {[c.contact_name, formatUS(c.phone)].filter(Boolean).join(" · ") ||
                        "No contact on file"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted max-sm:w-full sm:w-64">
                  <StageBadge stage={c.stage} />
                  <span className="truncate tabular-nums">
                    trashed {timeAgo(c.trashed_at, new Date(nowMs))}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <Button
                    size="sm"
                    disabled={busy === c.id}
                    onClick={() =>
                      void act(
                        c.id,
                        () => restoreClientAction({ clientId: c.id }),
                        `${c.business_name} restored`,
                      )
                    }
                  >
                    <Glyph name="reply" className="size-3.5 text-muted" />
                    Restore
                  </Button>
                  {c.contact_status !== "ok" ? (
                    <Badge tone="neutral">
                      <span title="A merchant who asked not to be contacted stays on file so they can't be added again as a new lead.">
                        Kept on file · do-not-contact
                      </span>
                    </Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-bad hover:bg-bad-soft hover:text-bad"
                      disabled={busy === c.id}
                      onClick={() => setConfirming(c)}
                    >
                      Delete forever
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="Delete this merchant for good?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={confirming !== null && busy === confirming.id}
              onClick={() => {
                if (!confirming) return;
                const c = confirming;
                void act(
                  c.id,
                  () => purgeClientAction({ clientId: c.id }),
                  `${c.business_name} deleted for good`,
                );
              }}
            >
              {confirming !== null && busy === confirming.id ? "Deleting…" : "Yes, delete for good"}
            </Button>
          </>
        }
      >
        {confirming ? (
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-bad-soft text-bad"
            >
              <Glyph name="trash" className="size-5" />
            </span>
            <div className="min-w-0 text-sm">
              <p className="font-semibold break-words">{confirming.business_name}</p>
              <p className="mt-1 text-muted">
                The merchant, its notes, follow-ups and documents are removed and cannot be brought
                back. Restore is the safe choice if you are not sure.
              </p>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
