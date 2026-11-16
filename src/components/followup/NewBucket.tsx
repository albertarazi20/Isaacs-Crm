"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createBucketAction } from "@/app/buckets-actions";
import { useRun } from "@/components/client/parts";
import { Button, Input } from "@/components/ui";

export function NewBucket({ canShare }: { canShare: boolean }) {
  const run = useRun();
  const router = useRouter();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        const ok = await run(createBucketAction({ name, shared }), "Bucket made");
        setBusy(false);
        if (ok) {
          setName("");
          router.refresh();
        }
      }}
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New bucket…"
        className="text-sm"
      />
      <div className="flex items-center justify-between gap-2">
        {canShare ? (
          <label className="flex min-h-8 items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              checked={shared}
              onChange={(e) => setShared(e.target.checked)}
            />{" "}
            shared with everyone
          </label>
        ) : (
          <span />
        )}
        <Button type="submit" size="sm" disabled={busy || !name.trim()}>
          Add
        </Button>
      </div>
    </form>
  );
}
