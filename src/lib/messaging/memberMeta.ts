import type { Db } from "../db";
import type { ReplyTag } from "../ai/classifyReply";

/**
 * What the Follow Up lead lines show beyond the bucket query: the merchant's latest reply tag (S1-6, table
 * reply_tags) and the date a pause lifts by itself (enrollments.resume_on, S1-2 / S1-6). One query for the whole
 * bucket; row security scopes it like every other read.
 */
export interface MemberMeta {
  tag: ReplyTag | null;
  /** The day a "not now" says to check back. */
  tag_revive_on: string | null;
  tag_at: string | null;
  /** The merchant's own words the tag rests on. */
  quote: string;
  supported: boolean;
  /** The day a pause lifts by itself; null = paused by hand, or not paused. */
  resume_on: string | null;
}

export async function loadMemberMeta(
  q: Db,
  clientIds: readonly string[],
): Promise<Record<string, MemberMeta>> {
  if (clientIds.length === 0) return {};
  const { rows } = await q.query<MemberMeta & { client_id: string }>(
    `select c.id as client_id, rt.tag, rt.revive_on::text as tag_revive_on,
            to_char(rt.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as tag_at,
            coalesce(rt.quote, '') as quote, coalesce(rt.supported, true) as supported, e.resume_on::text as resume_on
       from clients c
       left join lateral (select tag, revive_on, created_at, quote, supported from reply_tags
                           where client_id = c.id order by created_at desc limit 1) rt on true
       left join lateral (select resume_on from enrollments
                           where client_id = c.id and stopped_at is null order by entered_at desc limit 1) e on true
      where c.id = any($1::uuid[])`,
    [clientIds],
  );
  return Object.fromEntries(rows.map(({ client_id, ...meta }) => [client_id, meta]));
}
