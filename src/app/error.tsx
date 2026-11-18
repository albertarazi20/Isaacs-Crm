"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";
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
  const router = useRouter();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <MerchantShell>
      <MerchantNotice icon="alert" tone="warn" title="Something went wrong">
        Try again. If it keeps happening, tell the person who sent you here. If you were in the
        middle of sending something, check that it went through before you send it again.
      </MerchantNotice>
      <div className="mt-5 flex justify-center">
        <Button
          variant="primary"
          size="lg"
          onClick={() =>
            // reset() alone re-renders the same failed server result; the refresh fetches the page again
            startTransition(() => {
              router.refresh();
              reset();
            })
          }
        >
          Try again
        </Button>
      </div>
      {error.digest ? (
        <p className="mt-4 text-center font-mono text-[11px] text-muted">Ref {error.digest}</p>
      ) : null}
    </MerchantShell>
  );
}
