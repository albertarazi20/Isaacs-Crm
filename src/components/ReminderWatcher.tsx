"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CHANNEL_LABEL, type ReminderChannel } from "@/lib/mca/reminder";
import { formatUS } from "@/lib/mca/phone";

interface Due {
  id: string;
  business_name: string;
  phone: string;
  at: string;
  channel: ReminderChannel;
  note: string;
}

const POLL_MS = 30_000;
const SEEN_KEY = "isaac:reminders:seen";

const keyOf = (d: Due) => `${d.id}@${d.at}`;

function readSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function writeSeen(seen: Set<string>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)));
  } catch {
    // Private window or blocked storage: the banner just comes back after a reload.
  }
}

/**
 * Pops a bright banner when a reminder's time arrives while the app is open, and a system notification if he allowed
 * them. Dismissing hides it on this device; the reminder itself stays until he logs that call, text or email.
 */
export function ReminderWatcher() {
  const [due, setDue] = useState<Due[]>([]);
  // "default" means the browser has not asked yet, so the button below can. Unknown until the first check.
  const [canAsk, setCanAsk] = useState(false);

  useEffect(() => {
    let live = true;
    async function poll() {
      try {
        setCanAsk("Notification" in window && Notification.permission === "default");
        const res = await fetch("/api/reminders/due", { cache: "no-store" });
        if (!res.ok || !live) return;
        const body = (await res.json()) as { due: Due[] };
        const seen = readSeen();
        const fresh = body.due.filter((d) => !seen.has(keyOf(d)));
        setDue(fresh);
        if ("Notification" in window && Notification.permission === "granted") {
          const told = new Set(JSON.parse(sessionStorage.getItem("isaac:reminders:told") ?? "[]"));
          for (const d of fresh) {
            if (told.has(keyOf(d))) continue;
            told.add(keyOf(d));
            new Notification(`${CHANNEL_LABEL[d.channel]} ${d.business_name} now`, {
              body: d.note || undefined,
            });
          }
          sessionStorage.setItem("isaac:reminders:told", JSON.stringify([...told]));
        }
      } catch {
        // Offline or signed out: try again on the next tick.
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  async function askPermission() {
    await Notification.requestPermission();
    setCanAsk(Notification.permission === "default");
  }

  const askButton = canAsk ? (
    <button
      type="button"
      onClick={() => void askPermission()}
      className="fixed right-3 bottom-20 z-40 rounded-full bg-[#ffd400] px-3 py-2 text-sm font-bold text-black shadow-lg sm:bottom-3"
    >
      🔔 Turn on reminder alerts
    </button>
  ) : null;

  if (due.length === 0) return askButton;

  function dismiss(d: Due) {
    const seen = readSeen();
    seen.add(keyOf(d));
    writeSeen(seen);
    setDue((cur) => cur.filter((x) => keyOf(x) !== keyOf(d)));
  }

  return (
    <>
      {askButton}
      <div
        role="alert"
        aria-live="assertive"
        className="fixed inset-x-3 top-16 z-50 mx-auto flex max-w-md flex-col gap-2"
      >
        {due.map((d) => (
          <div
            key={keyOf(d)}
            className="flex items-center gap-3 rounded-xl bg-[#ffd400] p-3 text-black shadow-xl"
          >
            <span aria-hidden className="text-xl">
              ⏰
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold">
                {CHANNEL_LABEL[d.channel]} {d.business_name} now
              </p>
              <p className="truncate text-xs">
                {[d.phone ? formatUS(d.phone) : "", d.note].filter(Boolean).join(" · ")}
              </p>
            </div>
            <Link
              href={`/clients/${d.id}`}
              onClick={() => dismiss(d)}
              className="rounded-lg bg-black px-3 py-1.5 text-sm font-semibold text-white"
            >
              Open
            </Link>
            <button
              type="button"
              aria-label={`Dismiss reminder for ${d.business_name}`}
              onClick={() => dismiss(d)}
              className="rounded-lg px-2 py-1 text-lg leading-none font-bold hover:bg-black/10"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
