"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { setWinbackStatusAction } from "@/app/winback-actions";
import { useRun } from "@/components/client/parts";
import { Button, cn } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { formatMoneyCompact } from "@/lib/money";

export interface PoolMember {
  id: string;
  client_id: string;
  deal_id: string | null;
  business_name: string;
  contact_name: string;
  phone: string;
  email: string;
  reason: string;
  workable_on: string;
  status: string;
  steps_sent: number;
  next_due_on: string | null;
  last_reply_at: string | null;
  best_offer_cents: number | null;
}

export function PoolRow({ m, today }: { m: PoolMember; today: string }) {
  const run = useRun();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const workable = m.workable_on <= today;
  const set = async (status: "active" | "stopped") => {
    setBusy(true);
    const ok = await run(
      setWinbackStatusAction({
        memberId: m.id,
        status,
        reason: status === "stopped" ? "stopped by hand" : "",
      }),
      status === "stopped" ? "Stopped" : "Back on",
    );
    setBusy(false);
    if (ok) router.refresh();
  };
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <Link
          href={m.deal_id ? `/deals/${m.deal_id}` : `/clients/${m.client_id}`}
          className="text-sm font-semibold hover:underline"
        >
          {m.business_name}
        </Link>
        <span className="ml-2 text-xs text-muted">
          {m.contact_name || "—"} · {m.phone || "no phone"} · {m.email || "no email"}
          {m.best_offer_cents ? ` · was offered ${formatMoneyCompact(m.best_offer_cents)}` : ""}
        </span>
        <p className="text-xs text-muted">
          {m.reason ? `${m.reason} · ` : ""}
          {m.status === "replied" ? (
            <span className="font-semibold text-bad">replied — call them</span>
          ) : workable ? (
            <>
              step {m.steps_sent + 1}
              {m.next_due_on ? ` goes ${formatDate(m.next_due_on, today)}` : ""} · {m.steps_sent}{" "}
              sent
            </>
          ) : (
            <>workable from {formatDate(m.workable_on, today)}</>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "rounded-md px-2 py-0.5 text-[11px] font-semibold",
            m.status === "replied"
              ? "bg-bad-soft text-bad"
              : m.status === "active"
                ? "bg-good-soft text-good"
                : "bg-surface-2 text-muted",
          )}
        >
          {m.status}
        </span>
        {m.phone ? (
          <a
            href={`tel:${m.phone}`}
            className="inline-flex h-8 items-center rounded-lg border border-border px-2.5 text-sm font-semibold"
          >
            Call
          </a>
        ) : null}
        {m.status === "stopped" ? (
          <Button size="sm" disabled={busy} onClick={() => set("active")}>
            Resume
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => set("stopped")}>
            Stop
          </Button>
        )}
      </div>
    </li>
  );
}
