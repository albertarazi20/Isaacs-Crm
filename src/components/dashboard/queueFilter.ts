import type { QueueKind } from "@/lib/followup/overview";

/**
 * The reason filter that is really in force. The chosen reason can disappear after a refresh (the last reply was
 * answered): falling back to everything keeps the list from going blank with its filter chips hidden.
 */
export function effectiveKind(
  chosen: QueueKind | "all",
  present: ReadonlySet<QueueKind>,
): QueueKind | "all" {
  return chosen === "all" || present.has(chosen) ? chosen : "all";
}
