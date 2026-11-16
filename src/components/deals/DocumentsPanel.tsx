"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  deleteDocumentAction,
  mintLenderLinkAction,
  relabelDocumentAction,
} from "@/app/docs-actions";
import { ConfirmButton, copyText, useRun } from "@/components/client/parts";
import { useToast } from "@/components/overlay";
import { Button, EmptyState, Input, Select, cn } from "@/components/ui";
import type { Freshness } from "@/lib/docs/freshness";
import { DOC_KINDS, DOC_LABELS, type DocKind } from "@/lib/docs/label";
import type { DocumentRow } from "@/lib/docs/upload";
import { formatDate } from "@/lib/format";
import { UploadLinkButton } from "./UploadLinkButton";

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
        value={kind}
        onChange={(e) => setKind(e.target.value as DocKind)}
        className="h-8 text-sm"
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
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="h-8 w-40 text-sm"
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

export function DocumentsPanel({
  clientId,
  dealId,
  documents,
  freshness,
  canDelete,
  today,
}: {
  clientId: string;
  dealId: string | null;
  documents: DocumentRow[];
  freshness: Freshness;
  canDelete: boolean;
  today: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const run = useRun();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  async function upload(files: FileList) {
    if (files.length === 0) return;
    setBusy(true);
    const form = new FormData();
    form.append("clientId", clientId);
    if (dealId) form.append("dealId", dealId);
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

  async function lenderLink(d: DocumentRow) {
    const name = window.prompt("Which lender is this copy for? (stamped on every page)") ?? "";
    if (name === "") return;
    const r = await mintLenderLinkAction({ documentId: d.id, lenderName: name, minutes: 120 });
    if (!r.ok) return toast({ message: r.error, tone: "error" });
    const copied = await copyText(r.data.url);
    toast({
      message: copied
        ? "Lender link copied — good for 2 hours, 5 downloads, watermarked"
        : r.data.url,
      tone: "success",
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          className={cn(
            "text-sm",
            freshness.status === "fresh"
              ? "text-good"
              : freshness.status === "none"
                ? "text-muted"
                : "text-warn",
          )}
        >
          {freshness.message}
        </p>
        <div className="flex gap-2">
          <UploadLinkButton clientId={clientId} dealId={dealId} />
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {busy ? "Filing…" : "Add files"}
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => e.target.files && void upload(e.target.files)}
          />
        </div>
      </div>
      {documents.length === 0 ? (
        <EmptyState title="No documents yet">
          Drop files here, or send the merchant their upload link — statements file themselves by
          month.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {documents.map((d) => (
            <li key={d.id} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {d.label}
                    {d.label_confidence < 0.8 && d.label_by === "rule" ? (
                      <span className="ml-2 rounded bg-warn-soft px-1.5 py-0.5 text-[11px] font-medium text-warn">
                        check the label
                      </span>
                    ) : null}
                    {d.scan_status !== "clean" ? (
                      <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">
                        {d.scan_status === "pending" ? "being checked" : d.scan_status}
                      </span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {d.filename} · {size(d.size_bytes)} ·{" "}
                    {d.source === "upload_link"
                      ? "merchant upload"
                      : d.source === "email"
                        ? "from email"
                        : (d.uploaded_by_name ?? "staff")}{" "}
                    · {formatDate(d.created_at.slice(0, 10), today)}
                    {d.views > 0 ? ` · opened ${d.views}×` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {d.scan_status === "clean" ? (
                    <a
                      href={`/api/docs/${d.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-8 items-center rounded-lg border border-border px-2.5 text-sm font-semibold hover:bg-surface-2"
                    >
                      Open
                    </a>
                  ) : null}
                  {d.scan_status === "clean" ? (
                    <Button size="sm" onClick={() => void lenderLink(d)}>
                      Lender link
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(editing === d.id ? null : d.id)}
                  >
                    Relabel
                  </Button>
                  {canDelete ? (
                    <ConfirmButton
                      label="Delete"
                      confirmLabel="Really delete"
                      busy={busy}
                      onConfirm={async () => {
                        setBusy(true);
                        const ok = await run(deleteDocumentAction({ documentId: d.id }), "Deleted");
                        setBusy(false);
                        if (ok) router.refresh();
                      }}
                    />
                  ) : null}
                </div>
              </div>
              {editing === d.id ? (
                <div className="mt-2">
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
  );
}
