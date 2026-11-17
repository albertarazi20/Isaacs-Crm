"use client";

import { useSyncExternalStore } from "react";
import type { ClientCard } from "@/lib/data/types";
import { formatUS } from "@/lib/mca/phone";
import { buildCallIcs, googleCalendarUrl, icsFilename, type CallEvent } from "@/lib/messaging/ics";
import { formatMoney } from "@/lib/money";
import { useToast } from "../overlay";
import { ICON, Icon } from "../settings/primitives";
import { Button, buttonClass } from "../ui";

const noSubscribe = () => () => undefined;

/** The page's own address, known only in the browser; "" while the server renders so nothing mismatches. */
function useOrigin(): string {
  return useSyncExternalStore(
    noSubscribe,
    () => window.location.origin,
    () => "",
  );
}

export function callEventFor(card: ClientCard, origin: string, topic?: string): CallEvent | null {
  if (!card.scheduled_call_at) return null;
  const wants = card.wanted_amount_cents ? formatMoney(card.wanted_amount_cents) : "";
  return {
    uid: `call-${card.id}-${card.scheduled_call_at}@isaac`,
    start: card.scheduled_call_at,
    businessName: card.business_name,
    phone: card.phone ? formatUS(card.phone) : "",
    wants,
    topic,
    lastNote: card.last_call_note ?? "",
    url: origin ? `${origin}/clients/${card.id}` : "",
  };
}

/** Download an .ics or open Google Calendar's new-event form for the booked call. */
export function AddToCalendar({ card, topic }: { card: ClientCard; topic?: string }) {
  const origin = useOrigin();
  const toast = useToast();
  const ev = callEventFor(card, origin, topic);
  if (!ev) return null;

  function download() {
    const live = callEventFor(card, window.location.origin, topic);
    if (!live) return;
    const blob = new Blob([buildCallIcs(live)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = icsFilename(card.business_name);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast({ message: "Calendar file downloaded. Open it to add the call" });
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Button size="sm" onClick={download}>
        <Icon d={ICON.calendar} className="text-muted" />
        Add to calendar
      </Button>
      <a
        className={buttonClass("secondary", "sm")}
        href={googleCalendarUrl(ev)}
        target="_blank"
        rel="noopener noreferrer"
      >
        Google Calendar
        <Icon d={ICON.external} className="size-3.5 text-muted" />
      </a>
    </span>
  );
}
