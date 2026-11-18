"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";
import { Button, Card } from "@/components/ui";

/**
 * A page inside the CRM failed. This sits below the app layout, so the sidebar, toasts and navigation stay on screen
 * and the rep can go somewhere else. "Try again" asks the server for the page again: re-rendering the error boundary
 * alone would show the same failed result.
 */
export default function AppError({
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
    <main className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
      <Card className="w-full p-6">
        <h1 className="text-lg font-semibold tracking-tight">This page didn&apos;t load</h1>
        <p className="mt-2 text-sm text-muted">
          Something went wrong on our side. Try again, or open another page from the menu. If you
          were saving something, check that it went through before you redo it.
        </p>
        <div className="mt-5 flex justify-center">
          <Button
            variant="primary"
            size="lg"
            onClick={() =>
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
          <p className="mt-4 font-mono text-[11px] text-muted">Ref {error.digest}</p>
        ) : null}
      </Card>
    </main>
  );
}
