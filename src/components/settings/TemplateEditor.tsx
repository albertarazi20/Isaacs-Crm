"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  approveTemplateAction,
  archiveTemplateAction,
  saveTemplateAction,
} from "@/app/buckets-actions";
import { FormDialog, useFormState, useRun } from "@/components/client/parts";
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  SectionTitle,
  Textarea,
  cn,
} from "@/components/ui";
import type { TemplateRow } from "@/lib/buckets/queries";
import { MERGE_FIELD_HELP, MERGE_FIELDS } from "@/lib/messaging/merge";

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
        Merge fields: {MERGE_FIELDS.map((f) => `{${f}}`).join(" ")}. A field with nothing to fill is
        never sent as a blank — the email is skipped instead.
      </p>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">What each field means</summary>
        <ul className="mt-1 space-y-0.5">
          {MERGE_FIELDS.map((f) => (
            <li key={f}>
              <span className="font-mono">{`{${f}}`}</span> — {MERGE_FIELD_HELP[f]}
            </li>
          ))}
        </ul>
      </details>
      {canShare && !t ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={v.shared}
            onChange={(e) => set("shared", e.target.checked)}
          />{" "}
          Shared with the whole shop
        </label>
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
    <Card className="p-0">
      <div className="flex items-center justify-between px-4 pt-4">
        <SectionTitle>Templates</SectionTitle>
        <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
          + Template
        </Button>
      </div>
      {shown.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No templates yet">
            Write one; a rep&apos;s template waits for a manager&apos;s approval before the engine
            sends it on its own.
          </EmptyState>
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {shown.map((t) => (
            <li
              key={t.id}
              className={cn(
                "flex flex-wrap items-start justify-between gap-3 px-4 py-3",
                t.archived && "opacity-60",
              )}
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  {t.name}
                  <span
                    className={cn(
                      "ml-2 rounded px-1.5 py-0.5 text-[11px] font-medium",
                      t.approved ? "bg-good-soft text-good" : "bg-warn-soft text-warn",
                    )}
                  >
                    {t.approved ? "approved" : "needs approval"}
                  </span>
                  {t.owner_id ? (
                    <span className="ml-1 text-xs font-normal text-muted">mine</span>
                  ) : null}
                  {t.archived ? (
                    <span className="ml-1 text-xs font-normal text-muted">archived</span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-muted">
                  {t.subject || "(no subject)"} · {t.body.slice(0, 90).replace(/\s+/g, " ")}…
                </p>
                {t.used_in.length ? (
                  <p className="text-xs text-muted">Used in: {t.used_in.join(", ")}</p>
                ) : null}
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" onClick={() => setEditing(t)}>
                  Edit
                </Button>
                {manager ? (
                  <Button
                    size="sm"
                    variant={t.approved ? "ghost" : "primary"}
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
    </Card>
  );
}
