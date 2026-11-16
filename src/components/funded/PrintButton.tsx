"use client";

import { Button } from "@/components/ui";

/** Opens the browser's print dialog; the page hides its own chrome with the print: variants. */
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <Button variant="secondary" className="print:hidden" onClick={() => window.print()}>
      {label}
    </Button>
  );
}
