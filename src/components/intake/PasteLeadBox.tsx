"use client";

import { useId, useState } from "react";
import { splitLeadLineAction } from "@/app/intake-actions";
import { useCall } from "@/components/overlay";
import { Glyph } from "@/components/shell/icons";
import { Badge, Button, Input } from "@/components/ui";
import type { SplitResult } from "@/lib/ai/splitLeadLine";
import type { AssistantState } from "@/lib/leads/assistant";

/** What the last paste did, for the line under the box. */
export interface PasteSummary {
  filled: string[];
  warning: string | null;
}

/**
 * "Paste a lead line": one line of text about a merchant goes to the assistant, which splits it into the form's
 * fields (the server checks the phone and email really are in the text). The form fills in and this box names the
 * fields it filled. Without a model key, with the assistant switched off or over its budget, the box is disabled and
 * says why. Typing the lead in by hand below always works.
 */
export function PasteLeadBox({
  assistant,
  onSplit,
  summary,
}: {
  assistant: AssistantState;
  /** Gets the splitter's fields; the form puts them in its inputs and returns what it filled. */
  onSplit: (fields: SplitResult) => Promise<PasteSummary>;
  summary: PasteSummary | null;
}) {
  const call = useCall();
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const off = !assistant.ready;

  async function run() {
    if (off || busy || text.trim() === "") return;
    setBusy(true);
    const r = await call(splitLeadLineAction({ text }));
    setBusy(false);
    if (r) await onSplit(r.fields);
  }

  return (
    <div className="bg-brand-soft rounded-2xl border border-border p-3.5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={id} className="flex items-center gap-1.5 text-[12px] font-semibold">
            <Glyph name="sparkles" className="size-3.5 text-accent" />
            Paste a lead line
          </label>
          <span className="text-[11px] text-muted">Optional shortcut</span>
        </div>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Input
            id={id}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={off || busy}
            maxLength={4000}
            autoComplete="off"
            placeholder="Rosa Lind, Harbor Tacos, (310) 555-0142, rosa@harbortacos.com, CA, wants 60k for a truck"
            className="min-w-0 rounded-full bg-surface px-4 sm:flex-1"
          />
          <Button type="submit" disabled={off || busy || text.trim() === ""} className="shrink-0">
            {busy ? "Reading…" : "Fill the form"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted">
          {off
            ? `${assistant.reason}. Type the lead in below.`
            : "The phone and email are checked against what you pasted. Nothing is saved until you submit."}
        </p>
      </form>
      {summary ? (
        <div className="mt-2.5 space-y-1.5 border-t border-border pt-2.5" role="status">
          {summary.filled.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted">Filled from the line:</span>
              {summary.filled.map((label) => (
                <Badge key={label} tone="good">
                  {label}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">Nothing in that line fit the form.</p>
          )}
          {summary.warning ? <p className="text-xs text-warn">{summary.warning}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
