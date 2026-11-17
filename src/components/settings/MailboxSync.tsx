import { Avatar } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import type { MailboxSyncRow } from "@/lib/inbox/sync";
import { SettingsCard, StatusChip } from "./primitives";

/**
 * Last synced per mailbox (S2-18): when each connected Gmail was last read for merchant replies, what it saw, and the
 * error if the last read failed. A server component: the page loads mailbox_sync_status() and passes the rows.
 */
export function MailboxSync({ rows, nowMs }: { rows: MailboxSyncRow[]; nowMs: number }) {
  const healthy = rows.filter((m) => m.connection_status === "ok" && !m.last_error).length;
  return (
    <SettingsCard
      title="Mailbox sync"
      description="When each connected Gmail was last read for merchant replies. A mailbox that stops syncing stops feeding the reply alerts."
      aside={
        rows.length > 0 ? (
          <StatusChip tone={healthy === rows.length ? "good" : "warn"}>
            {healthy} of {rows.length} healthy
          </StatusChip>
        ) : (
          <StatusChip>No mailbox</StatusChip>
        )
      }
      flush
    >
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-[13px] text-muted sm:px-5">
          No Gmail is connected yet. Each person connects theirs on their own My account page.
        </p>
      ) : (
        <ul className="divide-y divide-border text-[13px]">
          {rows.map((m) => (
            <li
              key={m.user_id}
              data-mailbox={m.email}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 transition-colors duration-150 hover:bg-surface-2/50 sm:px-5"
            >
              <span className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                <Avatar name={m.name || m.email} size={34} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{m.name || m.email}</span>
                  <span className="block truncate text-xs text-muted">{m.google_email}</span>
                  {m.last_error ? (
                    <span className="mt-0.5 block text-xs break-words text-bad">
                      {m.last_error}
                    </span>
                  ) : null}
                </span>
              </span>
              <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">
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
                {m.connection_status !== "ok" ? (
                  <StatusChip tone="bad">{m.connection_status.replace(/_/g, " ")}</StatusChip>
                ) : m.last_error ? (
                  <StatusChip tone="bad">Read failed</StatusChip>
                ) : !m.can_read_mail ? (
                  <StatusChip tone="warn">Send only</StatusChip>
                ) : (
                  <StatusChip tone="good">Connected</StatusChip>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}
