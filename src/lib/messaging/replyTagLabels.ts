import type { ReplyTag } from "../ai/classifyReply";
import { formatDate } from "../format";
import type { ISODate } from "../mca/dates";

/**
 * The reply tag chip on a lead line (S1-6): what Claude called the merchant's last reply. Words and a tone only —
 * browser-safe, so the Follow Up page and the tests share it. "Other" has no chip: it changed nothing.
 */
export type ChipTone = "good" | "info" | "warn" | "bad";

export interface ReplyChip {
  label: string;
  tone: ChipTone;
}

export function replyChip(
  tag: ReplyTag | null,
  reviveOn: ISODate | null,
  today: ISODate,
): ReplyChip | null {
  switch (tag) {
    case "interested":
      return { label: "Interested", tone: "good" };
    case "sending_docs":
      return { label: "Sending docs", tone: "info" };
    case "not_now":
      return {
        label: reviveOn ? `Not now — back ${formatDate(reviveOn, today)}` : "Not now",
        tone: "warn",
      };
    case "wrong_person":
      return { label: "Wrong person", tone: "bad" };
    case "stop":
      return { label: "Stop", tone: "bad" };
    default:
      return null;
  }
}

/** "Paused until Nov 30", or plain "Paused" for a pause with no date. */
export function pausedLabel(resumeOn: ISODate | null, today: ISODate): string {
  return resumeOn ? `Paused until ${formatDate(resumeOn, today)}` : "Paused";
}
