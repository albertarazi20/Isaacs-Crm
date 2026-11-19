"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { deleteDocumentAction, relabelDocumentAction } from "@/app/docs-actions";
import type { Freshness } from "@/lib/docs/freshness";
import { DOC_KINDS, DOC_LABELS, type DocKind } from "@/lib/docs/label";
import type { DocumentRow } from "@/lib/docs/upload";
import { formatDate } from "@/lib/format";
import { useApp } from "../app-context";
import { useToast } from "../overlay";
import { Badge, Button, buttonClass, cn, Input, Select } from "../ui";
import { Icon } from "./icons";
import { dateInTz } from "./logic";
import { ConfirmButton, Panel, useRun } from "./parts";
import { Dot } from "./primitives";
import { ResetUploadLinkButton, UploadLinkButton } from "./UploadLinkButton";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.csv,.xlsx,.docx";

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Relabel({ d, onDone }: { d: DocumentRow; onDone: () => void }) {
  const run = useRun();
  const [kind, setKind] = useState<DocKind>(d.kind);
  const [period, setPeriod] = useState(d.period ? d.period.slice(0, 7) : "");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const ok = await run(
          relabelDocumentAction({
            documentId: d.id,
            kind,
            period: kind === "bank_statement" && period ? `${period}-01` : null,
          }),
          "Label saved",
        );
        setBusy(false);
        if (ok) onDone();
      }}
    >
      <Select
        aria-label="Document type"
        value={kind}
        onChange={(e) => setKind(e.target.value as DocKind)}
        className="basis-56"
      >
        {DOC_KINDS.map((k) => (
          <option key={k} value={k}>
            {DOC_LABELS[k]}
          </option>
        ))}
      </Select>
      {kind === "bank_statement" ? (
        <Input
          type="month"
          aria-label="Statement month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="basis-44"
        />
      ) : null}
      <Button type="submit" size="sm" variant="primary" disabled={busy}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

/**
 * The merchant's documents: what they sent (upload link, email) and what the rep added, each labelled by itself
 * (statements by month), with how fresh the statements are, the upload link, and drag-and-drop for the rep.
 */
export function DocumentsCard({
  clientId,
  documents,
  freshness,
  today,
  className,
}: {
  clientId: string;
  documents: DocumentRow[];
  freshness: Freshness;
  today: string;
  className?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  // dates are the rep's day, not the UTC day: an upload at 8:30pm Eastern would otherwise read as tomorrow
  const { timezone } = useApp();
  const run = useRun();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  async function upload(files: FileList) {
    if (files.length === 0) return;
    setBusy(true);
    const form = new FormData();
    form.append("clientId", clientId);
    for (const f of Array.from(files).slice(0, 10)) form.append("file", f, f.name);
    try {
      const r = await fetch("/api/docs", { method: "POST", body: form });
      const body = (await r.json().catch(() => ({}))) as {
        results?: { ok: boolean; filename: string; label?: string; error?: string }[];
        error?: string;
      };
      const results = body.results ?? [];
      const good = results.filter((x) => x.ok).length;
      const bad = results.filter((x) => !x.ok);
      if (good) toast({ message: `${good} file${good === 1 ? "" : "s"} filed`, tone: "success" });
      for (const b of bad)
        toast({ message: `${b.filename}: ${b.error ?? "failed"}`, tone: "error" });
      if (!results.length && body.error) toast({ message: body.error, tone: "error" });
      router.refresh();
    } catch {
      toast({ message: "Upload did not go through", tone: "error" });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  const freshTone =
    freshness.status === "fresh" ? "good" : freshness.status === "none" ? "neutral" : "warn";

  return (
    <Panel
      title="Documents"
      icon="file"
      className={className}
      aside={
        documents.length > 0 ? (
          <span className="text-xs font-medium text-muted tabular-nums">
            {documents.length} file{documents.length === 1 ? "" : "s"}
          </span>
        ) : null
      }
    >
      <div className="space-y-3">
        <p
          className={cn(
            "flex items-start gap-2 rounded-xl px-3 py-2 text-[13px]",
            freshTone === "good"
              ? "bg-good-soft text-good"
              : freshTone === "warn"
                ? "bg-warn-soft text-warn"
                : "bg-surface-2/70 text-muted",
          )}
        >
          <Dot className="mt-1.5" />
          {freshness.message}
        </p>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            if (!busy) void upload(e.dataTransfer.files);
          }}
          className={cn(
            "rounded-2xl border border-dashed px-4 py-4 text-center transition duration-150",
            over ? "border-accent bg-accent-soft" : "border-border-strong/70 bg-surface-3/40",
          )}
        >
          <p className="text-[13px] font-medium">
            {busy ? "Filing…" : over ? "Drop to file them" : "Drop files here"}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Or send the merchant their upload link. Statements file themselves by month.
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <UploadLinkButton clientId={clientId} />
            <Button size="sm" disabled={busy} onClick={() => input.current?.click()}>
              <Icon name="upload" className="size-3.5 text-muted" />
              {busy ? "Filing…" : "Add files"}
            </Button>
            <ResetUploadLinkButton clientId={clientId} />
          </div>
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            aria-label="Add files"
            className="hidden"
            onChange={(e) => e.target.files && void upload(e.target.files)}
          />
        </div>
        {documents.length === 0 ? (
          <p className="px-1 text-center text-xs text-muted">No documents yet.</p>
        ) : (
          <ul className="-mx-2 divide-y divide-border">
            {documents.map((d) => (
              <li
                key={d.id}
                className="rounded-xl px-2 py-2.5 transition duration-150 hover:bg-surface-2/50"
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset",
                      d.scan_status === "clean"
                        ? "bg-accent-soft text-accent ring-accent/20"
                        : "bg-surface-2 text-muted ring-border",
                    )}
                  >
                    <Icon name="file" className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold">
                      {d.label}
                      {d.label_confidence < 0.8 && d.label_by === "rule" ? (
                        <Badge tone="warn">check the label</Badge>
                      ) : null}
                      {d.scan_status !== "clean" ? (
                        <Badge>
                          {d.scan_status === "pending" ? "being checked" : d.scan_status}
                        </Badge>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {d.filename} · {size(d.size_bytes)} ·{" "}
                      {d.source === "upload_link"
                        ? "merchant upload"
                        : d.source === "email"
                          ? "from email"
                          : (d.uploaded_by_name ?? "staff")}{" "}
                      · {formatDate(dateInTz(d.created_at, timezone), today)}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      {d.scan_status === "clean" ? (
                        <a
                          href={`/api/docs/${d.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className={buttonClass("secondary", "sm")}
                        >
                          Open
                          <Icon name="external" className="size-3 text-muted" />
                        </a>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(editing === d.id ? null : d.id)}
                      >
                        Relabel
                      </Button>
                      <ConfirmButton
                        size="sm"
                        label="Delete"
                        confirmLabel="Really delete"
                        busy={busy}
                        onConfirm={async () => {
                          setBusy(true);
                          const ok = await run(
                            deleteDocumentAction({ documentId: d.id }),
                            "Deleted",
                          );
                          setBusy(false);
                          if (ok) router.refresh();
                        }}
                      />
                    </div>
                  </div>
                </div>
                {editing === d.id ? (
                  <div className="mt-2 pl-11">
                    <Relabel
                      d={d}
                      onDone={() => {
                        setEditing(null);
                        router.refresh();
                      }}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
