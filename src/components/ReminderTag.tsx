/** The small "reminder" marker on a merchant row: what the rep set, in their words. Shared by the lists and the follow-up panel. */
export function ReminderTag({ text }: { text: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-[#ffd400] px-1.5 py-0.5 text-xs font-bold whitespace-nowrap text-black shadow-sm"
      title="Reminder"
    >
      <span aria-hidden>⏰</span>
      <span className="sr-only">Reminder: </span>
      {text}
    </span>
  );
}
