"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createBucketAction } from "@/app/buckets-actions";
import { useRun } from "@/components/client/parts";
import { Dialog } from "@/components/overlay";
import { Glyph } from "@/components/shell/icons";
import { Button, Field, Input } from "@/components/ui";

/** The form itself: a name, and for a manager whether the whole shop gets the bucket. */
export function NewBucket({ canShare, onDone }: { canShare: boolean; onDone?: () => void }) {
  const run = useRun();
  const router = useRouter();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        const ok = await run(createBucketAction({ name, shared }), "Bucket made");
        setBusy(false);
        if (ok) {
          setName("");
          router.refresh();
          onDone?.();
        }
      }}
    >
      <Field
        label="Name"
        hint="A bucket is a follow-up list. Add its emails under Sequences once it exists."
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New bucket…"
          maxLength={60}
          autoFocus
        />
      </Field>
      <div className="flex items-center justify-between gap-3">
        {canShare ? (
          <label className="flex min-h-9 items-center gap-2 text-[13px] text-text-2">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              checked={shared}
              onChange={(e) => setShared(e.target.checked)}
            />
            Shared with everyone
          </label>
        ) : (
          <span className="text-xs text-muted">Only you will see it.</span>
        )}
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          {busy ? "Adding…" : "Add"}
        </Button>
      </div>
    </form>
  );
}

/** "New bucket" as a button: the form opens in a dialog over whatever bucket you are looking at. */
export function NewBucketButton({
  canShare,
  variant = "secondary",
}: {
  canShare: boolean;
  variant?: "primary" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <Glyph name="plus" className="size-4" strokeWidth={2.1} />
        New bucket
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New bucket">
        <NewBucket canShare={canShare} onDone={() => setOpen(false)} />
      </Dialog>
    </>
  );
}
