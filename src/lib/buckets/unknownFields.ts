import type { Db } from "../db";
import type { MergeResult } from "../messaging/merge";

/**
 * A template saved with a typo ({frist_name}) renders with the literal text still in it. A person sees that in the
 * preview; an automated send has nobody looking, so it must never go: the caller skips or pauses the step and leaves
 * this note on the merchant's timeline.
 */

/** The names that are not merge fields in any of these renders, in order of first appearance. */
export function unknownFieldsOf(...results: MergeResult[]): string[] {
  const out: string[] = [];
  for (const r of results) for (const n of r.unknown) if (!out.includes(n)) out.push(n);
  return out;
}

export const describeUnknownFields = (names: readonly string[]): string =>
  names.map((n) => `{${n}}`).join(", ");

/** The timeline line for a template with fields that do not exist. */
export const unknownFieldsNote = (args: { what: string; names: readonly string[] }): string =>
  `${args.what} not sent: the template has ${describeUnknownFields(args.names)}, which is not a merge field (a typo?). Fix the template.`;

/**
 * The timeline line, written at most once a day per merchant and wording however many runs meet the same template.
 * A template broken again on a later day gets a new line: the note is a daily dedupe, not a forever one.
 */
export async function noteUnknownFields(
  q: Db,
  args: { userId: string; clientId: string; what: string; names: readonly string[] },
): Promise<void> {
  const body = unknownFieldsNote(args);
  await q.query(
    `insert into activities (user_id, client_id, kind, body)
     select $1, $2, 'system', $3
      where not exists (select 1 from activities a where a.client_id = $2 and a.kind = 'system' and a.body = $3
                          and a.occurred_at > now() - interval '1 day')`,
    [args.userId, args.clientId, body],
  );
}
