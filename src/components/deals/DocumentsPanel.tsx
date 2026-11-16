"use client";

import { forwardDocumentsAction } from "@/app/inbox-actions";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  deleteDocumentAction,
  mintLenderLinkAction,
  relabelDocumentAction,
  revokeLenderLinkAction,
} from "@/app/docs-actions";
import { useApp } from "@/components/app-context";
import { ConfirmButton, FormDialog, Muted, copyText, useRun } from "@/components/client/parts";
import { Icon } from "@/components/deals/primitives";
import { QuietConfirm } from "@/components/funders/QuietConfirm";
import { useToast } from "@/components/overlay";
import { Badge, Button, EmptyState, Field, Input, Select, buttonClass, cn } from "@/components/ui";
import type { Freshness } from "@/lib/docs/freshness";
import { DOC_KINDS, DOC_LABELS, type DocKind } from "@/lib/docs/label";
import {
  LINK_EXPIRY_LABELS,
  LINK_EXPIRY_MINUTES,
  type DocumentLinkRow,
  type LinkExpiry,
} from "@/lib/docs/linkExpiry";
import type { DocumentRow } from "@/lib/docs/upload";
import { formatDate } from "@/lib/format";
import { ResetUploadLinkButton, UploadLinkButton } from "./UploadLinkButton";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.csv,.xlsx,.docx";

/** A lender row on the deal, as the panel's two lender pickers list it. */
export interface PanelLender {
  submissionId: string;
  /** The funder's id — the lender link is stamped from its record. */
  funderId: string;
  name: string;
  status: string;
}

/** A freshly minted link, shown under its document until the page moves on. */
interface Minted {
  documentId: string;
  url: string;
  expiresAt: string;
  lenderName: string;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Who a link is for: the funder's record, else the name typed when it was minted. */
const linkName = (l: DocumentLinkRow): string =>
  l.lender_name ?? (l.watermark.replace(/^Prepared for /, "") || "the lender");

/** "in 2 hours", "in 6 days", "in 40 min" — how long a link has left. */
export function expiresIn(iso: string, nowMs: number): string {
  const mins = Math.round((new Date(iso).getTime() - nowMs) / 60_000);
  if (mins < 1) return "expiring";
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
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
 * Who the copy is for and how long the link lives. The lender comes from the deal's lender rows, so the
 * watermark and the link's lender are the funder's record; with no lender on the deal yet, a typed name.
 */
function LenderLinkDialog({
  doc,
  lenders,
  onMinted,
  onClose,
}: {
  doc: DocumentRow;
  lenders: PanelLender[];
  onMinted: (m: Minted) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [funderId, setFunderId] = useState(
    lenders.find((l) => l.status === "stips_requested")?.funderId ?? lenders[0]?.funderId ?? "",
  );
  const [typedName, setTypedName] = useState("");
  const [expiry, setExpiry] = useState<LinkExpiry>("2h");
  // one option per lender, even when the same lender has two rows on the deal
  const options = lenders.filter(
    (l, i) => lenders.findIndex((x) => x.funderId === l.funderId) === i,
  );
  const typing = funderId === "";

  async function mint() {
    if (typing && typedName.trim() === "") {
      toast({ message: "Say who the copy is for — it is stamped on every page", tone: "error" });
      return;
    }
    setBusy(true);
    const r = await mintLenderLinkAction({
      documentId: doc.id,
      lenderId: typing ? null : funderId,
      lenderName: typing ? typedName : "",
      minutes: LINK_EXPIRY_MINUTES[expiry],
    });
    setBusy(false);
    if (!r.ok) return toast({ message: r.error, tone: "error" });
    const copied = await copyText(r.data.url);
    toast({
      message: copied
        ? `Link for ${r.data.lenderName || "the lender"} copied — good for ${LINK_EXPIRY_LABELS[expiry]}, 5 downloads, watermarked`
        : `Link minted — good for ${LINK_EXPIRY_LABELS[expiry]}`,
      tone: "success",
    });
    onMinted({ documentId: doc.id, ...r.data });
    onClose();
  }

  return (
    <FormDialog
      title={`Lender link — ${doc.label}`}
      onClose={onClose}
      onSubmit={() => void mint()}
      busy={busy}
      submitLabel="Mint link"
    >
      <Field label="Which lender is this copy for" hint="Stamped on every page of the download">
        <Select value={funderId} onChange={(e) => setFunderId(e.target.value)} autoFocus>
          {options.map((l) => (
            <option key={l.funderId} value={l.funderId}>
              {l.name} · {l.status.replace(/_/g, " ")}
            </option>
          ))}
          <option value="">Someone else…</option>
        </Select>
      </Field>
      {typing ? (
        <Field label="Their name">
          <Input
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            maxLength={80}
            placeholder="Who gets this copy"
          />
        </Field>
      ) : null}
      <Field label="Good for">
        <Select value={expiry} onChange={(e) => setExpiry(e.target.value as LinkExpiry)}>
          {(Object.keys(LINK_EXPIRY_LABELS) as LinkExpiry[]).map((k) => (
            <option key={k} value={k}>
              {LINK_EXPIRY_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Muted>
        Five downloads, then it dies on its own. You can revoke it any time from the list under the
        document.
      </Muted>
    </FormDialog>
  );
}

export function DocumentsPanel({
  clientId,
  dealId,
  documents,
  freshness,
  canDelete,
  today,
  lenders = [],
  links = [],
}: {
  clientId: string;
  dealId: string | null;
  documents: DocumentRow[];
  freshness: Freshness;
  canDelete: boolean;
  today: string;
  /** The deal's lender rows, for "send the checked files to…" and the lender link. */
  lenders?: PanelLender[];
  /** The live lender links on these documents (revoke them here). */
  links?: DocumentLinkRow[];
}) {
  const { nowMs } = useApp();
  const router = useRouter();
  const toast = useToast();
  const run = useRun();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [linking, setLinking] = useState<DocumentRow | null>(null);
  const [minted, setMinted] = useState<Minted | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [lenderSub, setLenderSub] = useState(
    lenders.find((l) => l.status === "stips_requested")?.submissionId ??
      lenders[0]?.submissionId ??
      "",
  );
  const toggle = (id: string) =>
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function sendToLender() {
    const ids = [...checked].filter((id) =>
      documents.some((d) => d.id === id && d.scan_status === "clean"),
    );
    if (!lenderSub || ids.length === 0) return;
    const name = lenders.find((l) => l.submissionId === lenderSub)?.name ?? "the lender";
    if (
      !window.confirm(
        `Send ${ids.length} file${ids.length === 1 ? "" : "s"} to ${name}? They get expiring links stamped with their name, on the same email thread.`,
      )
    )
      return;
    setBusy(true);
    const r = await forwardDocumentsAction({ submissionId: lenderSub, documentIds: ids });
    setBusy(false);
    if (!r.ok) return toast({ message: r.error, tone: "error" });
    toast({
      message: `Sent ${r.data.links} link${r.data.links === 1 ? "" : "s"} to ${name}`,
      tone: "success",
    });
    setChecked(new Set());
    router.refresh();
  }

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

  async function revoke(l: DocumentLinkRow) {
    setBusy(true);
    const ok = await run(
      revokeLenderLinkAction({ linkId: l.id }),
      `Link for ${linkName(l)} revoked — the next download is refused`,
    );
    setBusy(false);
    if (ok) {
      if (minted && links.some((x) => x.id === l.id && x.document_id === minted.documentId))
        setMinted(null);
      router.refresh();
    }
  }

  async function copyMinted(m: Minted) {
    const copied = await copyText(m.url);
    toast(
      copied
        ? { message: "Lender link copied", tone: "success" }
        : { message: "Couldn't copy — select it and press Ctrl+C", tone: "error" },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
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
          {lenders.length > 0 && documents.some((d) => d.scan_status === "clean") ? (
            <span className="flex items-center gap-1.5">
              <select
                aria-label="Send to lender"
                value={lenderSub}
                onChange={(e) => setLenderSub(e.target.value)}
                className="h-10 rounded-lg border border-border bg-surface px-2 text-sm text-text transition hover:border-border-strong focus:border-accent focus:ring-2 focus:ring-ring focus:outline-none sm:h-8 sm:text-[13px]"
              >
                {lenders.map((l) => (
                  <option key={l.submissionId} value={l.submissionId}>
                    {l.name} · {l.status.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={busy || checked.size === 0 || !lenderSub}
                onClick={sendToLender}
              >
                <Icon name="send" className="size-3.5 text-muted" />
                Send checked ({checked.size})
              </Button>
            </span>
          ) : null}
          <UploadLinkButton clientId={clientId} dealId={dealId} />
          <ResetUploadLinkButton clientId={clientId} />
          <Button size="sm" disabled={busy} onClick={() => input.current?.click()}>
            <Icon name="upload" className="size-3.5 text-muted" />
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
      </div>
      {documents.length === 0 ? (
        <EmptyState title="No documents yet">
          Drop files here, or send the merchant their upload link — statements file themselves by
          month.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {documents.map((d) => {
            const live = links.filter((l) => l.document_id === d.id);
            const fresh = minted?.documentId === d.id ? minted : null;
            return (
              <li key={d.id} className="px-4 py-3 sm:py-2.5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="flex min-w-0 flex-1 basis-64 items-start gap-2.5">
                    {lenders.length > 0 ? (
                      <input
                        type="checkbox"
                        className="mt-1 size-4 shrink-0 accent-accent"
                        aria-label={`Check ${d.label}`}
                        disabled={d.scan_status !== "clean"}
                        checked={checked.has(d.id)}
                        onChange={() => toggle(d.id)}
                      />
                    ) : (
                      <Icon name="file" className="mt-1 text-muted" />
                    )}
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
                        {d.views > 0 ? ` · opened ${d.views}×` : ""}
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
                        <Icon name="external" className="size-3.5 text-muted" />
                        Open
                      </a>
                    ) : null}
                    {d.scan_status === "clean" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setLinking(d)}
                      >
                        <Icon name="link" className="size-3.5" />
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
                          const ok = await run(
                            deleteDocumentAction({ documentId: d.id }),
                            "Deleted",
                          );
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
                {fresh ? (
                  <div
                    className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-good/30 bg-good-soft px-3 py-2 text-sm"
                    data-minted-link
                  >
                    <Icon name="link" className="text-good" />
                    <span className="font-medium text-good">
                      Link for {fresh.lenderName || "the lender"}
                    </span>
                    <code className="min-w-0 flex-1 truncate text-xs" title={fresh.url}>
                      {fresh.url}
                    </code>
                    <span className="text-xs text-muted">
                      expires {expiresIn(fresh.expiresAt, nowMs)}
                    </span>
                    <Button size="sm" onClick={() => void copyMinted(fresh)}>
                      Copy
                    </Button>
                  </div>
                ) : null}
                {live.length > 0 ? (
                  <ul className="mt-2 space-y-1" aria-label={`Live lender links for ${d.label}`}>
                    {live.map((l) => (
                      <li
                        key={l.id}
                        data-link={l.id}
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-surface-2 px-3 py-1 text-xs"
                      >
                        <Icon name="link" className="size-3.5 text-muted" />
                        <span className="font-medium text-text">{linkName(l)}</span>
                        <span className="text-muted">
                          expires {expiresIn(l.expires_at, nowMs)} · {l.downloads} of{" "}
                          {l.max_downloads} downloads
                          {l.created_by_name ? ` · minted by ${l.created_by_name}` : ""}
                        </span>
                        <span className="ml-auto">
                          <QuietConfirm
                            label="Revoke"
                            confirmLabel="Click again to revoke"
                            busy={busy}
                            onConfirm={() => void revoke(l)}
                          />
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {linking ? (
        <LenderLinkDialog
          doc={linking}
          lenders={lenders}
          onMinted={(m) => {
            setMinted(m);
            router.refresh();
          }}
          onClose={() => setLinking(null)}
        />
      ) : null}
    </div>
  );
}
