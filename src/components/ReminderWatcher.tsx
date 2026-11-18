"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CHANNEL_LABEL, type ReminderChannel } from "@/lib/mca/reminder";
import { formatUS } from "@/lib/mca/phone";
import { Glyph } from "@/components/shell/icons";
import { TopLayer } from "@/components/overlay";
import { buttonClass } from "@/components/ui";

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

/** The parts of the browser showSystemNotification needs, so it can be tried without one. */
export interface NotifyEnv {
  Notification?: new (title: string, options?: NotificationOptions) => unknown;
  serviceWorker?: {
    getRegistration: () => Promise<
      | { showNotification: (title: string, options?: NotificationOptions) => Promise<void> }
      | undefined
    >;
  };
}

/**
 * Show a system notification. `new Notification()` throws on Android Chrome (it insists on a service worker), so
 * that failure must not be swallowed with the network errors: fall back to a registered service worker, and report
 * false when nothing could show it (the on-page banner is then the only signal).
 */
export async function showSystemNotification(
  title: string,
  options: NotificationOptions,
  env: NotifyEnv,
): Promise<boolean> {
  try {
    if (!env.Notification) return false;
    new env.Notification(title, options);
    return true;
  } catch {
    // fall through to the service worker route
  }
  try {
    const reg = await env.serviceWorker?.getRegistration();
    if (!reg) return false;
    await reg.showNotification(title, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pops a glass banner when a reminder's time arrives while the app is open, and a system notification if he allowed
 * them. Dismissing hides it on this device; the reminder itself stays until he logs that call, text or email.
 */
export function ReminderWatcher() {
  const [due, setDue] = useState<Due[]>([]);
  // "default" means the browser has not asked yet, so the button below can. Unknown until the first check.
  const [canAsk, setCanAsk] = useState(false);

  useEffect(() => {
    let live = true;
    const inflight = new AbortController();
    async function poll() {
      try {
        setCanAsk("Notification" in window && Notification.permission === "default");
        const res = await fetch("/api/reminders/due", {
          cache: "no-store",
          signal: inflight.signal,
        });
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
            await showSystemNotification(
              `${CHANNEL_LABEL[d.channel]} ${d.business_name} now`,
              { body: d.note || undefined },
              { Notification, serviceWorker: navigator.serviceWorker },
            );
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
      inflight.abort();
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
      className="glass-strong fixed right-3 bottom-20 z-40 inline-flex h-10 animate-pop items-center gap-2 rounded-full border border-border pr-4 pl-2 text-[13px] font-medium text-text shadow-pop transition duration-150 hover:border-border-strong active:scale-[0.97] sm:right-5 sm:bottom-5"
    >
      <span
        aria-hidden
        className="bg-brand-soft flex size-7 items-center justify-center rounded-full text-accent ring-1 ring-accent/25"
      >
        <Glyph name="bell" className="size-3.5" />
      </span>
      Turn on reminder alerts
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
      <TopLayer
        role="alert"
        aria-live="assertive"
        bump={due.map(keyOf).join("|")}
        className="fixed inset-x-3 top-16 bottom-auto z-50 mx-auto flex max-w-md flex-col gap-2 lg:top-5"
      >
        {due.map((d) => (
          <div
            key={keyOf(d)}
            className="ring-brand glass-strong flex animate-pop items-center gap-3 rounded-2xl border border-border py-2.5 pr-2 pl-3 text-text shadow-pop"
          >
            <span
              aria-hidden
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-warn-soft text-warn ring-1 ring-warn/25"
            >
              <Glyph
                name={d.channel === "call" ? "phone" : d.channel === "email" ? "mail" : "clock"}
                className="size-[18px]"
              />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold tracking-tight">
                {CHANNEL_LABEL[d.channel]} {d.business_name} now
              </p>
              <p className="truncate text-xs text-muted tabular-nums">
                {[d.phone ? formatUS(d.phone) : "", d.note].filter(Boolean).join(" · ") ||
                  "Reminder due"}
              </p>
            </div>
            <Link
              href={`/clients/${d.id}`}
              onClick={() => dismiss(d)}
              className={buttonClass("primary", "sm", "shrink-0")}
            >
              Open
            </Link>
            <button
              type="button"
              aria-label={`Dismiss reminder for ${d.business_name}`}
              onClick={() => dismiss(d)}
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted transition duration-150 hover:bg-surface-2 hover:text-text active:scale-95 sm:size-8"
            >
              <Glyph name="x" className="size-4" />
            </button>
          </div>
        ))}
      </TopLayer>
    </>
  );
}
