"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { acceptPolicyAction } from "@/app/trust-actions";
import { Button } from "@/components/ui";
import { useCall } from "@/components/overlay";

export function PolicyAccept() {
  const router = useRouter();
  const call = useCall();
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-5 space-y-4">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 size-4"
          checked={ticked}
          onChange={(e) => setTicked(e.target.checked)}
        />
        <span>I have read this and I accept it.</span>
      </label>
      <Button
        variant="primary"
        disabled={!ticked || busy}
        onClick={async () => {
          setBusy(true);
          const r = await call(acceptPolicyAction());
          setBusy(false);
          if (r) router.replace("/");
        }}
      >
        {busy ? "Saving…" : "Accept and continue"}
      </Button>
    </div>
  );
}
