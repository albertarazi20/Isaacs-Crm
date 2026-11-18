"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/app-context";
import { copyText } from "@/components/client/parts";
import { Dialog, useToast } from "@/components/overlay";
import { Glyph } from "@/components/shell/icons";
import { Button, IconButton, cn } from "@/components/ui";
import {
  callWindow,
  dialList,
  localTime,
  numbersText,
  tableText,
  type Dialable,
  type DialRow,
} from "@/lib/followup/dial";

const WINDOW_WORDS = { early: "before 8 am there", late: "after 9 pm there" } as const;

/**
 * The dial list: the numbers of whoever is on screen, one at a time or all at once, to paste into Google Voice (or a
 * sheet). The merchant's own clock sits beside each number. Whoever asked not to be called is left off, with the
 * reason shown.
 */
export function DialListDialog({
  title,
  members,
  onClose,
}: {
  title: string;
  members: readonly Dialable[];
  onClose: () => void;
}) {
  const { nowMs } = useApp();
  const toast = useToast();
  const { rows, skipped } = useMemo(() => dialList(members), [members]);
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const now = new Date(nowMs);
  const current = rows.find((r) => !done.has(r.clientId)) ?? null;

  async function copy(text: string, id: string, said: string) {
    const ok = await copyText(text);
    if (!ok)
      return toast({
        message: "Couldn't copy. Select the number and copy it yourself",
        tone: "error",
      });
    setCopied(id);
    toast({ message: said, tone: "success" });
  }
  async function next() {
    if (!current) return;
    const after = rows.find((r) => r.clientId !== current.clientId && !done.has(r.clientId));
    setDone((d) => new Set(d).add(current.clientId));
    // the next number is on the clipboard before the person gets back from the last call
    if (after) await copy(after.phone, after.clientId, `${after.business}: ${after.phone} copied`);
    else setCopied(null);
  }

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={title}
      footer={
        <>
          <span className="mr-auto self-center text-xs text-muted tabular-nums">
            {done.size} of {rows.length} dialed
          </span>
          <Button
            variant="ghost"
            disabled={rows.length === 0}
            onClick={() =>
              void copy(numbersText(rows), "all", `${rows.length} numbers copied, one a line`)
            }
          >
            Copy all numbers
          </Button>
          <Button
            variant="ghost"
            disabled={rows.length === 0}
            onClick={() =>
              void copy(tableText(rows), "table", "Copied for a sheet: business, contact, number")
            }
          >
            Copy for a sheet
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          Nobody here has a number you can call.
          {skipped.length > 0 ? ` ${skipped.length} left off: ${skipped[0]!.why}.` : ""}
        </p>
      ) : (
        <div className="space-y-4">
          {current ? (
            <section
              aria-label="Next to dial"
              className="rounded-2xl border border-accent/30 bg-brand-soft p-4"
            >
              <p className="eyebrow">Next to dial</p>
              <p className="mt-1 truncate text-[15px] font-semibold">{current.business}</p>
              <p className="truncate text-[13px] text-muted">
                {[current.contact, current.state].filter(Boolean).join(" · ")}
              </p>
              <p className="mt-2 text-[28px] leading-none font-semibold tracking-tight tabular-nums">
                {current.phone}
              </p>
              <Clock row={current} now={now} />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  onClick={() =>
                    void copy(current.phone, current.clientId, `${current.phone} copied`)
                  }
                >
                  <Glyph name="copy" className="size-4" />
                  {copied === current.clientId ? "Copied" : "Copy number"}
                </Button>
                <a
                  href={current.voiceHref}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-10 items-center gap-2 rounded-full border border-border bg-surface px-4 text-sm font-medium transition duration-150 hover:border-border-strong hover:bg-surface-3 sm:h-9"
                >
                  <Glyph name="phone" className="size-4" />
                  Open in Google Voice
                </a>
                <Button onClick={() => void next()}>
                  Dialed, next
                  <Glyph name="arrowRight" className="size-4" />
                </Button>
              </div>
            </section>
          ) : (
            <p className="rounded-2xl border border-good/30 bg-good-soft px-4 py-3 text-sm text-good">
              That is everyone on this list.
            </p>
          )}
          <ul className="divide-y divide-border rounded-2xl border border-border">
            {rows.map((r, i) => {
              const isDone = done.has(r.clientId);
              return (
                <li
                  key={r.clientId}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 sm:px-4",
                    isDone && "opacity-55",
                    current?.clientId === r.clientId && "bg-accent-soft/40",
                  )}
                >
                  <span className="w-6 shrink-0 text-xs text-muted tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold">{r.business}</span>
                    <span className="block truncate text-xs text-muted">
                      {[r.contact, r.state].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-[13px] font-medium tabular-nums">{r.phone}</span>
                    <Clock row={r} now={now} small />
                  </span>
                  <IconButton
                    label={`Copy ${r.business}'s number`}
                    onClick={() => void copy(r.phone, r.clientId, `${r.phone} copied`)}
                  >
                    <Glyph
                      name={isDone || copied === r.clientId ? "check" : "copy"}
                      className="size-4"
                    />
                  </IconButton>
                </li>
              );
            })}
          </ul>
          {skipped.length > 0 ? (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer font-medium text-text-2">
                {skipped.length} left off
              </summary>
              <ul className="mt-1.5 space-y-0.5">
                {skipped.map((s) => (
                  <li key={s.clientId}>
                    {s.business}: {s.why}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

function Clock({ row, now, small }: { row: DialRow; now: Date; small?: boolean }) {
  const w = callWindow(row.timezone, now);
  const time = localTime(row.timezone, now);
  return (
    <span className={cn("block text-muted", small ? "text-[11.5px]" : "mt-1 text-[13px]")}>
      {row.tz} · {time}
      {w === "early" || w === "late" ? (
        <span className="ml-1.5 font-medium text-warn">{WINDOW_WORDS[w]}</span>
      ) : null}
    </span>
  );
}
