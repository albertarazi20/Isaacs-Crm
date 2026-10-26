"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

/**
 * A two-click remove that stays quiet until it is armed: plain text first, red only once the first
 * click has asked "are you sure". Disarms itself when focus leaves.
 */
export function QuietConfirm({
  label,
  confirmLabel,
  onConfirm,
  busy,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  busy: boolean;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      size="sm"
      variant={armed ? "danger" : "ghost"}
      disabled={busy}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}
