"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  approveTemplateAction,
  archiveTemplateAction,
  saveTemplateAction,
} from "@/app/buckets-actions";
import { FormDialog, useFormState, useRun } from "@/components/client/parts";
import { Badge, Button, EmptyState, Field, Input, Textarea, cn } from "@/components/ui";
import type { TemplateRow } from "@/lib/buckets/queries";
import { MERGE_FIELD_HELP, MERGE_FIELDS } from "@/lib/messaging/merge";
import { SettingsCard } from "./primitives";
import { Toggle } from "./Toggle";

function Editor({
  t,
  canShare,
  onClose,
}: {
  t: TemplateRow | null;
  canShare: boolean;
  onClose: () => void;
}) {
  const run = useRun();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { v, bind, set } = useFormState(() => ({
    name: t?.name ?? "",
    subject: t?.subject ?? "",
    body: t?.body ?? "",
    shared: t ? t.owner_id === null : canShare,
  }));
  return (
    <FormDialog
      title={t ? `Edit “${t.name}”` : "New template"}
      onClose={onClose}
      busy={busy}
      wide
      submitLabel={t ? "Save" : "Create"}
      onSubmit={async () => {
        setBusy(true);
        const ok = await run(
          saveTemplateAction({
            id: t?.id,
            name: v.name,
            subject: v.subject,
            body: v.body,
            shared: v.shared,
          }),
          t ? "Saved" : "Template made",
        );
        setBusy(false);
        if (ok) {
          onClose();
          router.refresh();
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input {...bind("name")} placeholder="Interested — follow up" required />
        </Field>
        <Field label="Subject">
          <Input {...bind("subject")} placeholder="{first_name}, your statements for {business}" />
        </Field>
      </div>
      <Field label="Body">
        <Textarea
          {...bind("body")}
          rows={9}
          placeholder={
            "Hi {first_name},\n\nWe just need your last three statements to get {business} approved. Upload them here: {upload_link}\n\n{sender}"
          }
          required
        />
      </Field>
      <p className="text-xs text-muted">
        Merge fields:{" "}
        <span className="font-mono text-[11px] text-text-2">
          {MERGE_FIELDS.map((f) => `{${f}}`).join(" ")}
        </span>
        . A field with nothing to fill is never sent as a blank — the email is skipped instead.
      </p>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer font-medium transition hover:text-text">
          What each field means
        </summary>
        <ul className="mt-1.5 space-y-1 rounded-lg border border-border bg-surface-3 p-3">
          {MERGE_FIELDS.map((f) => (
            <li key={f}>
              <span className="font-mono text-text-2">{`{${f}}`}</span> — {MERGE_FIELD_HELP[f]}
            </li>
          ))}
        </ul>
      </details>
      {canShare && !t ? (
        <Toggle
          label="Shared with the whole shop"
          checked={v.shared}
          onChange={(x) => set("shared", x)}
        />
      ) : null}
    </FormDialog>
  );
}

export function TemplateEditor({
  templates,
  manager,
  only,
}: {
  templates: TemplateRow[];
  manager: boolean;
  only?: "winback" | "buckets";
}) {
  const run = useRun();
  const router = useRouter();
  const [editing, setEditing] = useState<TemplateRow | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const isWinback = (t: TemplateRow) => t.name.toLowerCase().startsWith("winback");
  const shown =
    only === "winback"
      ? templates.filter(isWinback)
      : only === "buckets"
        ? templates.filter((t) => !isWinback(t))
        : templates;
  return (
    <SettingsCard
      title="Templates"
      flush
      aside={
        <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
          + Template
        </Button>
      }
    >
      {shown.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState title="No templates yet">
            Write one; a rep&apos;s template waits for a manager&apos;s approval before the engine
            sends it on its own.
          </EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {shown.map((t) => (
            <li
              key={t.id}
              className={cn(
                "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3",
                t.archived && "opacity-60",
              )}
            >
              <div className="min-w-0 flex-1 basis-56">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
                  <span className="truncate">{t.name}</span>
                  <Badge tone={t.approved ? "good" : "warn"}>
                    {t.approved ? "approved" : "needs approval"}
                  </Badge>
                  {t.owner_id ? <span className="text-xs font-normal text-muted">mine</span> : null}
                  {t.archived ? (
                    <span className="text-xs font-normal text-muted">archived</span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-muted">
                  {t.subject || "(no subject)"} · {t.body.slice(0, 90).replace(/\s+/g, " ")}…
                </p>
                {t.used_in.length ? (
                  <p className="truncate text-xs text-muted">Used in: {t.used_in.join(", ")}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap gap-1.5">
                {manager || t.owner_id !== null ? (
                  <Button size="sm" onClick={() => setEditing(t)}>
                    Edit
                  </Button>
                ) : null}
                {manager ? (
                  <Button
                    size="sm"
                    variant={t.approved ? "ghost" : "secondary"}
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      const ok = await run(
                        approveTemplateAction({ templateId: t.id, approved: !t.approved }),
                        t.approved ? "Approval removed" : "Approved",
                      );
                      setBusy(false);
                      if (ok) router.refresh();
                    }}
                  >
                    {t.approved ? "Unapprove" : "Approve"}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const ok = await run(
                      archiveTemplateAction({ templateId: t.id, archived: !t.archived }),
                      t.archived ? "Restored" : "Archived",
                    );
                    setBusy(false);
                    if (ok) router.refresh();
                  }}
                >
                  {t.archived ? "Restore" : "Archive"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <Editor
          t={editing === "new" ? null : editing}
          canShare={manager}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SettingsCard>
  );
}
