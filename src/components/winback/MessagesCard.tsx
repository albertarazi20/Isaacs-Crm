"use client";

import { useId, useState } from "react";
import {
  deleteSnippetAction,
  saveMessageSettingsAction,
  saveSnippetAction,
} from "@/app/messaging-actions";
import { findSensitive } from "@/lib/data/sensitive";
import { defaultSnippets, type SnippetKind } from "@/lib/messaging/defaults";
import {
  MERGE_FIELD_HELP,
  MERGE_FIELDS,
  resolveMergeFields,
  splitSubject,
  type MergeField,
} from "@/lib/messaging/merge";
import type { MessageSettings, SnippetRow } from "@/lib/messaging/queries";
import { MAX_SNIPPETS, SIGNATURE_MAX, SNIPPET_BODY_MAX } from "@/lib/messaging/schemas";
import { useApp } from "../app-context";
import { Dialog, useCall } from "../overlay";
import { Badge, Button, Card, cn, Field, Input, Select, Textarea } from "../ui";

const KIND_LABEL: Record<SnippetKind, string> = { text: "Text message", email: "Email" };

interface Draft {
  id?: string;
  title: string;
  kind: SnippetKind;
  body: string;
}

const SAMPLE: Record<MergeField, string> = {
  first_name: "Mike",
  business: "Mike's Pizza",
  sender: "",
  application_link: "",
  amount_wanted: "$60,000",
  funder_best_offer: "$50,000 at 1.42 from Rival Capital",
  upload_link: "https://crm.selectivecap.com/upload/abc123",
};

/** Settings → Messages: signature, application link, and saved snippets. */
export function MessagesCard({
  initial,
  initialSnippets,
}: {
  initial: MessageSettings;
  initialSnippets: SnippetRow[];
}) {
  const call = useCall();
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [snippets, setSnippets] = useState(initialSnippets);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const usingDefaults = snippets.length === 0;

  async function saveSettings() {
    setBusy(true);
    await call(saveMessageSettingsAction(form), "Message settings saved");
    setBusy(false);
  }

  async function remove(id: string) {
    setDeleting(id);
    const list = await call(deleteSnippetAction({ id }), "Snippet deleted");
    setDeleting(null);
    if (list) setSnippets(list);
  }

  return (
    <Card className="space-y-5 p-5">
      <div>
        <h2 className="text-base font-semibold">Messages</h2>
        <p className="text-sm text-muted">
          Your signature, your application link, and the messages you send over and over.
        </p>
      </div>

      <form
        className="space-y-3"
        // Our own message ("Enter a full web address…") says it better than the browser's tooltip.
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void saveSettings();
        }}
      >
        <Field
          label="Email signature"
          hint={`Added to the end of every email you send from here. Leave it empty to end with “Thanks,” and your name. (${form.signature.length}/${SIGNATURE_MAX})`}
        >
          <Textarea
            rows={4}
            value={form.signature}
            maxLength={SIGNATURE_MAX}
            placeholder={"Isaac Cohen\nCommercial funding · (305) 555-0100"}
            onChange={(e) => setForm({ ...form, signature: e.target.value })}
          />
        </Field>
        <Field
          label="Application link"
          hint="Wherever a message says {application_link}, this is what goes in."
        >
          <Input
            type="url"
            inputMode="url"
            value={form.applicationLink}
            maxLength={500}
            placeholder="https://…"
            onChange={(e) => setForm({ ...form, applicationLink: e.target.value })}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Saving…" : "Save signature and link"}
        </Button>
      </form>

      <div className="space-y-3 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Saved snippets</h3>
          <Button
            size="sm"
            variant="primary"
            disabled={snippets.length >= MAX_SNIPPETS}
            onClick={() => setEditing({ title: "", kind: "text", body: "" })}
          >
            + Add snippet
          </Button>
        </div>

        {usingDefaults ? (
          <>
            <p className="rounded-lg bg-surface-2 p-3 text-sm text-muted">
              You&apos;re using the six built-in snippets. Save one of your own and your list
              replaces them everywhere. “Customize” starts you from a built-in one.
            </p>
            <ul className="divide-y divide-border rounded-xl border border-border">
              {defaultSnippets("text").map((d, i) => (
                <li key={d.id} className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {d.title} <Badge>Built-in</Badge>
                    </p>
                    <p className="line-clamp-2 text-sm text-muted">{d.body}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      onClick={() => setEditing({ title: d.title, kind: "text", body: d.body })}
                    >
                      Customize text
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        setEditing({
                          title: d.title,
                          kind: "email",
                          body: defaultSnippets("email")[i]?.body ?? "",
                        })
                      }
                    >
                      Customize email
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <ul className="divide-y divide-border rounded-xl border border-border">
              {snippets.map((s) => (
                <li key={s.id} className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {s.title} <Badge tone="accent">{KIND_LABEL[s.kind]}</Badge>
                    </p>
                    <p className="line-clamp-2 text-sm whitespace-pre-line text-muted">{s.body}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      onClick={() =>
                        setEditing({ id: s.id, title: s.title, kind: s.kind, body: s.body })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={deleting === s.id}
                      aria-label={`Delete ${s.title}`}
                      onClick={() => void remove(s.id)}
                    >
                      {deleting === s.id ? "Deleting…" : "Delete"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            {/* A kind with no saved snippet still uses the built-ins in its picker; show them so they can be seen and edited. */}
            {(["text", "email"] as const)
              .filter((kind) => !snippets.some((s) => s.kind === kind))
              .map((kind) => (
                <div key={kind} className="space-y-2">
                  <p className="rounded-lg bg-surface-2 p-3 text-sm text-muted">
                    You haven&apos;t saved any {kind} snippets, so the {kind} picker still uses the
                    built-in ones. “Customize” starts you from one.
                  </p>
                  <ul className="divide-y divide-border rounded-xl border border-border">
                    {defaultSnippets(kind).map((d) => (
                      <li key={d.id} className="flex items-start justify-between gap-3 p-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">
                            {d.title} <Badge>Built-in {kind}</Badge>
                          </p>
                          <p className="line-clamp-2 text-sm whitespace-pre-line text-muted">
                            {d.body}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => setEditing({ title: d.title, kind, body: d.body })}
                        >
                          Customize
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </>
        )}
      </div>

      {editing ? (
        <SnippetEditor
          draft={editing}
          onClose={() => setEditing(null)}
          onSaved={(list) => {
            setSnippets(list);
            setEditing(null);
          }}
        />
      ) : null}
    </Card>
  );
}

function SnippetEditor({
  draft,
  onClose,
  onSaved,
}: {
  draft: Draft;
  onClose: () => void;
  onSaved: (list: SnippetRow[]) => void;
}) {
  const call = useCall();
  const { senderName } = useApp();
  const formId = useId();
  const bodyId = `${formId}-body`;
  // The dialog only mounts while editing, so this state starts from the draft each time and a failed save keeps it.
  const [v, setV] = useState(draft);
  const [busy, setBusy] = useState(false);

  const sample = { ...SAMPLE, sender: senderName.split(/\s+/)[0] ?? "Isaac" };
  const { subject, body: bodyOnly } =
    v.kind === "email" ? splitSubject(v.body) : { subject: null, body: v.body };
  const preview = resolveMergeFields(bodyOnly, sample);
  const sensitive = findSensitive(v.body);
  const problem =
    preview.unknown.length > 0
      ? `{${preview.unknown[0]}} isn't a field I know. Use the buttons below to add one.`
      : (sensitive?.message ?? null);

  function insert(field: MergeField) {
    const el = document.getElementById(bodyId) as HTMLTextAreaElement | null;
    const token = `{${field}}`;
    const start = el?.selectionStart ?? v.body.length;
    const end = el?.selectionEnd ?? v.body.length;
    const next = v.body.slice(0, start) + token + v.body.slice(end);
    setV({ ...v, body: next });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function save() {
    setBusy(true);
    const list = await call(
      saveSnippetAction({ id: v.id, title: v.title, kind: v.kind, body: v.body }),
      "Snippet saved",
    );
    setBusy(false);
    if (list) onSaved(list);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={v.id ? "Edit snippet" : "New snippet"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={busy}>
            {busy ? "Saving…" : "Save snippet"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void save();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <Field label="Name">
            <Input
              value={v.title}
              maxLength={80}
              placeholder="Send application"
              onChange={(e) => setV({ ...v, title: e.target.value })}
              autoFocus
            />
          </Field>
          <Field label="Used for">
            <Select
              value={v.kind}
              onChange={(e) => setV({ ...v, kind: e.target.value as SnippetKind })}
            >
              <option value="text">{KIND_LABEL.text}</option>
              <option value="email">{KIND_LABEL.email}</option>
            </Select>
          </Field>
        </div>
        <Field
          label="Message"
          hint={
            v.kind === "email"
              ? "Start with a line like “Subject: Your application for {business}” to set the subject. Your signature is added to the end."
              : undefined
          }
        >
          <Textarea
            id={bodyId}
            rows={7}
            maxLength={SNIPPET_BODY_MAX}
            value={v.body}
            placeholder="Hey {first_name}, it's {sender}…"
            onChange={(e) => setV({ ...v, body: e.target.value })}
          />
        </Field>
        <div>
          <p className="text-xs font-medium text-muted">Insert a field</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {MERGE_FIELDS.map((f) => (
              <button
                key={f}
                type="button"
                title={MERGE_FIELD_HELP[f]}
                onClick={() => insert(f)}
                className="h-8 rounded-full border border-border bg-surface px-3 text-sm hover:bg-surface-2"
              >
                {`{${f}}`}
              </button>
            ))}
          </div>
        </div>
        {problem ? (
          <p role="alert" className="rounded-lg bg-bad-soft p-2 text-sm text-bad">
            {problem}
          </p>
        ) : null}
        {v.body.trim() ? (
          <div className="rounded-lg border border-dashed border-border p-3">
            <p className="text-xs font-medium text-muted">Preview with an example merchant</p>
            {subject ? (
              <p className="mt-1 text-sm font-medium">{resolveMergeFields(subject, sample).text}</p>
            ) : null}
            <p className={cn("mt-1 text-sm whitespace-pre-wrap")} data-testid="snippet-preview">
              {preview.text}
            </p>
            {preview.missing.length > 0 ? (
              <p className="mt-1 text-xs text-muted">
                {preview.missing.map((m) => `{${m}}`).join(", ")} fills in from the merchant or your
                settings when you use it. If there is nothing to fill it with, the message shows it
                so you can fix it before sending.
              </p>
            ) : null}
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
