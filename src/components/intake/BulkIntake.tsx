"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { fileSheetRowsAction } from "@/app/sheets-actions";
import { useApp } from "@/components/app-context";
import { useCall } from "@/components/overlay";
import { Badge, Button, Card, Field, Select, SectionTitle } from "@/components/ui";
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

/**
 * Bulk intake (S1-13): the rows the sheet sync staged and nobody filed. Check the ones to file, pick a bucket, and
 * `fileSheetRowsAction` files them one transaction each — a duplicate (yours or another rep's) is skipped and named,
 * one bad row never stops the rest — and every row's result is listed here.
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

  return (
    <Card className="p-0">
      <div className="space-y-1 p-4 sm:p-5">
        <SectionTitle
          aside={
            total > 0 ? (
              <span className="text-xs text-muted tabular-nums">
                {total} waiting{total > rows.length ? ` · showing ${rows.length}` : ""}
              </span>
            ) : null
          }
        >
          File staged sheet rows
        </SectionTitle>
        <p className="text-xs text-muted">
          The sheet sync stages every new row. Check the ones to file and pick a bucket: they all go
          in at once, a duplicate is skipped and named, and each row reports what happened.
        </p>
      </div>
      {report ? (
        <div className="space-y-2 border-t border-border p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] font-semibold">
              {report.filter((r) => r.result === "filed").length} of {report.length} filed
            </p>
            <Button size="sm" variant="ghost" onClick={() => setReport(null)}>
              Clear
            </Button>
          </div>
          <ul
            className="divide-y divide-border rounded-lg border border-border"
            aria-label="Filing results"
          >
            {report.map((r) => (
              <li
                key={r.rowId}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm"
              >
                <Badge tone={RESULT[r.result].tone}>{RESULT[r.result].label}</Badge>
                <span className="min-w-0 font-medium wrap-anywhere">{r.businessName || "—"}</span>
                <span className="min-w-0 text-xs text-muted wrap-anywhere">{r.message}</span>
                {r.clientId && r.result !== "refused" ? (
                  <Link
                    href={`/clients/${r.clientId}`}
                    className="ml-auto text-xs font-medium text-accent hover:underline"
                  >
                    Open
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <p className="border-t border-border px-4 py-6 text-center text-sm text-muted sm:px-5">
          No staged rows are waiting. Rows from your connected sheets show up here after the sync;
          connect one in{" "}
          <Link href="/settings/sheets" className="font-medium text-accent hover:underline">
            Settings → Sheets
          </Link>
          .
        </p>
      ) : (
        <>
          <div className="flex items-center gap-3 border-t border-border bg-surface-2/60 px-4 py-2 sm:px-5">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              checked={allChecked}
              onChange={() => setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.id)))}
              aria-label="Check every staged row"
            />
            <span className="text-[11px] font-semibold tracking-wide text-muted uppercase tabular-nums">
              {checked.size > 0 ? `${checked.size} checked` : "Check all"}
            </span>
          </div>
          <ul className="max-h-96 divide-y divide-border overflow-y-auto border-t border-border">
            {rows.map((r) => (
              <li
                key={r.id}
                className={checked.has(r.id) ? "bg-accent-soft/40" : "hover:bg-surface-3"}
              >
                <label className="flex cursor-pointer items-start gap-3 px-4 py-2 sm:px-5">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 shrink-0 accent-accent"
                    checked={checked.has(r.id)}
                    onChange={() => toggle(r.id)}
                    aria-label={`Check ${r.business_name || r.contact_name || r.phone || "row"}`}
                  />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block wrap-anywhere">
                      <span className="font-semibold">
                        {r.business_name || r.contact_name || "No name"}
                      </span>
                      <span className="text-muted">
                        {r.business_name && r.contact_name ? ` · ${r.contact_name}` : ""}
                        {` · ${r.phone || "no phone"}`}
                        {r.state ? ` · ${r.state}` : ""}
                      </span>
                    </span>
                    <span className="block text-xs text-muted">
                      {r.source_name} · seen {timeAgo(r.first_seen_at, new Date(nowMs))}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-3 border-t border-border p-4 sm:flex-row sm:items-end sm:justify-between sm:p-5">
            <Field label="Bucket for these rows" className="min-w-0 sm:max-w-sm sm:flex-1">
              <Select value={bucketId} onChange={(e) => setBucketId(e.target.value)}>
                <option value="">No bucket — just add them</option>
                {buckets.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.owner_id ? " (mine)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Button disabled={busy || checked.size === 0} onClick={() => void file()}>
              {busy
                ? "Filing…"
                : checked.size === 0
                  ? "Check rows to file"
                  : `File ${checked.size} row${checked.size === 1 ? "" : "s"}${bucket ? ` to ${bucket.name}` : ""}`}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
