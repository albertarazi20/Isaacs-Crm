"use client";

import { useId, useState } from "react";
import { splitLeadLineAction } from "@/app/intake-actions";
import { Icon } from "@/components/client/icons";
import { useCall } from "@/components/overlay";
import { Badge, Button, Card, Input } from "@/components/ui";
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
 * says why — typing the lead in by hand below always works.
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
    <Card className="space-y-2 p-4 sm:p-5">
      <form
        className="space-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label
          htmlFor={id}
          className="flex items-center gap-1.5 text-[12px] font-medium text-text-2"
        >
          <Icon name="sparkles" className="size-3.5 text-muted" />
          Paste a lead line
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={id}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={off || busy}
            maxLength={4000}
            autoComplete="off"
            placeholder="Rosa Lind, Harbor Tacos, (310) 555-0142, rosa@harbortacos.com, CA, wants 60k for a truck"
            className="min-w-0 sm:flex-1"
          />
          <Button type="submit" disabled={off || busy || text.trim() === ""} className="shrink-0">
            {busy ? "Reading…" : "Fill the form"}
          </Button>
        </div>
        <p className="text-xs text-muted">
          {off
            ? `${assistant.reason} — type the lead in below.`
            : "The phone and email are checked against what you pasted; nothing is saved until you submit."}
        </p>
      </form>
      {summary ? (
        <div className="space-y-1.5" role="status">
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
    </Card>
  );
}
