import { Icon } from "./client/icons";

/** The small "reminder" marker on a merchant row: what the rep set, in their words. Shared by the lists and the follow-up panel. */
export function ReminderTag({ text }: { text: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-warn-soft px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-warn"
      title="Reminder"
    >
      <Icon name="bell" className="size-3" />
      <span className="sr-only">Reminder: </span>
      {text}
    </span>
  );
}
