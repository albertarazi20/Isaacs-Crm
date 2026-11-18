import type { BucketMember } from "../buckets/queries";
import { missingDocsPhrase } from "../mca/stips";
import { formatUS, normalizeUS } from "../mca/phone";
import { toCsv } from "./csv";

/**
 * A bucket (or every bucket) as a spreadsheet, for a sheet and a text blast. Anyone marked do-not-contact is left out
 * of the file altogether; the rest carry Call OK / Text OK / Email OK so a blast can filter on them.
 */
export const FOLLOWUP_HEADER = [
  "Business",
  "Contact",
  "Phone",
  "Phone (E.164)",
  "Email",
  "State",
  "Time zone",
  "Bucket",
  "Next step",
  "Next step date",
  "Emails sent",
  "Last touch",
  "Still missing",
  "Paused",
  "Rep",
  "Added to bucket",
  "Call OK",
  "Text OK",
  "Email OK",
] as const;

const yes = (b: boolean) => (b ? "yes" : "no");

export function followupRows(members: readonly BucketMember[]): {
  rows: unknown[][];
  left: number;
} {
  const kept = members.filter((m) => m.contact_status !== "dnc");
  const rows = kept.map((m) => {
    const e164 = normalizeUS(m.phone);
    return [
      m.business_name,
      m.contact_name,
      // shown as (305) 555-0100, which a spreadsheet never reads as a formula
      e164 ? formatUS(m.phone) : m.phone,
      e164 ?? "",
      m.email,
      m.state,
      m.tz_label,
      m.bucket_name,
      `Step ${m.next_step}`,
      m.next_due_on ?? "",
      m.steps_sent,
      m.last_touch_at ? new Date(m.last_touch_at).toISOString().slice(0, 10) : "",
      missingDocsPhrase(m.missing),
      yes(m.paused),
      m.rep_name,
      new Date(m.entered_at).toISOString().slice(0, 10),
      yes(e164 !== null && m.contact_status !== "no_call"),
      yes(e164 !== null && m.contact_status !== "no_text"),
      yes(
        m.email.trim() !== "" &&
          !m.email_opt_out &&
          !m.email_bounced &&
          m.contact_status !== "no_email",
      ),
    ];
  });
  return { rows, left: members.length - kept.length };
}

export function followupCsv(members: readonly BucketMember[]): { csv: string; left: number } {
  const { rows, left } = followupRows(members);
  return { csv: toCsv(FOLLOWUP_HEADER, rows), left };
}

/** "Interested" → "interested", "Missing ID / voided check" → "missing-id-voided-check", for a file name. */
export const fileSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "bucket";
