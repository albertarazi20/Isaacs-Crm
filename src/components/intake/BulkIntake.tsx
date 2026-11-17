"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { fileSheetRowsAction } from "@/app/sheets-actions";
import { useApp } from "@/components/app-context";
import { useCall } from "@/components/overlay";
import { Glyph } from "@/components/shell/icons";
import { Badge, Button, cn, EmptyState, Select } from "@/components/ui";
import type { BucketRow } from "@/lib/buckets/queries";
import { timeAgo } from "@/lib/format";
import type { StagedRow } from "@/lib/leads/staged";
import type { BulkFileReport } from "@/lib/sheets/file";

const RESULT: Record<
  BulkFileReport["result"],
  { label: string; tone: "good" | "warn" | "neutral" | "bad" }
> = {
  filed: { label: "Filed", tone: "good" },
  duplicate: { label: "Duplicate", tone: "warn" },
  already_filed: { label: "Already filed", tone: "neutral" },
  missing: { label: "Gone", tone: "bad" },
  refused: { label: "Refused", tone: "bad" },
};

const CHECK = "size-4 shrink-0 cursor-pointer accent-accent";

/**
 * Bulk intake (S1-13): the rows the sheet sync staged and nobody filed. Check the ones to file, pick a bucket, and
 * `fileSheetRowsAction` files them one transaction each. A duplicate (yours or another rep's) is skipped and named,
 * one bad row never stops the rest, and every row's result is listed here.
 */
export function BulkIntake({
  rows,
  total,
  buckets,
  defaultBucketId,
}: {
  rows: StagedRow[];
  total: number;
  buckets: BucketRow[];
  defaultBucketId: string | null;
}) {
  const router = useRouter();
  const call = useCall();
  const { nowMs } = useApp();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bucketId, setBucketId] = useState(defaultBucketId ?? "");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<BulkFileReport[] | null>(null);
  const bucket = buckets.find((b) => b.id === bucketId) ?? null;
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));
  const now = new Date(nowMs);

  const toggle = (id: string) =>
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function file() {
    if (checked.size === 0 || busy) return;
    setBusy(true);
    const out = await call(
      fileSheetRowsAction({ rowIds: [...checked], bucketId: bucketId || null }),
    );
    setBusy(false);
    if (!out) return;
    setReport(out.rows);
    setChecked(new Set());
    router.refresh();
  }

  const filed = report?.filter((r) => r.result === "filed").length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold tracking-tight">File staged sheet rows</h3>
          <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-muted">
            The sheet sync stages every new row. Check the ones to file and pick a bucket: they all
            go in at once, a duplicate is skipped and named, and each row reports what happened.
          </p>
        </div>
        {total > 0 ? (
          <span className="shrink-0 text-xs font-medium text-muted tabular-nums">
            {total} waiting{total > rows.length ? ` · showing ${rows.length}` : ""}
          </span>
        ) : null}
      </div>

      {report ? (
        <section className="animate-rise overflow-hidden rounded-2xl border border-border bg-surface">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <p className="flex items-center gap-2 text-[13px] font-semibold tabular-nums">
              <span
                aria-hidden
                className={cn(
                  "flex size-5 items-center justify-center rounded-full",
                  filed > 0 ? "bg-good-soft text-good" : "bg-surface-2 text-muted",
                )}
              >
                <Glyph name="check" className="size-3" strokeWidth={2.6} />
              </span>
              {filed} of {report.length} filed
            </p>
            <Button size="sm" variant="ghost" onClick={() => setReport(null)}>
              Clear
            </Button>
          </div>
          <ul className="divide-y divide-border border-t border-border" aria-label="Filing results">
            {report.map((r) => (
              <li
                key={r.rowId}
                className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-2.5 text-[13px]"
              >
                <Badge tone={RESULT[r.result].tone}>{RESULT[r.result].label}</Badge>
                <span className="min-w-0 font-medium wrap-anywhere">
                  {r.businessName || "No name"}
                </span>
                <span className="min-w-0 text-xs text-muted wrap-anywhere">{r.message}</span>
                {r.clientId && r.result !== "refused" ? (
                  <Link
                    href={`/clients/${r.clientId}`}
                    className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
                  >
                    Open
                    <Glyph name="arrowUpRight" className="size-3" strokeWidth={2.2} />
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title="No staged rows are waiting"
          action={
            <Link
              href="/settings/sheets"
              className="inline-flex items-center gap-1 text-[13px] font-semibold text-accent hover:underline"
            >
              Settings, Sheets
              <Glyph name="arrowUpRight" className="size-3.5" strokeWidth={2.2} />
            </Link>
          }
        >
          Rows from your connected sheets show up here after the sync. Connect one in Settings.
        </EmptyState>
      ) : (
        <div>
          {/* the bar that follows the list: how many are checked, where they go, and the one button */}
          <div className="glass-strong sticky -top-5 z-10 -mx-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-y border-border px-5 py-2.5 sm:-mx-7 sm:px-7">
            <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-[13px] font-medium">
              <input
                type="checkbox"
                className={CHECK}
                checked={allChecked}
                onChange={() => setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.id)))}
                aria-label="Check every staged row"
              />
              <span className="tabular-nums">
                {checked.size > 0 ? `${checked.size} checked` : "Check all"}
              </span>
            </label>
            <div className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 sm:flex-none">
              <Select
                aria-label="Bucket for these rows"
                value={bucketId}
                onChange={(e) => setBucketId(e.target.value)}
                className="h-10 min-w-0 flex-1 rounded-full pr-8 pl-4 sm:h-9 sm:w-56 sm:flex-none"
              >
                <option value="">No bucket, just add them</option>
                {buckets.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.owner_id ? " (mine)" : ""}
                  </option>
                ))}
              </Select>
              <Button
                variant="primary"
                disabled={busy || checked.size === 0}
                onClick={() => void file()}
                className="max-sm:w-full"
              >
                {busy
                  ? "Filing…"
                  : checked.size === 0
                    ? "Check rows to file"
                    : `File ${checked.size} row${checked.size === 1 ? "" : "s"}${bucket ? ` to ${bucket.name}` : ""}`}
              </Button>
            </div>
          </div>

          <div
            aria-hidden
            className="eyebrow grid grid-cols-[28px_minmax(0,1.5fr)_minmax(0,1fr)_56px_minmax(0,1fr)] items-center gap-3 px-3 pt-3 pb-2 max-sm:hidden"
          >
            <span />
            <span>Merchant</span>
            <span>Phone</span>
            <span>State</span>
            <span className="text-right">From</span>
          </div>
          <ul className="max-sm:mt-2">
            {rows.map((r) => {
              const on = checked.has(r.id);
              const name = r.business_name || r.contact_name || "No name";
              return (
                <li key={r.id}>
                  <label
                    className={cn(
                      "grid cursor-pointer grid-cols-[28px_minmax(0,1fr)] items-center gap-x-3 rounded-xl px-3 py-2.5 text-[13px] transition duration-150 sm:min-h-12 sm:grid-cols-[28px_minmax(0,1.5fr)_minmax(0,1fr)_56px_minmax(0,1fr)] sm:py-1.5",
                      on ? "bg-accent-soft/60" : "hover:bg-surface-2/50",
                    )}
                  >
                    <input
                      type="checkbox"
                      className={CHECK}
                      checked={on}
                      onChange={() => toggle(r.id)}
                      aria-label={`Check ${r.business_name || r.contact_name || r.phone || "row"}`}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{name}</span>
                      {r.business_name && r.contact_name ? (
                        <span className="block truncate text-xs text-muted">{r.contact_name}</span>
                      ) : null}
                    </span>
                    <span className="col-start-2 min-w-0 truncate text-text-2 tabular-nums sm:col-start-auto">
                      {r.phone || <span className="text-muted">no phone</span>}
                      <span className="text-muted sm:hidden">{r.state ? ` · ${r.state}` : ""}</span>
                    </span>
                    <span className="text-text-2 max-sm:hidden">{r.state || ""}</span>
                    <span className="col-start-2 min-w-0 truncate text-xs text-muted sm:col-start-auto sm:text-right">
                      {r.source_name} · seen {timeAgo(r.first_seen_at, now)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
