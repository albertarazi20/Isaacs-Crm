import { isStopMessage } from "../messaging/stop";

/**
 * Is this message a machine answering ours (an out-of-office, a vacation responder, a mailing-list or bulk bounce)
 * rather than the merchant writing back? It must not stop their follow-ups or raise "Replied, call them now".
 * `headers` are the lower-cased header names the Gmail reader returns.
 *
 * Two headers are only weak evidence (Precedence: bulk/junk and X-Auto-Response-Suppress are also set on ordinary mail by
 * some mail systems and mailing lists). When the text of the message is a stop request, such a message is treated as the
 * merchant's own: a real STOP must never be dropped as an auto-reply.
 */
export function isAutoReply(
  headers: Record<string, string>,
  subject: string,
  text: string = "",
): boolean {
  const h = (name: string): string | undefined => headers[name];
  // RFC 3834: anything but "no" says the message was generated, not written
  const submitted = h("auto-submitted");
  if (submitted !== undefined && submitted.trim().toLowerCase() !== "no") return true;
  // older responders and Exchange/Outlook
  if (h("x-autoreply") !== undefined || h("x-autorespond") !== undefined) return true;
  const precedence = (h("precedence") ?? "").trim().toLowerCase();
  if (["auto_reply", "auto-reply", "autoreply"].includes(precedence)) return true;
  const weak =
    (h("x-auto-response-suppress") ?? "").trim() !== "" || ["bulk", "junk"].includes(precedence);
  if (weak) return text === "" || !isStopMessage(subject, text);
  return /^\s*(?:(?:re|fw|fwd)\s*:\s*)*(?:automatic reply|auto[- ]?reply|autoreply|out of (?:the )?office\b(?!\s+hours))/i.test(
    subject,
  );
}
