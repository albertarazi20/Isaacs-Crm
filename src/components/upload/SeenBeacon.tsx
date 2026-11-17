"use client";

import { useEffect } from "react";

/**
 * Tells the CRM a person has this page in front of them: sent once, after the page has been visible for three seconds,
 * so a mail scanner that fetches the link (and runs no script, or never shows the page) does not count as the merchant.
 */
export function SeenBeacon({ kind, token }: { kind: "upload" | "apply"; token: string }) {
  useEffect(() => {
    let sent = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      if (sent || document.visibilityState !== "visible") return;
      sent = true;
      void fetch("/api/seen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, token }),
        keepalive: true,
      }).catch(() => undefined);
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      if (document.visibilityState === "visible") timer = setTimeout(send, 3000);
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", arm);
    };
  }, [kind, token]);
  return null;
}
