import { minuteLabel } from "../settings/format";
import type { BucketRow } from "./queries";

/** What choosing this bucket sets in motion, from the steps it holds. */
export function bucketSends(
  b: Pick<BucketRow, "email_steps" | "call_steps" | "daily_template_id" | "daily_reminder_minute">,
): string {
  if (b.daily_template_id)
    return `One email every day but Saturday at ${minuteLabel(b.daily_reminder_minute)}, their time`;
  if (b.email_steps === 0)
    return b.call_steps > 0 ? "No emails: a call task for you" : "No emails set up yet";
  const more = b.email_steps - 1;
  const parts = [
    more > 0 ? `${more} more email${more === 1 ? "" : "s"}` : "",
    b.call_steps > 0 ? `${b.call_steps === 1 ? "a call task" : `${b.call_steps} call tasks`}` : "",
  ].filter(Boolean);
  return parts.length === 0
    ? "One email on submit"
    : `First email on submit, then ${parts.join(" and ")}`;
}
