import { Badge, cn } from "@/components/ui";
import type { BucketScore, TemplateScore } from "@/lib/buckets/queries";
import { pctText } from "@/lib/settings/format";
import { SettingsCard, SHEET } from "./primitives";

type Row = {
  key: string;
  name: string;
  sent: number;
  reply_rate: number;
  docs_rate: number;
  bounce_rate: number;
  unsubscribe_rate: number;
  avg_days_to_docs: number | null;
  members?: number;
  paused?: boolean;
};

function Table({ rows, first }: { rows: Row[]; first: string }) {
  const hasMembers = rows.some((r) => r.members !== undefined);
  return (
    <div className="overflow-x-auto border-t border-border">
      <table className={cn(SHEET.table, "min-w-[640px]")}>
        <thead className={SHEET.thead}>
          <tr>
            <th className={SHEET.th}>{first}</th>
            {hasMembers ? <th className={SHEET.thNum}>In it</th> : null}
            <th className={SHEET.thNum}>Sent</th>
            <th className={SHEET.thNum}>Replied</th>
            <th className={SHEET.thNum}>Sent docs</th>
            <th className={SHEET.thNum}>Bounced</th>
            <th className={SHEET.thNum}>Unsubscribed</th>
            <th className={SHEET.thNum}>Days to docs</th>
          </tr>
        </thead>
        <tbody className={SHEET.tbody}>
          {rows.map((r) => (
            <tr
              key={r.key}
              className={cn(SHEET.tr, r.sent === 0 && "text-muted")}
              data-score={r.key}
            >
              <td className={cn(SHEET.td, "max-w-56")}>
                <span className="block truncate font-medium">{r.name}</span>
                {r.paused ? (
                  <Badge tone="warn" className="mt-0.5">
                    paused
                  </Badge>
                ) : null}
              </td>
              {hasMembers ? <td className={SHEET.tdNum}>{r.members ?? 0}</td> : null}
              <td className={SHEET.tdNum}>{r.sent}</td>
              <td className={SHEET.tdNum}>{r.sent ? pctText(r.reply_rate) : "—"}</td>
              <td className={SHEET.tdNum}>{r.sent ? pctText(r.docs_rate) : "—"}</td>
              <td
                className={cn(
                  SHEET.tdNum,
                  r.sent > 0 && r.bounce_rate >= 0.05 && "font-semibold text-bad",
                )}
              >
                {r.sent ? pctText(r.bounce_rate) : "—"}
              </td>
              <td className={SHEET.tdNum}>{r.sent ? pctText(r.unsubscribe_rate) : "—"}</td>
              <td className={SHEET.tdNum}>
                {r.avg_days_to_docs === null ? "—" : r.avg_days_to_docs}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What each bucket and template actually did (S1-7): sends in the window, and the share that got a reply, brought
 * documents, bounced or unsubscribed within 14 days. A server component: the page passes the score rows.
 */
export function ScoresCard({
  buckets,
  templates,
  days,
  manager,
}: {
  buckets?: BucketScore[];
  templates: TemplateScore[];
  days: number;
  manager: boolean;
}) {
  const sentTemplates = templates.filter((t) => t.sent > 0);
  const quiet = templates.length - sentTemplates.length;
  return (
    <SettingsCard
      id="scores"
      title={`Scores · last ${days} days`}
      description={
        manager
          ? "What the shop's automated emails did. A reply, a document or an unsubscribe within 14 days of a send counts for that send."
          : "What your automated emails did. A reply, a document or an unsubscribe within 14 days of a send counts for that send."
      }
      flush
    >
      {buckets && buckets.length > 0 ? (
        <Table
          first="Bucket"
          rows={buckets.map((b) => ({
            key: `bucket-${b.bucket_id}`,
            name: b.name,
            members: b.members,
            sent: b.sent,
            reply_rate: b.reply_rate,
            docs_rate: b.docs_rate,
            bounce_rate: b.bounce_rate,
            unsubscribe_rate: b.unsubscribe_rate,
            avg_days_to_docs: b.avg_days_to_docs,
          }))}
        />
      ) : null}
      {sentTemplates.length > 0 ? (
        <Table
          first="Template"
          rows={sentTemplates.map((t) => ({
            key: `template-${t.template_id}`,
            name: t.name,
            sent: t.sent,
            reply_rate: t.reply_rate,
            docs_rate: t.docs_rate,
            bounce_rate: t.bounce_rate,
            unsubscribe_rate: t.unsubscribe_rate,
            avg_days_to_docs: t.avg_days_to_docs,
            paused: t.auto_paused_at !== null,
          }))}
        />
      ) : (
        <p className="border-t border-border px-4 py-4 text-[13px] text-muted sm:px-5">
          No template has sent yet in this window.
        </p>
      )}
      {quiet > 0 && sentTemplates.length > 0 ? (
        <p className="border-t border-border bg-surface-3/50 px-4 py-2.5 text-xs text-muted sm:px-5">
          {quiet} more template{quiet === 1 ? " has" : "s have"} not sent in this window.
        </p>
      ) : null}
    </SettingsCard>
  );
}
