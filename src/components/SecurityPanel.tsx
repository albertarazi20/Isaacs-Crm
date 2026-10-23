"use client";

import { useState } from "react";
import { logoutEverywhereAction } from "@/app/actions";
import { Button, Card, SectionTitle } from "./ui";

/** For a lost or shared phone: every signed-in browser is signed out, this one included. */
export function SecurityPanel() {
  const [sure, setSure] = useState(false);
  return (
    <Card className="space-y-3 p-4">
      <SectionTitle>Security</SectionTitle>
      <p className="text-sm text-muted">
        Lost your phone or used a shared computer? This signs you out on every device. Sign back in
        with Google afterwards.
      </p>
      {sure ? (
        <form action={logoutEverywhereAction} className="flex gap-2">
          <Button type="submit" variant="danger" size="sm">
            Yes, sign out everywhere
          </Button>
          <Button size="sm" onClick={() => setSure(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <Button size="sm" onClick={() => setSure(true)}>
          Sign out of all devices
        </Button>
      )}
    </Card>
  );
}
