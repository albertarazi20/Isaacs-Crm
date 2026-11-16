/**
 * Stable DOM ids for the Activity feed, so an answer's citation can scroll to the event it cites and light it up.
 * Browser-safe on purpose (no database imports): the feed and the ask box both import it. An event is identified by
 * what it came from (ref_type, ref_id) and when it happened; two rows that still collide get a counter, in feed
 * order, so the id of a row never depends on anything the viewer can change.
 */
export interface EventKey {
  ref_type: string;
  ref_id: string;
  at: string;
}

const stamp = (at: string): string => {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? at.replace(/[^0-9a-z]/gi, "") : String(ms);
};

/** The id for one event, before any collision counter: what a citation points at. */
export const eventDomId = (e: EventKey): string => `tl-${e.ref_type}-${e.ref_id}-${stamp(e.at)}`;

/** One id per event, in order: the first holder keeps the plain id, a later one gets `-2`, `-3`… */
export function eventDomIds(events: readonly EventKey[]): string[] {
  const seen = new Map<string, number>();
  return events.map((e) => {
    const base = eventDomId(e);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}
