"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { deleteDocumentAction, relabelDocumentAction } from "@/app/docs-actions";
import type { Freshness } from "@/lib/docs/freshness";
import { DOC_KINDS, DOC_LABELS, type DocKind } from "@/lib/docs/label";
import type { DocumentRow } from "@/lib/docs/upload";
import { formatDate } from "@/lib/format";
import { useToast } from "../overlay";
import { Badge, Button, buttonClass, cn, EmptyState, Input, Select } from "../ui";
import { Icon } from "./icons";
import { ConfirmButton, Panel, useRun } from "./parts";
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
  const run = useRun();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

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

  return (
    <Panel title="Documents" className={className}>
      <div className="space-y-4">
        <p
          className={cn(
            "flex items-center gap-2 text-sm",
            freshness.status === "fresh"
              ? "text-good"
              : freshness.status === "none"
                ? "text-muted"
                : "text-warn",
          )}
        >
          <Icon name="file" />
          {freshness.message}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <UploadLinkButton clientId={clientId} />
          <ResetUploadLinkButton clientId={clientId} />
          <Button size="sm" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Filing…" : "Add files"}
          </Button>
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
          <EmptyState title="No documents yet">
            Drop files here, or send the merchant their upload link — statements file themselves by
            month.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
            {documents.map((d) => (
              <li key={d.id} className="px-4 py-3 sm:py-2.5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="flex min-w-0 flex-1 basis-64 items-start gap-2.5">
                    <Icon name="file" className="mt-1 text-muted" />
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
                        {d.label}
                        {d.label_confidence < 0.8 && d.label_by === "rule" ? (
                          <Badge tone="warn" className="font-medium">
                            check the label
                          </Badge>
                        ) : null}
                        {d.scan_status !== "clean" ? (
                          <Badge className="font-medium">
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
                        · {formatDate(d.created_at.slice(0, 10), today)}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {d.scan_status === "clean" ? (
                      <a
                        href={`/api/docs/${d.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className={buttonClass("secondary", "sm")}
                      >
                        Open
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
    </Panel>
  );
}
