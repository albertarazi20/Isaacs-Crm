"use client";

import { useEffect } from "react";
import { MerchantNotice, MerchantShell } from "@/components/upload/MerchantShell";
import { Button } from "@/components/ui";

/** The last net under every page: say it plainly and offer the one thing that usually fixes it. */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <MerchantShell>
      <MerchantNotice icon="alert" tone="warn" title="Something went wrong">
        Nothing you entered was lost on our side. Try again, and if it keeps happening, tell the
        person who sent you here.
      </MerchantNotice>
      <div className="mt-5 flex justify-center">
        <Button variant="primary" size="lg" onClick={reset}>
          Try again
        </Button>
      </div>
      {error.digest ? (
        <p className="mt-4 text-center font-mono text-[11px] text-muted">Ref {error.digest}</p>
      ) : null}
    </MerchantShell>
  );
}
