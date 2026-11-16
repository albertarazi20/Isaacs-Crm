"use client";

import { useState } from "react";
import { setDealNoteAction } from "@/app/deals-actions";
import { useRun } from "@/components/client/parts";
import { Button, Textarea } from "@/components/ui";

/** One note box; saves on blur or Save. The field says whose note it is. */
export function NoteEditor({
  dealId,
  field,
  label,
  text,
  readOnly,
}: {
  dealId: string;
  field: "rep_note" | "manager_note" | "ops_note" | "blocker";
  label: string;
  text: string;
  readOnly?: boolean;
}) {
  const run = useRun();
  const [value, setValue] = useState(text);
  const [saved, setSaved] = useState(text);
  const [busy, setBusy] = useState(false);
  const dirty = value !== saved;
  async function save() {
    if (!dirty) return;
    setBusy(true);
    const ok = await run(setDealNoteAction({ dealId, field, text: value }), "Saved");
    setBusy(false);
    if (ok) setSaved(value);
  }
  if (readOnly) {
    return (
      <div>
        <p className="text-[12px] font-medium text-text-2">{label}</p>
        <p className="mt-1 text-sm whitespace-pre-wrap">
          {text || <span className="text-muted">—</span>}
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="flex h-8 items-center justify-between">
        <p className="text-[12px] font-medium text-text-2">{label}</p>
        {dirty ? (
          <Button size="sm" variant="primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        ) : null}
      </div>
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        aria-label={`${label} note`}
        rows={2}
        className="mt-1 min-h-16 text-sm"
        placeholder="—"
      />
    </div>
  );
}
