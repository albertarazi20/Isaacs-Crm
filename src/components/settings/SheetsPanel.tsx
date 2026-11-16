"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { connectSheetAction, syncSheetNowAction, updateSheetAction } from "@/app/sheets-actions";
import { useApp } from "@/components/app-context";
import { useFormState, useRun } from "@/components/client/parts";
import { useToast } from "@/components/overlay";
import { Badge, Button, Card, EmptyState, Field, Input, Select } from "@/components/ui";
import type { BucketRow } from "@/lib/buckets/queries";
import { timeAgo } from "@/lib/format";
import type { SheetSourceRow } from "@/lib/settings/queries";
import { Note, SettingsCard } from "./primitives";
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
    toast({ message: `Connected — tabs: ${r.data.tabs.join(", ")}`, tone: "success" });
    set("url", "");
    set("name", "");
    router.refresh();
  }

  return (
    <div className="space-y-5">
      {!sheetsConnected ? (
        <Note tone="warn">
          Google Sheets is not connected for your account yet.{" "}
          <a href="/api/auth/google?purpose=sheets" className="font-semibold underline">
            Connect Google Sheets
          </a>{" "}
          — read-only; the CRM copies rows in and never writes to the sheet.
        </Note>
      ) : null}
      <SettingsCard
        title="Connect a sheet"
        footer={
          <Button variant="primary" disabled={busy || !v.url} onClick={connect}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Google Sheet link">
            <Input {...bind("url")} placeholder="https://docs.google.com/spreadsheets/d/…" />
          </Field>
          <Field label="Tab (blank = first)">
            <Input {...bind("tab")} />
          </Field>
          <Field label="Name (blank = the spreadsheet's title)">
            <Input {...bind("name")} maxLength={80} placeholder="Vendor A — November" />
          </Field>
          <Field label="New leads land in">
            <Select {...bind("targetBucketId")}>
              <option value="">No bucket</option>
              {buckets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="space-y-2 sm:col-span-2">
            <Toggle
              label="File new rows by itself every day"
              checked={v.autoFile}
              onChange={(x) => set("autoFile", x)}
            />
            {canShare ? (
              <Toggle
                label="Shared with the whole shop"
                checked={v.shared}
                onChange={(x) => set("shared", x)}
              />
            ) : null}
          </div>
        </div>
      </SettingsCard>
      {sources.length === 0 ? (
        <EmptyState title="No sheets yet">
          Paste a link above. The columns are guessed from the header row.
        </EmptyState>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-border">
            {sources.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
                    <span className="truncate">{s.name}</span>
                    {s.sheet_title ? (
                      <span className="truncate font-normal text-muted">· {s.sheet_title}</span>
                    ) : null}
                    {!s.active ? <Badge tone="neutral">off</Badge> : null}
                  </p>
                  <p className="text-xs text-muted">
                    {s.row_count} rows · {s.bucket_name ? `→ ${s.bucket_name}` : "no bucket"} ·{" "}
                    {s.auto_file ? "files itself daily" : "manual filing"} ·{" "}
                    {s.owner_name ? `${s.owner_name}'s` : "shared"} · read by{" "}
                    {s.reader_name ?? "nobody (connect Sheets)"} ·{" "}
                    {s.last_synced_at
                      ? `synced ${timeAgo(s.last_synced_at, new Date(nowMs))}`
                      : "never synced"}
                  </p>
                  {s.last_error ? <p className="text-xs text-bad">{s.last_error}</p> : null}
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
        </Card>
      )}
    </div>
  );
}
