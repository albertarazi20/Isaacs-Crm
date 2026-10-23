"use client";

import { useEffect, useState } from "react";
import { getMessagingContextAction } from "@/app/messaging-actions";
import type { MessagingContext } from "@/lib/messaging/queries";

export const EMPTY_MESSAGING_CONTEXT: MessagingContext = {
  signature: "",
  applicationLink: "",
  snippets: [],
  wantedAmountCents: null,
  bestOffer: null,
};

/**
 * Signature, application link, saved snippets and this merchant's ask/offer for the Text and Email dialogs.
 * null while loading. If the server can't be reached the dialogs still work: they fall back to the
 * built-in snippets and no signature.
 */
export function useMessagingContext(clientId: string): MessagingContext | null {
  const [ctx, setCtx] = useState<MessagingContext | null>(null);
  useEffect(() => {
    let alive = true;
    getMessagingContextAction({ clientId })
      .then((r) => alive && setCtx(r.ok ? r.data : EMPTY_MESSAGING_CONTEXT))
      .catch(() => alive && setCtx(EMPTY_MESSAGING_CONTEXT));
    return () => {
      alive = false;
    };
  }, [clientId]);
  return ctx;
}
