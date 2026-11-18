"use client";

import { useEffect } from "react";
import "./globals.css";

/**
 * The last resort: the root layout itself failed, so there is no shell, theme or fonts to lean on. It has to supply
 * its own <html> and <body>. A full reload is the only retry that can work here.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <body>
        <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
          <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
          <p className="mt-2 text-sm">
            The app couldn&apos;t start. Reload the page. If it keeps happening, tell whoever runs
            this system.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 h-11 rounded-full border px-6 text-sm font-semibold"
          >
            Reload
          </button>
          {error.digest ? <p className="mt-4 font-mono text-[11px]">Ref {error.digest}</p> : null}
        </main>
      </body>
    </html>
  );
}
