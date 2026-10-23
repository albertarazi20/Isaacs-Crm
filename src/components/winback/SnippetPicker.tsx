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

export interface PickedSnippet {
  title: string;
  /** Email only: from a "Subject:" first line. */
  subject: string | null;
  body: string;
  /** Fields that had nothing to fill them and were left visible. */
  missing: MergeField[];
  unknown: string[];
}

/** "Snippets ▾": pick a saved (or built-in) message and it fills the box with this merchant's details. */
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
    <details ref={ref} className="relative">
      <summary
        aria-disabled={!ctx}
        className="inline-flex h-8 cursor-pointer list-none items-center rounded-lg bg-surface-2 px-2.5 text-sm font-medium text-text hover:bg-border"
      >
        Snippets ▾
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-64 max-w-[calc(100vw-4rem)] rounded-xl border border-border bg-surface p-1 shadow-xl">
        {!ctx ? (
          <p className="px-3 py-2 text-sm text-muted">Loading…</p>
        ) : (
          <>
            {list.map((s) => (
              <button
                key={s.id}
                type="button"
                className="block w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-surface-2"
                onClick={() => pick(s)}
              >
                {s.title}
              </button>
            ))}
            <div className="mt-1 border-t border-border px-3 py-1.5 text-xs text-muted">
              {list.some((s) => s.isDefault) ? "Built-in snippets. " : ""}
              <Link className="text-accent underline" href="/settings">
                Edit your snippets
              </Link>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
