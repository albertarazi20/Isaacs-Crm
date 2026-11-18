"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { moveToBucketAction } from "@/app/buckets-actions";
import { useCall, useToast } from "../overlay";
import { Icon } from "./icons";

export interface BucketOption {
  id: string;
  name: string;
}

/**
 * The follow-up bucket this merchant is in, and where to move them: the select shows the current bucket, choosing
 * another moves them there (their old bucket's emails stop, the new bucket's start). A merchant who was handed off is
 * not chased any more, so it is locked.
 */
export function BucketMover({
  clientId,
  current,
  buckets,
  locked,
}: {
  clientId: string;
  /** The bucket they are in now; null when none (the select then says so). */
  current: string | null;
  buckets: readonly BucketOption[];
  locked?: boolean;
}) {
  const router = useRouter();
  const call = useCall();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function move(bucketId: string) {
    if (!bucketId || bucketId === current) return;
    setBusy(true);
    const moved = await call(moveToBucketAction({ clientIds: [clientId], bucketId }));
    setBusy(false);
    if (!moved) return;
    toast({
      message: `Moved to ${buckets.find((b) => b.id === bucketId)?.name ?? "the bucket"}`,
      tone: "success",
    });
    router.refresh();
  }

  return (
    <div className="relative w-full sm:w-auto">
      <select
        aria-label="Move to bucket"
        title={
          locked
            ? "Handed off: nothing left to chase"
            : "Move this merchant to another follow-up bucket"
        }
        value={current ?? ""}
        disabled={busy || locked}
        onChange={(e) => void move(e.target.value)}
        className="h-10 w-full cursor-pointer appearance-none rounded-full border border-border bg-surface pr-8 pl-3.5 text-sm font-medium text-text shadow-card transition duration-150 hover:border-border-strong hover:bg-surface-3 focus:border-accent focus:ring-[3px] focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:w-52 sm:text-[13px]"
      >
        {current === null ? <option value="">Not in a bucket</option> : null}
        {buckets.map((b) => (
          <option key={b.id} value={b.id}>
            {current === b.id ? `Bucket: ${b.name}` : b.name}
          </option>
        ))}
      </select>
      <Icon
        name="chevronDown"
        className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted"
      />
    </div>
  );
}
