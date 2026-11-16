import { Badge } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import type { MailboxSyncRow } from "@/lib/inbox/sync";
import { SettingsCard } from "./primitives";

/**
 * Last synced per mailbox (S2-18): when each connected Gmail was last read for lender replies, what it saw, and the
 * error if the last read failed. A server component: the page loads mailbox_sync_status() and passes the rows.
 */
export function MailboxSync({ rows, nowMs }: { rows: MailboxSyncRow[]; nowMs: number }) {
  return (
    <SettingsCard
      title="Mailbox sync"
      description="When each connected Gmail was last read for lender replies. A mailbox that stops syncing stops feeding the board."
      aside={
        <Badge tone="neutral" className="tabular-nums">
          {rows.length}
        </Badge>
      }
      flush
    >
      {rows.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted">
          No Gmail is connected yet. Each person connects theirs on their own Settings page.
        </p>
      ) : (
        <ul className="divide-y divide-border border-t border-border text-[13px]">
          {rows.map((m) => (
            <li
              key={m.user_id}
              data-mailbox={m.email}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-2.5"
            >
              <span className="min-w-0 flex-1 basis-56">
                <span className="block truncate font-medium">{m.name || m.email}</span>
                <span className="block truncate text-xs text-muted">{m.google_email}</span>
                {m.last_error ? (
                  <span className="mt-0.5 block text-xs break-words text-bad">{m.last_error}</span>
                ) : null}
              </span>
              <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                {m.connection_status !== "ok" ? (
                  <Badge tone="bad">{m.connection_status.replace(/_/g, " ")}</Badge>
                ) : null}
                {!m.can_read_mail ? <Badge tone="warn">send only</Badge> : null}
                <span
                  className="text-xs text-muted tabular-nums"
                  data-synced={m.last_synced_at ?? "never"}
                >
                  {m.can_read_mail
                    ? m.last_synced_at
                      ? `synced ${timeAgo(m.last_synced_at, new Date(nowMs))} · ${m.messages_seen} seen`
                      : "never synced"
                    : "not read"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}
