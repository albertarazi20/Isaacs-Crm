"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { connectSheetAction, syncSheetNowAction, updateSheetAction } from "@/app/sheets-actions";
import { useApp } from "@/components/app-context";
import { useFormState, useRun } from "@/components/client/parts";
import { useToast } from "@/components/overlay";
import { Badge, Button, buttonClass, cn, EmptyState, Field, Input, Select } from "@/components/ui";
import type { BucketRow } from "@/lib/buckets/queries";
import { timeAgo } from "@/lib/format";
import type { SheetSourceRow } from "@/lib/settings/queries";
import { ICON, Icon, SettingRow, SettingsCard, StatusChip } from "./primitives";
import { Toggle } from "./Toggle";

export function SheetsPanel({
  sources,
  buckets,
  canShare,
  sheetsConnected,
}: {
  sources: SheetSourceRow[];
  buckets: BucketRow[];
  canShare: boolean;
  sheetsConnected: boolean;
}) {
  const { nowMs } = useApp();
  const run = useRun();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { v, bind, set } = useFormState(() => ({
    name: "",
    url: "",
    tab: "",
    targetBucketId: buckets.find((b) => b.key === "interested")?.id ?? "",
    autoFile: false,
    shared: false,
  }));

  async function connect() {
    setBusy(true);
    const r = await connectSheetAction({
      name: v.name,
      url: v.url,
      tab: v.tab,
      targetBucketId: v.targetBucketId || null,
      autoFile: v.autoFile,
      shared: v.shared,
    });
    setBusy(false);
    if (!r.ok) return toast({ message: r.error, tone: "error" });
    toast({ message: `Connected. Tabs: ${r.data.tabs.join(", ")}`, tone: "success" });
    set("url", "");
    set("name", "");
    router.refresh();
  }

  const live = sources.filter((x) => x.active).length;
  return (
    <>
      <SettingsCard
        title="Google Sheets"
        description="Each rep's lead sheet syncs into the CRM every day, and on demand. The New lead form looks leads up by phone from these rows. Read-only: the CRM copies rows in and never writes to the sheet."
        aside={
          sheetsConnected ? (
            <StatusChip tone="good">Connected</StatusChip>
          ) : (
            <StatusChip tone="warn">Not connected</StatusChip>
          )
        }
        flush
        footer={
          <>
            <span className="mr-auto text-xs text-muted">
              The columns are guessed from the header row.
            </span>
            <Button variant="primary" disabled={busy || !v.url} onClick={connect}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </>
        }
      >
        {!sheetsConnected ? (
          <SettingRow
            label="Google Sheets is not connected for your account yet"
            hint="One click with Google. It asks for read-only access to your sheets."
            className="bg-warn-soft/40"
          >
            <a href="/api/auth/google?purpose=sheets" className={buttonClass("secondary", "sm")}>
              Connect Google Sheets
            </a>
          </SettingRow>
        ) : null}
        <div className="grid gap-3 border-t border-border p-4 sm:grid-cols-2 sm:p-5">
          <Field label="Google Sheet link" className="sm:col-span-2">
            <Input {...bind("url")} placeholder="https://docs.google.com/spreadsheets/d/…" />
          </Field>
          <Field label="Name (blank = the spreadsheet's title)">
            <Input {...bind("name")} maxLength={80} placeholder="Vendor A, November" />
          </Field>
          <Field label="Tab (blank = first)">
            <Input {...bind("tab")} />
          </Field>
          <Field label="New leads land in" className="sm:col-span-2">
            <Select {...bind("targetBucketId")}>
              <option value="">No bucket</option>
              {buckets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="divide-y divide-border border-t border-border px-4 sm:px-5">
          <Toggle
            label="File new rows by itself every day"
            hint="New rows go straight into the bucket with its welcome email."
            checked={v.autoFile}
            onChange={(x) => set("autoFile", x)}
            className="py-2"
          />
          {canShare ? (
            <Toggle
              label="Shared with the whole shop"
              hint="Off keeps the sheet to you."
              checked={v.shared}
              onChange={(x) => set("shared", x)}
              className="py-2"
            />
          ) : null}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Connected sheets"
        description="What is syncing, where its rows land and when it was last read."
        aside={
          sources.length > 0 ? (
            <span className="tabular-nums">
              {live} of {sources.length} on
            </span>
          ) : undefined
        }
        flush
      >
        {sources.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No sheets yet">
              Paste a link above. The columns are guessed from the header row.
            </EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {sources.map((s) => (
              <li
                key={s.id}
                className={cn(
                  "flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-4 py-3.5 transition-colors duration-150 hover:bg-surface-2/50 sm:px-5",
                  !s.active && "opacity-70",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "hidden size-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface-3 sm:flex",
                    s.last_error ? "text-bad" : s.active ? "text-good" : "text-muted",
                  )}
                >
                  <Icon d={ICON.sheet} className="size-4" />
                </span>
                <div className="min-w-0 flex-1 basis-56">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
                    <span className="truncate">{s.name}</span>
                    {s.sheet_title ? (
                      <span className="truncate font-normal text-muted">{s.sheet_title}</span>
                    ) : null}
                    {!s.active ? <Badge tone="neutral">off</Badge> : null}
                    {s.auto_file ? <Badge tone="accent">files itself daily</Badge> : null}
                    <Badge tone={s.owner_name ? "neutral" : "info"}>
                      {s.owner_name ? `${s.owner_name}'s` : "shared"}
                    </Badge>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    <span className="font-medium text-text-2 tabular-nums">{s.row_count}</span> rows
                    · {s.bucket_name ? `lands in ${s.bucket_name}` : "no bucket"} ·{" "}
                    {s.auto_file ? "" : "manual filing · "}read by{" "}
                    {s.reader_name ?? "nobody (connect Sheets)"} ·{" "}
                    {s.last_synced_at
                      ? `synced ${timeAgo(s.last_synced_at, new Date(nowMs))}`
                      : "never synced"}
                  </p>
                  {s.last_error ? <p className="mt-0.5 text-xs text-bad">{s.last_error}</p> : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      const r = await syncSheetNowAction({ id: s.id });
                      setBusy(false);
                      if (!r.ok) return toast({ message: r.error, tone: "error" });
                      toast({
                        message: `${r.data.rows} rows, ${r.data.added} new`,
                        tone: "success",
                      });
                      router.refresh();
                    }}
                  >
                    <Icon d={ICON.refresh} className="size-3.5" />
                    Sync now
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      const ok = await run(
                        updateSheetAction({ id: s.id, autoFile: !s.auto_file }),
                        s.auto_file ? "Auto-file off" : "Auto-file on",
                      );
                      setBusy(false);
                      if (ok) router.refresh();
                    }}
                  >
                    {s.auto_file ? "Stop auto-file" : "Auto-file"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      const ok = await run(
                        updateSheetAction({ id: s.id, active: !s.active }),
                        s.active ? "Turned off" : "Turned on",
                      );
                      setBusy(false);
                      if (ok) router.refresh();
                    }}
                  >
                    {s.active ? "Turn off" : "Turn on"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </>
  );
}
