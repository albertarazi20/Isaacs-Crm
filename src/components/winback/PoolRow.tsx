"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { setWinbackStatusAction } from "@/app/winback-actions";
import { useRun } from "@/components/client/parts";
import { Badge, Button, buttonClass } from "@/components/ui";
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

/** One pool member: who they are, where the sequence stands, the old offer beside them, and Call / Stop. */
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
  const tone = m.status === "replied" ? "bad" : m.status === "active" ? "good" : "neutral";
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 transition hover:bg-surface-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:py-2">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <Link
            href={m.deal_id ? `/deals/${m.deal_id}` : `/clients/${m.client_id}`}
            className="truncate text-sm font-semibold hover:underline"
          >
            {m.business_name}
          </Link>
          <span className="min-w-0 truncate text-xs text-muted">
            {m.contact_name || "—"} · {m.phone || "no phone"} · {m.email || "no email"}
          </span>
        </div>
        <p className="truncate text-xs text-muted">
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
      <div className="flex items-center justify-end gap-2 sm:w-44 sm:flex-col sm:items-end sm:gap-0.5">
        {m.best_offer_cents ? (
          <span className="text-xs whitespace-nowrap text-muted">
            was offered{" "}
            <span className="text-[13px] font-semibold text-text tabular-nums">
              {formatMoneyCompact(m.best_offer_cents)}
            </span>
          </span>
        ) : null}
        <Badge tone={tone}>{m.status}</Badge>
      </div>
      <div className="col-span-2 flex items-center justify-end gap-1.5 sm:col-span-1">
        {m.phone ? (
          <a href={`tel:${m.phone}`} className={buttonClass("secondary", "sm")}>
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
