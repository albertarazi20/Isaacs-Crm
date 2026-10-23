"use client";

import { logoutAction } from "@/app/actions";
import { Button } from "./ui";

/** Logging out also forgets what this browser remembered (a pending call's business name, board filters). */
export function LogoutButton({ email }: { email: string }) {
  return (
    <form
      action={logoutAction}
      onSubmit={() => {
        try {
          Object.keys(localStorage)
            .filter((k) => k.startsWith("isaac:"))
            .forEach((k) => localStorage.removeItem(k));
        } catch {
          /* storage blocked — nothing to clear */
        }
      }}
    >
      <Button variant="ghost" size="sm" type="submit" title={email}>
        Log out
      </Button>
    </form>
  );
}
