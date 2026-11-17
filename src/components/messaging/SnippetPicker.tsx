"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { snippetsFor, type SnippetKind, type SnippetView } from "@/lib/messaging/defaults";
import {
  resolveMergeFields,
  splitSubject,
  type MergeField,
  type MergeValues,
} from "@/lib/messaging/merge";
import type { MessagingContext } from "@/lib/messaging/queries";
import { ICON, Icon } from "../settings/primitives";

export interface PickedSnippet {
  title: string;
  /** Email only: from a "Subject:" first line. */
  subject: string | null;
  body: string;
  /** Fields that had nothing to fill them and were left visible. */
  missing: MergeField[];
  unknown: string[];
}

/** "Snippets": pick a saved (or built-in) message and it fills the box with this merchant's details. */
export function SnippetPicker({
  kind,
  ctx,
  values,
  onPick,
}: {
  kind: SnippetKind;
  ctx: MessagingContext | null;
  values: MergeValues;
  onPick: (p: PickedSnippet) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  // A <details> menu stays open until told otherwise: close it when the next tap lands somewhere else.
  useEffect(() => {
    const close = (e: PointerEvent) => {
      const el = ref.current;
      if (el?.open && e.target instanceof Node && !el.contains(e.target)) el.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const list: SnippetView[] = ctx ? snippetsFor(ctx.snippets, kind) : [];

  function pick(s: SnippetView) {
    const { subject, body } =
      kind === "email" ? splitSubject(s.body) : { subject: null, body: s.body };
    const resolvedBody = resolveMergeFields(body, values);
    const resolvedSubject = subject === null ? null : resolveMergeFields(subject, values);
    onPick({
      title: s.title,
      subject: resolvedSubject?.text ?? null,
      body: resolvedBody.text,
      missing: [...new Set([...resolvedBody.missing, ...(resolvedSubject?.missing ?? [])])],
      unknown: [...new Set([...resolvedBody.unknown, ...(resolvedSubject?.unknown ?? [])])],
    });
    if (ref.current) ref.current.open = false;
  }

  return (
    <details ref={ref} className="group relative">
      <summary
        aria-disabled={!ctx}
        className="inline-flex h-10 cursor-pointer list-none items-center gap-1 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-text transition select-none hover:border-border-strong hover:bg-surface-3 sm:h-8 sm:px-2.5 sm:text-[13px] [&::-webkit-details-marker]:hidden"
      >
        Snippets
        <Icon
          d={ICON.chevronDown}
          className="size-3.5 text-muted transition group-open:rotate-180"
        />
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-64 max-w-[calc(100vw-4rem)] rounded-xl border border-border bg-surface p-1 shadow-pop">
        {!ctx ? (
          <p className="px-3 py-2 text-sm text-muted">Loading…</p>
        ) : (
          <>
            {list.map((s) => (
              <button
                key={s.id}
                type="button"
                className="block w-full rounded-lg px-3 py-2 text-left text-sm transition hover:bg-surface-2 sm:py-1.5"
                onClick={() => pick(s)}
              >
                {s.title}
              </button>
            ))}
            <div className="mt-1 border-t border-border px-3 py-2 text-xs text-muted">
              {list.some((s) => s.isDefault) ? "Built-in snippets. " : ""}
              <Link className="font-medium text-accent hover:underline" href="/settings">
                Edit your snippets
              </Link>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
