"use client";

import { useState } from "react";
import { whenWords, type CadenceStep } from "@/lib/approvals/words";
import { useApp } from "../app-context";
import { Glyph } from "../shell/icons";
import { Button } from "../ui";
import { ApprovalForm } from "./ApprovalForm";

/** "Add an approval" on the Open approvals page: picks the merchant in the dialog. */
export function AddApprovalButton({ cadence }: { cadence: readonly CadenceStep[] }) {
  const { timezone, nowMs } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Glyph name="plus" className="size-4" />
        Add an approval
      </Button>
      {open ? (
        <ApprovalForm
          open
          onClose={() => setOpen(false)}
          cadence={cadence}
          fmt={(iso) => whenWords(iso, timezone, nowMs)}
        />
      ) : null}
    </>
  );
}
