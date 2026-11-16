"use client";

import { logAccessAction } from "@/app/trust-actions";
import { useCopy } from "@/components/client/parts";

/**
 * The one-click copy next to a phone or email (P2-51): copies the value and writes the access-log line the
 * trust panel counts. Logging is fire-and-forget; the copy never waits on it.
 */
export function CopyContact({
  clientId,
  value,
  kind,
}: {
  clientId: string;
  value: string;
  kind: "phone" | "email";
}) {
  const copy = useCopy();
  return (
    <button
      type="button"
      aria-label={`Copy ${kind}`}
      title={`Copy ${kind}`}
      className="ml-1 inline-flex h-6 items-center rounded-md px-1.5 text-[11px] font-semibold text-accent transition hover:bg-accent-soft"
      onClick={() => {
        void copy(value, kind);
        void logAccessAction({ action: kind === "phone" ? "copy_phone" : "copy_email", clientId });
      }}
    >
      copy
    </button>
  );
}
