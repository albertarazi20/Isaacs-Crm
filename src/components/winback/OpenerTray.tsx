"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { approveOpenersAction, reviewWinbackOpenerAction } from "@/app/money-actions";
import { useRun } from "@/components/client/parts";
import { Badge, Button, Card, SectionTitle, Textarea } from "@/components/ui";

export interface TrayRow {
  id: string;
  client_id: string;
  business_name: string;
  contact_name: string;
  pool_name: string;
  opener: string;
  /** "Nov 18" — after this the first email goes without the line. */
  holds_until: string;
}

/**
 * Review mode: the first line Claude drafted for each merchant's first email, waiting for a manager. Edit the
 * line, Send it (the email carries it on its next run) or Skip it (the email goes without a line); Send all
 * releases every line as it stands in its box.
 */
export function OpenerTray({ rows }: { rows: TrayRow[] }) {
  const run = useRun();
  const router = useRouter();
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((r) => [r.id, r.opener])),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const text = (r: TrayRow) => texts[r.id] ?? r.opener;
  const empty = rows.some((r) => text(r).trim() === "");

  const one = async (r: TrayRow, approve: boolean) => {
    setBusy(r.id);
    const ok = await run(
      reviewWinbackOpenerAction({ memberId: r.id, text: approve ? text(r) : "", approve }),
      approve ? "Line approved" : "Skipped — the email goes without a line",
    );
    setBusy(null);
    if (ok) router.refresh();
  };
  const all = async () => {
    const n = rows.length;
    setBusy("all");
    const ok = await run(
      approveOpenersAction({ items: rows.map((r) => ({ memberId: r.id, text: text(r) })) }),
      `${n} ${n === 1 ? "line" : "lines"} approved`,
    );
    setBusy(null);
    if (ok) router.refresh();
  };

  return (
    <Card className="min-w-0 p-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-3.5 pb-3">
        <div className="min-w-0 max-w-2xl">
          <SectionTitle
            aside={
              <Badge tone={rows.length ? "accent" : "neutral"} className="tabular-nums">
                {rows.length}
              </Badge>
            }
          >
            Opening lines to review
          </SectionTitle>
          <p className="mt-1 text-xs text-muted">
            Claude drafted one line per merchant for the first email. Edit it, then send; skipping
            sends the email without a line. A line nobody touches is dropped after two days.
          </p>
        </div>
        {rows.length > 0 ? (
          <Button variant="primary" disabled={busy !== null || empty} onClick={all}>
            {busy === "all" ? "Sending…" : `Send all (${rows.length})`}
          </Button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="border-t border-border px-4 py-4 text-sm text-muted">
          No lines are waiting. New ones appear here the night before a merchant&apos;s first email.
        </p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => {
            const value = text(r);
            return (
              <li key={r.id} className="space-y-2 px-4 py-3">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <Link
                    href={`/clients/${r.client_id}`}
                    className="truncate text-sm font-semibold hover:underline"
                  >
                    {r.business_name}
                  </Link>
                  <span className="min-w-0 truncate text-xs text-muted">
                    {r.contact_name || "—"} · {r.pool_name} · held until {r.holds_until}
                  </span>
                </div>
                <label className="block space-y-1">
                  <span className="text-[12px] font-medium text-text-2">
                    Opening line for {r.business_name}
                  </span>
                  <Textarea
                    value={value}
                    maxLength={300}
                    rows={2}
                    className="min-h-0!"
                    onChange={(e) => setTexts((t) => ({ ...t, [r.id]: e.target.value }))}
                  />
                </label>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted tabular-nums">{value.length} / 300</span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => one(r, false)}
                    >
                      Skip
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy !== null || value.trim() === ""}
                      onClick={() => one(r, true)}
                    >
                      Send
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
