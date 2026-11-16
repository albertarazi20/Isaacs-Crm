"use client";

import { useState } from "react";
import { logoutEverywhereAction } from "@/app/actions";
import { SettingsCard } from "./settings/primitives";
import { Button } from "./ui";

/** For a lost or shared phone: every signed-in browser is signed out, this one included. */
export function SecurityPanel() {
  const [sure, setSure] = useState(false);
  return (
    <SettingsCard
      title="Security"
      description="Lost your phone or used a shared computer? This signs you out on every device. Sign back in with Google afterwards."
    >
      {sure ? (
        <form
          action={logoutEverywhereAction}
          className="flex flex-wrap items-center gap-2"
          onSubmit={() => {
            // Forget what this browser remembered too (a pending call's business name, board filters, last source).
            try {
              Object.keys(localStorage)
                .filter((k) => k.startsWith("isaac:"))
                .forEach((k) => localStorage.removeItem(k));
            } catch {
              /* storage blocked — nothing to clear */
            }
          }}
        >
          <Button type="submit" variant="danger" size="sm">
            Yes, sign out everywhere
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSure(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <Button size="sm" onClick={() => setSure(true)}>
          Sign out of all devices
        </Button>
      )}
    </SettingsCard>
  );
}
